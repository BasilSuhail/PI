#!/usr/bin/env bash
# Jellyfin watchdog: a circuit breaker that disables non-admin users when the
# system is overloaded, and re-enables them after a cooldown.
#
# The admin's own account is never touched. When the board is under heavy
# load — too many concurrent streams, the CPU pegged by an accidental
# transcode, or memory running out — every other Jellyfin account is locked
# out for thirty minutes, the load drops, and the admin keeps watching.
#
# Runs on the board. Needs a Jellyfin API key: Dashboard > API Keys > +.
set -euo pipefail

STATE_DIR="/var/lib/jellyfin-watchdog"
CONF="/etc/jellyfin-watchdog.conf"
SCRIPT="/usr/local/lib/pi/jellyfin-watchdog"
SERVICE="jellyfin-watchdog"

# --- prerequisites ---

for cmd in curl jq; do
  if ! command -v "$cmd" >/dev/null; then
    echo "==> Installing $cmd"
    sudo apt-get install -y "$cmd"
  fi
done

# --- API key ---

if [ -f "$CONF" ]; then
  echo "==> Config exists at $CONF — keeping it"
  echo "  (delete it and re-run to change the key or thresholds)"
else
  cat <<'NOTE'

  The watchdog needs a Jellyfin API key to manage user accounts.

  In Jellyfin: Dashboard > API Keys > +
  Name it "watchdog" — the name is for you, not the script.

NOTE
  printf "  API key: "
  read -rs api_key
  echo

  if [ -z "$api_key" ]; then
    echo "  No key entered. Nothing installed." >&2
    exit 1
  fi

  sudo tee "$CONF" >/dev/null <<CONF
# Jellyfin watchdog. Written by deploy/install-watchdog.sh.
#
# Edit any value here — the timer picks up changes on the next tick.
API_KEY=$api_key

# Thresholds. Any ONE being exceeded triggers the lockout.
MAX_STREAMS=4        # total active playback sessions (admin included)
MAX_LOAD=3.5         # 1-minute load average (board has 4 cores)
MAX_MEM_PCT=90       # percent of total RAM in use
MAX_IOWAIT=50        # percent of CPU time spent waiting on disk I/O

# How long non-admin users stay locked out after a trigger.
COOLDOWN=900         # seconds (15 minutes)
CONF
  sudo chmod 600 "$CONF"
  echo "  saved to $CONF (root-only)"
fi

# --- state directory ---

sudo mkdir -p "$STATE_DIR"

# --- the script ---

sudo mkdir -p "$(dirname "$SCRIPT")"
sudo tee "$SCRIPT" >/dev/null <<'WATCHDOG'
#!/usr/bin/env bash
# Jellyfin watchdog. Runs every 60s via systemd timer.
#
# Four checks: active streams, CPU load, memory pressure, disk I/O. Any one
# exceeding its threshold disables every non-admin Jellyfin account for
# the cooldown period. The admin account is identified by
# Policy.IsAdministrator and is never touched.
#
# State lives in /var/lib/jellyfin-watchdog/:
#   disabled_at    — epoch when the lockout started
#   disabled_users — tab-separated id/name of users WE disabled
#
# Only users the watchdog disabled are re-enabled afterwards, so a user
# the admin disabled manually is left alone.
set -euo pipefail

CONF="/etc/jellyfin-watchdog.conf"
STATE_DIR="/var/lib/jellyfin-watchdog"
DISABLED_AT="$STATE_DIR/disabled_at"
DISABLED_USERS="$STATE_DIR/disabled_users"

[ -f "$CONF" ] || { echo "no config at $CONF"; exit 1; }
# shellcheck source=/dev/null
. "$CONF"

COOLDOWN="${COOLDOWN:-900}"
MAX_STREAMS="${MAX_STREAMS:-4}"
MAX_LOAD="${MAX_LOAD:-3.5}"
MAX_MEM_PCT="${MAX_MEM_PCT:-90}"
MAX_IOWAIT="${MAX_IOWAIT:-50}"

# Resolve Jellyfin's cluster IP. If k3s or the service is not up, exit
# quietly — there is nothing to protect and nothing to talk to.
JF_IP=$(k3s kubectl -n pi get svc jellyfin \
  -o jsonpath='{.spec.clusterIP}' 2>/dev/null) || exit 0
JF="http://${JF_IP}"

jf() { curl -sf -m 5 -H "X-Emby-Token: $API_KEY" "$@"; }

# ---- cooldown --------------------------------------------------------

if [ -f "$DISABLED_AT" ] && [ -s "$DISABLED_AT" ]; then
  now=$(date +%s)
  elapsed=$((now - $(cat "$DISABLED_AT")))

  if [ "$elapsed" -lt "$COOLDOWN" ]; then
    echo "cooldown: $(( (COOLDOWN - elapsed) / 60 ))m left"
    exit 0
  fi

  # Cooldown expired. Re-enable only the users we locked out.
  echo "cooldown expired — re-enabling users"
  if [ -f "$DISABLED_USERS" ]; then
    while IFS=$'\t' read -r uid name; do
      [ -z "$uid" ] && continue
      policy=$(jf "$JF/Users/$uid" 2>/dev/null | jq -c '.Policy' 2>/dev/null) || continue
      echo "$policy" | jq -c '.IsDisabled = false' |
        jf -X POST -H "Content-Type: application/json" \
          -d @- "$JF/Users/$uid/Policy" >/dev/null 2>&1 || true
      echo "  enabled ${name:-$uid}"
    done < "$DISABLED_USERS"
  fi

  rm -f "$DISABLED_AT" "$DISABLED_USERS"
  echo "done"
  exit 0
