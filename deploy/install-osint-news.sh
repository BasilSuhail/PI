#!/usr/bin/env bash
# News from the OSINT board into Discord (#127). Runs on the board.
#
# Installs stopped, in the sense that matters: the relay runs on schedule from
# the first minute, but in dry run. It reads the board, builds the exact
# message, and writes it to its own log instead of posting.
#
# That is not caution for its own sake. How often a story earns the console's
# pinned slot has never been measured, so arming this on install would be
# guessing at how often your phone buzzes. Leave it a day or two, read the
# logs, then:
#
#     make news-arm
#
# Re-running this script is safe. It asks for anything it does not already
# have, keeps what it does, and leaves the dry-run setting alone once set.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NS=jug
SECRET=osint-news
SETTINGS=osint-news-settings
RELAY_CM=osint-news-relay

OWNER="${OWNER:-$(id -un)}"
OWNER_UID="$(id -u "$OWNER")"
OWNER_GID="$(id -g "$OWNER")"

# Same layout as every other app on this board. See deploy/install-media.sh.
if [ -z "${APPS_DIR:-}" ]; then
  for candidate in "/1) Archive" /srv/archive; do
    [ -d "$candidate" ] && { APPS_DIR="$candidate/Apps"; break; }
  done
fi
APPS_DIR="${APPS_DIR:-/1) Archive/Apps}"

if ! sudo systemctl is-active --quiet k3s; then
  echo "k3s is not running on this board. This installs into the cluster." >&2
  exit 1
fi

kube() { sudo k3s kubectl "$@"; }

kube get namespace "$NS" >/dev/null 2>&1 || {
  echo "The '$NS' namespace does not exist — run 'make dashboard-k8s' first." >&2
  exit 1
}

echo "==> Where the state file goes"
printf '  %s\n' "$APPS_DIR/OsintNews"
sudo mkdir -p "$APPS_DIR/OsintNews"
sudo chown "$OWNER_UID:$OWNER_GID" "$APPS_DIR/OsintNews"
echo

# ---------------------------------------------------------------------------
# Credentials and addresses. Asked for once, stored in a Secret, never written
# to this repository — the same handling the Tailscale OAuth client already
# gets in deploy/install-uptime-kuma.sh, for the same reason.
# ---------------------------------------------------------------------------
if kube -n "$NS" get secret "$SECRET" >/dev/null 2>&1; then
  echo "==> Board and webhook already stored — leaving them alone"
  echo "  (replace with: sudo k3s kubectl -n ${NS} delete secret ${SECRET}, then re-run)"
  BOARD_URL="$(kube -n "$NS" get secret "$SECRET" -o jsonpath='{.data.OSINT_BASE_URL}' | base64 -d)"
else
  cat <<'NOTE'
==> Three answers, asked once

  1. The OSINT console's address, as you open it — the https:// tailnet name,
     no path and no port. The relay reads /api/... under it, which is the same
     proxy the browser uses.

  2. A Discord webhook URL. In Discord: pick or make a channel, then the gear
     beside it, Integrations, Webhooks, New Webhook, Copy Webhook URL. Leave
     this blank to install without one — it stays in dry run until you re-run
     this with a webhook.

  3. The board's API token, if API_AUTH_TOKEN is set in the board's .env.
     Blank if it is not: OSINT treats an absent token as an open API, so a
     board without one needs nothing here.

  None of these is echoed, and none is written to this repository.

NOTE
  # Prompts printed separately rather than passed to read -p: a prompt string
  # sitting next to a variable reads as a hardcoded credential to a scanner.
  printf '  Console address: '
  IFS= read -r BOARD_URL
  printf '  Discord webhook URL (optional): '
  IFS= read -rs WEBHOOK
  echo
  printf '  API token (optional): '
  IFS= read -rs API_TOKEN
  echo

  [ -n "$BOARD_URL" ] || { echo "  The console address is needed — stopping." >&2; exit 1; }
  case "$BOARD_URL" in
    https://*) ;;
    *) echo "  That is not an https:// address — stopping." >&2; exit 1 ;;
  esac

  kube -n "$NS" create secret generic "$SECRET" \
    --from-literal="OSINT_BASE_URL=${BOARD_URL%/}" \
    --from-literal="DISCORD_WEBHOOK_URL=${WEBHOOK}" \
    --from-literal="OSINT_API_TOKEN=${API_TOKEN}" >/dev/null
  unset WEBHOOK API_TOKEN
  echo "  stored"
