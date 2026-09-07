#!/usr/bin/env bash
# Quiet hours: keep the boards silent between midnight and 6 AM.
#
# Installs two systemd timers. At midnight, workloads that touch the spinning
# disk are scaled to zero and the disk is put to standby. At six, everything
# comes back. System maintenance timers (apt, man-db, fstrim) are rescheduled
# to run during the day so they cannot wake a sleeping disk at 3 AM.
#
# Runs on the k3s board. Scales Deployments that touch the spinning disk, then
# tells the disk to sleep once there is nothing left to read from it.
set -euo pipefail

SCRIPT=/usr/local/lib/pi/quiet-hours

# hdparm is what tells a spinning disk to sleep. Most images ship it; make
# sure, because a missing binary means a disk that grinds all night with the
# workloads already gone.
if ! command -v hdparm &>/dev/null; then
  echo "==> Installing hdparm"
  sudo apt-get update -qq && sudo apt-get install -y -qq hdparm \
    || echo "  could not install hdparm — disks will not be spun down" >&2
fi

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

# --- k3s workloads --------------------------------------------------------
# Scale down deployments whose pods read from the spinning disk. The list is
# deliberately short: every entry is a service that goes dark for six hours.
if systemctl is-active --quiet k3s 2>/dev/null; then
  kube() { sudo k3s kubectl "$@"; }
  QUIET_DEPLOYMENTS="jellyfin"

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
fi

# --- Spinning disks -------------------------------------------------------
# Put every rotational disk to standby once the workloads are down. The disk
# wakes on its own the moment something reads from it, which after 6 AM is
# fine — the whole point is the six hours where nothing does.
if [ "$ACTION" = start ]; then
  for disk in /dev/sd?; do
    [ -b "$disk" ] || continue
    bn=$(basename "$disk")
    rotational=$(cat "/sys/block/$bn/queue/rotational" 2>/dev/null || echo 0)
    if [ "$rotational" = "1" ]; then
      sudo hdparm -y "$disk" >/dev/null 2>&1 && log "standby $disk" || true
    fi
  done
fi
BODY
sudo chmod 0755 "$SCRIPT"

# --- systemd units --------------------------------------------------------
echo "==> Installing timers"

sudo tee /etc/systemd/system/pi-quiet-start.service >/dev/null <<EOF
[Unit]
Description=Quiet hours — scale down and spin down

[Service]
Type=oneshot
ExecStart=$SCRIPT start
EOF

sudo tee /etc/systemd/system/pi-quiet-end.service >/dev/null <<EOF
[Unit]
Description=Quiet hours — bring everything back

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
echo "==> Quiet hours installed"
echo "  midnight  workloads scale to zero, disks go to standby"
echo "  06:00     everything comes back"
echo
echo "  Test now:    sudo $SCRIPT start    (then: sudo $SCRIPT end)"
echo "  Next fire:   systemctl list-timers pi-quiet-*"
echo "  Logs:        journalctl -u pi-quiet-start -u pi-quiet-end --since today"
echo
echo "  To remove:   sudo systemctl disable --now pi-quiet-start.timer pi-quiet-end.timer"
echo "               sudo rm $SCRIPT /etc/systemd/system/pi-quiet-*"
