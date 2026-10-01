#!/usr/bin/env bash
# Quiet hours: reschedule system maintenance out of midnight–6 AM, pause
# Immich's background jobs for those hours (the app stays up), and slow
# seeding so it does not keep HDD1 reading all night. Downloads stay at full
# speed.
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

# Immich quiet overnight: no background jobs (thumbnails, transcodes, ML
# indexing, library scans, database dumps) and no phone uploads. The app itself
# stays up for browsing, and the queued work resumes at six. This goes through
# the API, so it needs a key; without one this part is skipped.
immich_quiet=false
if sudo k3s kubectl -n pi get deploy immich-server >/dev/null 2>&1; then
  if ! sudo test -s /etc/immich-api.key; then
    echo "==> Immich: no API key at /etc/immich-api.key — overnight pause skipped"
    echo "    Create one in Immich (Settings > API Keys), then:"
    echo "    sudo bash -c 'read -rsp \"key: \" k && echo \"\$k\" > /etc/immich-api.key && chmod 600 /etc/immich-api.key'"
  else
    echo "==> Immich jobs and uploads paused 00:00–06:00"
    sudo mkdir -p /usr/local/lib/pi
    sudo tee /usr/local/lib/pi/immich-quiet >/dev/null <<'SCRIPT'
#!/usr/bin/env bash
# Managed by deploy/install-quiet-hours.sh.
# Pauses Immich's job queues and blocks uploads midnight–6 AM, and undoes
# both after. The app stays up for browsing. With no argument it decides from
# the clock, so a board that was off at midnight or six still lands in the
# right state; pass pause or resume to force one.
set -euo pipefail
QUIET_START=0
QUIET_END=6
KEY_FILE="${IMMICH_KEY_FILE:-/etc/immich-api.key}"
STATE="${IMMICH_QUIET_STATE:-/var/lib/immich-quiet/quotas.json}"

action="${1:-}"
if [ -z "$action" ]; then
  hour=$(date +%-H)
  if [ "$hour" -ge "$QUIET_START" ] && [ "$hour" -lt "$QUIET_END" ]; then
    action=pause
  else
    action=resume
  fi
fi
[ "$action" = pause ] && want=true || want=false

ip=$(k3s kubectl -n pi get svc immich -o jsonpath='{.spec.clusterIP}')
key=$(cat "$KEY_FILE")
api() { curl -sf -m 10 -H "x-api-key: $key" -H "Content-Type: application/json" "$@"; }
failed=0

# Uploads: each quota drops to what the user already stores, so any new upload
# is refused while browsing still works. The real quotas are saved only when no
# saved copy exists — a retry in the night must never save the lowered values
# over them, or they would come back at six as the new limits.
users=$(api "http://$ip/api/admin/users") || { echo "immich did not list its users"; exit 1; }
if [ "$action" = pause ]; then
  if [ ! -s "$STATE" ]; then
    mkdir -p "$(dirname "$STATE")"
    jq '[.[] | {id, quotaSizeInBytes}]' <<<"$users" > "$STATE.tmp"
    mv "$STATE.tmp" "$STATE"
  fi
  targets=$(jq -c '.[] | {id, q: (.quotaUsageInBytes // 0)}' <<<"$users")
elif [ -s "$STATE" ]; then
  targets=$(jq -c '.[] | {id, q: .quotaSizeInBytes}' "$STATE")
else
  targets=""
fi
while IFS= read -r t; do
  [ -n "$t" ] || continue
  id=$(jq -r .id <<<"$t")
  q=$(jq -c .q <<<"$t")
  got=$(api -X PUT -d "{\"quotaSizeInBytes\":$q}" "http://$ip/api/admin/users/$id" \
    | jq -c .quotaSizeInBytes) || got=error
  [ "$got" = "$q" ] || { echo "  user $id: expected quota $q, got $got"; failed=1; }
done <<<"$targets"
if [ "$action" = resume ] && [ "$failed" = 0 ]; then
  rm -f "$STATE"
fi

# Background jobs.
queues=$(api "http://$ip/api/jobs" | jq -r 'keys[]') || queues=""
[ -n "$queues" ] || { echo "immich did not list its job queues"; exit 1; }
for q in $queues; do
  got=$(api -X PUT -d "{\"command\":\"$action\",\"force\":false}" \
    "http://$ip/api/jobs/$q" | jq -r '.queueStatus.isPaused') || got=error
  [ "$got" = "$want" ] || { echo "  $q: expected isPaused=$want, got $got"; failed=1; }