fi

# ---- load check ------------------------------------------------------

# First /proc/stat sample — taken before the API call so the network
# round-trip acts as the measurement window instead of a sleep.
read -r _ u1 n1 s1 i1 w1 _ < /proc/stat

streams=$(jf "$JF/Sessions" 2>/dev/null \
  | jq '[.[] | select(.NowPlayingItem != null)] | length' 2>/dev/null) || streams=0
load=$(awk '{print $1}' /proc/loadavg)
mem_pct=$(awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{printf "%.0f", (1-a/t)*100}' /proc/meminfo)

# Second sample. The delta between the two gives iowait as a percentage
# of total CPU time — high values mean the HDD is the bottleneck.
read -r _ u2 n2 s2 i2 w2 _ < /proc/stat
d_total=$(( (u2-u1) + (n2-n1) + (s2-s1) + (i2-i1) + (w2-w1) ))
if [ "$d_total" -gt 0 ]; then
  iowait=$(( (w2-w1) * 100 / d_total ))
else
  iowait=0
fi

overloaded=false
reason=""

if [ "$streams" -gt "$MAX_STREAMS" ]; then
  overloaded=true
  reason="streams=$streams"
fi

if awk "BEGIN{exit !($load > $MAX_LOAD)}" 2>/dev/null; then
  overloaded=true
  reason="${reason:+$reason, }load=$load"
fi

if [ "$mem_pct" -gt "$MAX_MEM_PCT" ]; then
  overloaded=true
  reason="${reason:+$reason, }mem=${mem_pct}%"
fi

if [ "$iowait" -gt "$MAX_IOWAIT" ]; then
  overloaded=true
  reason="${reason:+$reason, }iowait=${iowait}%"
fi

if [ "$overloaded" = false ]; then
  echo "ok: streams=$streams load=$load mem=${mem_pct}% iowait=${iowait}%"
  exit 0
fi

# ---- disable non-admin users -----------------------------------------

echo "OVERLOADED: $reason"

users_json=$(jf "$JF/Users") || { echo "cannot list users"; exit 0; }

# Non-admin users who are not already disabled (an admin might have
# disabled one manually — leave those alone).
targets=$(echo "$users_json" | jq -r \
  '.[] | select(.Policy.IsAdministrator != true and .Policy.IsDisabled != true)
       | [.Id, .Name] | @tsv')

if [ -z "$targets" ]; then
  echo "no users to disable"
  exit 0
fi

> "$DISABLED_USERS"
while IFS=$'\t' read -r uid name; do
  [ -z "$uid" ] && continue
  policy=$(echo "$users_json" | jq -c --arg id "$uid" \
    '.[] | select(.Id == $id) | .Policy')
  echo "$policy" | jq -c '.IsDisabled = true' |
    jf -X POST -H "Content-Type: application/json" \
      -d @- "$JF/Users/$uid/Policy" >/dev/null 2>&1
  printf '%s\t%s\n' "$uid" "$name" >> "$DISABLED_USERS"
  echo "  disabled $name"
done <<< "$targets"

date +%s > "$DISABLED_AT"
echo "$(wc -l < "$DISABLED_USERS" | tr -d ' ') user(s) locked out for $((COOLDOWN / 60))m"
WATCHDOG
sudo chmod 755 "$SCRIPT"

# --- systemd ---

sudo tee /etc/systemd/system/${SERVICE}.service >/dev/null <<SERVICE
[Unit]
Description=Jellyfin watchdog — disable non-admin users under load
After=k3s.service

[Service]
Type=oneshot
ExecStart=$SCRIPT
SERVICE

sudo tee /etc/systemd/system/${SERVICE}.timer >/dev/null <<TIMER
[Unit]
Description=Jellyfin watchdog timer

[Timer]
OnBootSec=120
OnUnitActiveSec=60

[Install]
WantedBy=timers.target
TIMER

sudo systemctl daemon-reload
sudo systemctl enable --now ${SERVICE}.timer

# Source the config for the summary, since it was written by an earlier
# block and the variables are not in this shell.
# shellcheck source=/dev/null
. "$CONF"

echo
echo "==> Done"
echo "  config     $CONF"
echo "  script     $SCRIPT"
echo "  timer      ${SERVICE}.timer (every 60s, starting 2m after boot)"
echo "  state      $STATE_DIR"
echo
echo "  Thresholds (any one triggers the lockout):"
echo "    streams  > ${MAX_STREAMS:-4}"
echo "    load     > ${MAX_LOAD:-3.5}"
echo "    memory   > ${MAX_MEM_PCT:-90}%"
echo "    iowait   > ${MAX_IOWAIT:-50}%"
echo "  Cooldown   $((${COOLDOWN:-1800} / 60)) minutes"
echo
echo "  Logs:   journalctl -u $SERVICE --no-pager -n 20"
echo "  Test:   sudo $SCRIPT"
echo "  Tune:   edit $CONF — changes take effect on the next tick"
