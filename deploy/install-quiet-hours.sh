#!/usr/bin/env bash
# Quiet hours: reschedule system maintenance out of midnight–6 AM, and take
# Immich's server and ML worker down for those hours.
#
# The apps have their own scheduling (Jellyfin's Scheduled Tasks, Immich's
# job settings) and those are configured in their own dashboards. This
# script handles the OS-level timers that the apps cannot see: apt updates,
# man-db rebuilds, and fstrim. All three default to times that regularly
# land in the middle of the night.
#
# Drop-in overrides rather than editing the packaged unit files, so an apt
# upgrade does not undo the change.
set -euo pipefail

echo "==> Rescheduling system maintenance to daytime"

for timer in apt-daily apt-daily-upgrade; do
  if systemctl list-unit-files "${timer}.timer" --no-pager --no-legend \
     2>/dev/null | grep -q .; then
    override="/etc/systemd/system/${timer}.timer.d"
    sudo mkdir -p "$override"
    sudo tee "$override/quiet-hours.conf" >/dev/null <<TIMERCONF
# Managed by deploy/install-quiet-hours.sh. Keep maintenance out of midnight–6 AM.
[Timer]
OnCalendar=
OnCalendar=*-*-* 07:00:00
RandomizedDelaySec=2h
TIMERCONF
    echo "  $timer → 07:00 ± 2h"
  fi
done

if systemctl list-unit-files man-db.timer --no-pager --no-legend \
   2>/dev/null | grep -q .; then
  override="/etc/systemd/system/man-db.timer.d"
  sudo mkdir -p "$override"
  sudo tee "$override/quiet-hours.conf" >/dev/null <<'TIMERCONF'
[Timer]
OnCalendar=
OnCalendar=Sun *-*-* 10:00:00
RandomizedDelaySec=2h
TIMERCONF
  echo "  man-db → Sunday 10:00 ± 2h"
fi

if systemctl list-unit-files fstrim.timer --no-pager --no-legend \
   2>/dev/null | grep -q .; then
  override="/etc/systemd/system/fstrim.timer.d"
  sudo mkdir -p "$override"
  sudo tee "$override/quiet-hours.conf" >/dev/null <<'TIMERCONF'
[Timer]
OnCalendar=
OnCalendar=Mon *-*-* 08:00:00
TIMERCONF
  echo "  fstrim → Monday 08:00"
fi

sudo systemctl daemon-reload

# Clean up the old version's systemd units if they exist.
if systemctl list-unit-files pi-quiet-start.timer --no-pager --no-legend \
   2>/dev/null | grep -q .; then
  echo "==> Removing old quiet-hours timers"
  sudo systemctl disable --now pi-quiet-start.timer pi-quiet-end.timer 2>/dev/null || true
  sudo rm -f /etc/systemd/system/pi-quiet-start.service \
             /etc/systemd/system/pi-quiet-start.timer \
             /etc/systemd/system/pi-quiet-end.service \
             /etc/systemd/system/pi-quiet-end.timer
  sudo rm -f /usr/local/lib/pi/quiet-hours
  sudo systemctl daemon-reload
fi

# Immich off overnight. Its server and ML worker read and write the 6TB
# (thumbnails, transcodes, indexing), and a backfill can run for hours.
# Postgres and Valkey stay up: they hold the job queue, so the work resumes
# where it stopped at six.
immich_quiet=false
if sudo k3s kubectl -n pi get deploy immich-server >/dev/null 2>&1; then
  echo "==> Immich off 00:00–06:00"
  sudo mkdir -p /usr/local/lib/pi
  sudo tee /usr/local/lib/pi/immich-quiet >/dev/null <<'SCRIPT'
#!/usr/bin/env bash
# Managed by deploy/install-quiet-hours.sh.
# Decides from the clock rather than from which timer fired, so a board that
# was powered off at midnight or at six still lands in the right state on boot.
set -euo pipefail
QUIET_START=0
QUIET_END=6
hour=$(date +%-H)
if [ "$hour" -ge "$QUIET_START" ] && [ "$hour" -lt "$QUIET_END" ]; then
  replicas=0
else
  replicas=1
fi
# k3s can take a minute to answer after boot.
for _ in 1 2 3 4 5 6; do
  k3s kubectl -n pi scale deploy immich-server immich-machine-learning \
    --replicas="$replicas" && exit 0
  sleep 20
done
exit 1
SCRIPT
  sudo chmod 755 /usr/local/lib/pi/immich-quiet

  sudo tee /etc/systemd/system/immich-quiet.service >/dev/null <<'UNIT'
[Unit]
Description=Immich off midnight–6 AM
After=k3s.service

[Service]
Type=oneshot
ExecStart=/usr/local/lib/pi/immich-quiet
UNIT

  sudo tee /etc/systemd/system/immich-quiet.timer >/dev/null <<'UNIT'
[Unit]
Description=Immich off midnight–6 AM

[Timer]
OnCalendar=*-*-* 00:00:00
OnCalendar=*-*-* 06:00:00
OnBootSec=3min

[Install]
WantedBy=timers.target
UNIT

  sudo systemctl daemon-reload
  sudo systemctl enable --now immich-quiet.timer
  sudo systemctl start immich-quiet.service
  immich_quiet=true
fi

echo
echo "==> Done"
echo "  apt-daily            07:00 ± 2h"
echo "  apt-daily-upgrade    07:00 ± 2h"
echo "  man-db               Sunday 10:00 ± 2h"
echo "  fstrim               Monday 08:00"
if [ "$immich_quiet" = true ]; then
  echo "  immich               off 00:00–06:00 (server + ML; postgres stays up)"
fi
echo
echo "  The heavy app jobs (library scans, ML indexing) are configured"
echo "  inside each app's own dashboard, not here:"
echo "    Jellyfin   Dashboard > Scheduled Tasks > Scan Media Library"
echo "    Immich     Administration > Settings > Job Settings"