done

echo "immich uploads and job queues: $action"
exit "$failed"
SCRIPT
    sudo chmod 755 /usr/local/lib/pi/immich-quiet

    # Restart=on-failure retries every five minutes while Immich is
    # unreachable; each retry re-reads the clock, so a pause that could not
    # land before six becomes a resume instead.
    sudo tee /etc/systemd/system/immich-quiet.service >/dev/null <<'UNIT'
[Unit]
Description=Pause Immich background jobs midnight–6 AM
After=k3s.service
StartLimitIntervalSec=0

[Service]
Type=oneshot
ExecStart=/usr/local/lib/pi/immich-quiet
Restart=on-failure
RestartSec=5min
UNIT

    sudo tee /etc/systemd/system/immich-quiet.timer >/dev/null <<'UNIT'
[Unit]
Description=Pause Immich background jobs midnight–6 AM

[Timer]
OnCalendar=*-*-* 00:00:00
OnCalendar=*-*-* 06:00:00
OnBootSec=3min

[Install]
WantedBy=timers.target
UNIT

    sudo systemctl daemon-reload
    sudo systemctl enable --now immich-quiet.timer
    sudo systemctl start immich-quiet.service || true
    immich_quiet=true
  fi
fi


# Seeding slowed to 100 KiB/s overnight by qBittorrent's own scheduler: it
# otherwise reads HDD1 all night. Downloads are not limited (alt_dl_limit 0 is
# "no limit"): something wanted tonight should arrive tonight.
#
# Not lower. A download sends too — a request for every 16 KiB block, plus
# the protocol's own messages — and that counts against the upload limit. At
# 1 KiB/s it could not ask for pieces fast enough and downloads stalled. At
# 10 MB/s in, requests are roughly 11 KB/s out; 100 KiB/s leaves room for
# that with seeding still a trickle.
#
# The schedule lives in qBittorrent's config, so it keeps working even if
# this board's timers do not, and it only has to be set once, while the
# client is running.
#
# Called from the board to the Service's cluster IP. That traffic leaves
# through the CNI bridge, so it arrives from the cluster network the WebUI's
# AuthSubnetWhitelist lets in without a login. Two routes that do not work:
# localhost inside the pod is not on that list (403), and a cluster DNS name
# does not resolve in the pod because gluetun owns its DNS.
torrent_quiet="no qBittorrent installed"
if sudo k3s kubectl -n pi get deploy qbittorrent >/dev/null 2>&1; then
  echo "==> Seeding slowed to 100 KiB/s 00:00–06:00, downloads full speed"
  QB_PREFS='{"alt_dl_limit":0,"alt_up_limit":102400,"scheduler_enabled":true,"schedule_from_hour":0,"schedule_from_min":0,"schedule_to_hour":6,"schedule_to_min":0,"scheduler_days":0}'
  QIP=$(sudo k3s kubectl -n pi get svc qbittorrent -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)
  qb() { curl -sf -m 10 "$@"; }
  qb -X POST "http://$QIP/api/v2/app/setPreferences" \
     --data-urlencode "json=$QB_PREFS" >/dev/null 2>&1 || true
  got=$(qb "http://$QIP/api/v2/app/preferences" 2>/dev/null \
        | jq -r '"\(.scheduler_enabled) \(.schedule_from_hour) \(.schedule_to_hour) \(.alt_dl_limit) \(.alt_up_limit)"' 2>/dev/null || true)
  if [ "$got" = "true 0 6 0 102400" ]; then
    torrent_quiet="set (qBittorrent scheduler)"
  else
    torrent_quiet="NOT set: qBittorrent's API did not accept it (is the torrent stack on?). Re-run 'make quiet' while it is running"
  fi
fi

echo
echo "==> Done"
echo "  apt-daily            07:00 ± 2h"
echo "  apt-daily-upgrade    07:00 ± 2h"
echo "  man-db               Sunday 10:00 ± 2h"
echo "  fstrim               Monday 08:00"
echo "  torrents             seeding 100 KiB/s 00:00–06:00, downloads full speed, $torrent_quiet"
if [ "$immich_quiet" = true ]; then
  echo "  immich               jobs + uploads paused 00:00–06:00 (app stays up)"
fi
echo
echo "  The heavy app jobs (library scans, ML indexing) are configured"
echo "  inside each app's own dashboard, not here:"
echo "    Jellyfin   Dashboard > Scheduled Tasks > Scan Media Library"
echo "    Immich     Administration > Settings > Job Settings"
