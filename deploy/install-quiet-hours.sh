#!/usr/bin/env bash
# Quiet hours: reschedule system maintenance out of midnight–6 AM.
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

echo
echo "==> Done"
echo "  apt-daily            07:00 ± 2h"
echo "  apt-daily-upgrade    07:00 ± 2h"
echo "  man-db               Sunday 10:00 ± 2h"
echo "  fstrim               Monday 08:00"
echo
echo "  The heavy app jobs (library scans, ML indexing) are configured"
echo "  inside each app's own dashboard, not here:"
echo "    Jellyfin   Dashboard > Scheduled Tasks > Scan Media Library"
echo "    Immich     Administration > Settings > Job Settings"
