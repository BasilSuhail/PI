#!/usr/bin/env bash
# Quiet hours: rest mode for the k3s board between midnight and 6 AM.
#
# Installs two systemd timers. At midnight, background workers that grind
# through the spinning disk — ML indexing, library scans — are scaled to
# zero. The services themselves stay up: you can still watch a film, browse
# photos, or back up from the phone. At six, the workers come back and the
# queue drains.
#
# System maintenance timers (apt, man-db, fstrim) are rescheduled to run
# during the day so they cannot trigger disk activity at 3 AM.
#
# Nothing here touches the disk directly. No hdparm, no spindown. If you
# are awake and using the HDD, it keeps running. The point is to stop the
# automatic background noise, not to force anything offline.
set -euo pipefail

SCRIPT=/usr/local/lib/pi/quiet-hours

echo "==> Installing $SCRIPT"
sudo mkdir -p "$(dirname "$SCRIPT")"
sudo tee "$SCRIPT" >/dev/null <<'BODY'
#!/usr/bin/env bash
# Called by pi-quiet-start.timer (midnight) and pi-quiet-end.timer (06:00).
# Takes one argument: "start" to enter quiet hours, "end" to leave them.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

ACTION="${1:-}"
case "$ACTION" in
  start|end) ;;
  *) echo "usage: quiet-hours start|end" >&2; exit 2 ;;
esac

log() { echo "[quiet-hours] $*"; }

if ! systemctl is-active --quiet k3s 2>/dev/null; then
  log "k3s is not running — nothing to do"
  exit 0
fi

kube() { sudo k3s kubectl "$@"; }

# Background workers that churn through the HDD automatically. Each one is
# scaled to zero at midnight and restored at six. The services they support
# (Jellyfin, Immich) stay up — you can still use them, the disk just is not
# being walked by a batch job.
#
#   immich-machine-learning   CLIP embeddings and face detection. Reads every
#                             photo off the 6TB, one by one, for hours.
QUIET_DEPLOYMENTS="immich-machine-learning"

if [ "$ACTION" = start ]; then
  for dep in $QUIET_DEPLOYMENTS; do
    current=$(kube -n pi get deployment "$dep" \
      -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 0)
    if [ "$current" != "0" ]; then
      kube -n pi annotate deployment/"$dep" \
        quiet-hours/was-replicas="$current" --overwrite >/dev/null 2>&1
      kube -n pi scale deployment/"$dep" --replicas=0 >/dev/null
      log "scaled $dep 0 (was $current)"
    fi
  done
else
  for dep in $QUIET_DEPLOYMENTS; do
    was=$(kube -n pi get deployment "$dep" \
      -o jsonpath='{.metadata.annotations.quiet-hours/was-replicas}' \
      2>/dev/null || echo 1)
    [ -n "$was" ] || was=1
    kube -n pi scale deployment/"$dep" --replicas="$was" >/dev/null
    kube -n pi annotate deployment/"$dep" quiet-hours/was-replicas- \
      >/dev/null 2>&1 || true
    log "scaled $dep $was"
  done
fi
BODY
sudo chmod 0755 "$SCRIPT"

# --- systemd units --------------------------------------------------------
echo "==> Installing timers"

sudo tee /etc/systemd/system/pi-quiet-start.service >/dev/null <<EOF
[Unit]
Description=Quiet hours — background workers down

[Service]
Type=oneshot
ExecStart=$SCRIPT start
EOF

sudo tee /etc/systemd/system/pi-quiet-end.service >/dev/null <<EOF
[Unit]
Description=Quiet hours — background workers back

[Service]
Type=oneshot
ExecStart=$SCRIPT end
EOF

sudo tee /etc/systemd/system/pi-quiet-start.timer >/dev/null <<'EOF'
[Unit]
Description=Start quiet hours at midnight

[Timer]
OnCalendar=*-*-* 00:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo tee /etc/systemd/system/pi-quiet-end.timer >/dev/null <<'EOF'
[Unit]
Description=End quiet hours at 6 AM

[Timer]
OnCalendar=*-*-* 06:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now pi-quiet-start.timer pi-quiet-end.timer

# --- Reschedule noisy system timers ---------------------------------------
# apt, man-db and fstrim all default to times that can land in the middle of
# the night. Drop-in overrides pin them to daytime without touching the
# packaged unit files, so an apt upgrade does not undo the change.
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

echo
echo "==> Quiet hours installed (rest mode, not shutdown)"
echo "  midnight  background workers scale to zero (ML indexing stops)"
echo "  06:00     workers come back, queued jobs drain"
echo
echo "  Still up all night: Jellyfin, Immich, Vaultwarden, the console"
echo "  The HDD stays accessible — only automatic grinding stops"
echo
echo "  Test now:    sudo $SCRIPT start    (then: sudo $SCRIPT end)"
echo "  Next fire:   systemctl list-timers pi-quiet-*"
echo "  Logs:        journalctl -u pi-quiet-start -u pi-quiet-end --since today"
echo
echo "  Jellyfin's library scan is configured inside Jellyfin, not here."
echo "  Open Dashboard > Scheduled Tasks and set 'Scan Media Library' to"
echo "  run at 07:00 instead of overnight."