fi
echo

# The address the pod routes to, and the name its certificate is issued to.
# Split apart because the pod needs both and for different reasons: see the
# hostAliases note in k8s/osint-news.yaml.
BOARD_HOST="${BOARD_URL#https://}"
BOARD_HOST="${BOARD_HOST%%/*}"
BOARD_IP="${BOARD_IP:-$(getent hosts "$BOARD_HOST" 2>/dev/null | awk 'NR==1{print $1}')}"
if [ -z "$BOARD_IP" ]; then
  echo "Could not resolve $BOARD_HOST from this board." >&2
  echo "Is Tailscale up? Or pass it: BOARD_IP=<address> bash deploy/install-osint-news.sh" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# The relay itself, and the one setting that is not a credential.
# ---------------------------------------------------------------------------
echo "==> Relay"
kube -n "$NS" create configmap "$RELAY_CM" \
  --from-file="relay.py=${REPO_ROOT}/news/relay.py" \
  --dry-run=client -o yaml | kube apply -f - >/dev/null

# Created only if absent, so re-running the installer never silently disarms a
# relay that has been armed.
if kube -n "$NS" get configmap "$SETTINGS" >/dev/null 2>&1; then
  MODE="$(kube -n "$NS" get configmap "$SETTINGS" -o jsonpath='{.data.DRY_RUN}')"
  echo "  mode kept as it was: DRY_RUN=${MODE}"
else
  kube -n "$NS" create configmap "$SETTINGS" --from-literal=DRY_RUN=true >/dev/null
  MODE=true
  echo "  installed in dry run"
fi

sed -e "s|__APPS_DIR__|${APPS_DIR}|g" \
    -e "s|__BOARD_IP__|${BOARD_IP}|g" \
    -e "s|__BOARD_HOST__|${BOARD_HOST}|g" \
    -e "s|__UID__|${OWNER_UID}|g" \
    -e "s|__GID__|${OWNER_GID}|g" \
    "${REPO_ROOT}/k8s/osint-news.yaml" | kube apply -f -

echo
echo "==> One run now, so you can see it work"
# Named for the minute, because two runs on the same day otherwise collide.
PROBE="osint-news-probe-$(date +%H%M%S)"
kube -n "$NS" create job "$PROBE" --from=cronjob/osint-news >/dev/null
kube -n "$NS" wait --for=condition=complete "job/$PROBE" --timeout=120s >/dev/null 2>&1 || {
  echo "  It did not finish cleanly. What it said:" >&2
  kube -n "$NS" logs "job/$PROBE" --tail=40 2>&1 | sed 's/^/    /' >&2
  echo >&2
  echo "  The schedule is installed regardless — fix and re-run, or watch:" >&2
  echo "    sudo k3s kubectl -n $NS logs -l app=osint-news --tail=50" >&2
  exit 1
}
kube -n "$NS" logs "job/$PROBE" 2>&1 | sed 's/^/  /'
kube -n "$NS" delete job "$PROBE" >/dev/null 2>&1 || true

cat <<NEXT

Installed. It runs at 12 and 42 past the hour, five minutes after the board
finishes clustering the news window.

Mode is DRY_RUN=${MODE}. While that is true it reads the board and prints the
message it would have sent, and nothing reaches Discord.

  make news-logs    what the last runs said
  make news-arm     start posting for real
  make news-dry     stop posting, go back to the log

One thing worth knowing before you arm it. Dry run records what it has already
seen, exactly as the armed relay does, because a run that did not record would
print the same three stories every half hour and tell you nothing about how
often new ones arrive. So arming it will not replay the stories from the dry
run. Those are not new any more, and the first real message is the first story
that pins after you arm it. On a quiet day that can be hours.

Rollback:  sudo k3s kubectl -n $NS delete -f -  < the rendered manifest, or
           sudo k3s kubectl -n $NS delete cronjob osint-news
           The state file and the Secret survive that, so a reinstall does not
           re-announce a month of stories.
NEXT
