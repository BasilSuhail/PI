#!/usr/bin/env bash
# Nextcloud in k3s, on its own tailnet name. Runs on the board. Safe to re-run.
#
# Needs the Tailscale operator (make uptime) and the disk pool (make pool).
#
#   APPS_DIR   the SSD: Nextcloud's code, config and Postgres.
#   POOL_DIR   the mergerfs pool: everyone's files.
#   MEDIA_DIR  Jellyfin's library, shown to the admin read-only.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

APPS_DIR="${APPS_DIR:-/1) Archive/Apps}"
POOL_DIR="${POOL_DIR:-/srv/pool}"
MEDIA_DIR="${MEDIA_DIR:-/srv/storage/Jellyfin/Media}"

PG_UID=999      # the official postgres image
WEB_UID=33      # www-data in the nextcloud image

kube() { sudo k3s kubectl "$@"; }

if ! sudo systemctl is-active --quiet k3s; then
  echo "k3s is not running on this board. This installs into the cluster." >&2
  exit 1
fi
if ! kube get ingressclass tailscale >/dev/null 2>&1; then
  echo "No tailscale IngressClass. Run 'make uptime' first." >&2
  exit 1
fi
# The pool, not a disk: an unmounted mount point is an empty directory on the
# boot SSD, and family files would quietly land there.
if ! mountpoint -q "$POOL_DIR"; then
  echo "$POOL_DIR is not mounted. Run 'make pool' first." >&2
  exit 1
fi
if [ ! -d "$MEDIA_DIR" ]; then
  echo "$MEDIA_DIR does not exist. Is the Jellyfin disk mounted? findmnt /srv/storage" >&2
  exit 1
fi
command -v jq >/dev/null || sudo apt-get install -y jq >/dev/null

echo "==> Layout"
printf '  %-18s %s\n' "code+config (SSD)" "$APPS_DIR/Nextcloud/html" \
                      "database    (SSD)" "$APPS_DIR/Nextcloud/db" \
                      "files      (pool)" "$POOL_DIR/Nextcloud/data" \
                      "Jellyfin (read-only)" "$MEDIA_DIR"

sudo mkdir -p "$APPS_DIR/Nextcloud/html" "$APPS_DIR/Nextcloud/db" "$POOL_DIR/Nextcloud/data"
sudo chown "$PG_UID:$PG_UID" "$APPS_DIR/Nextcloud/db"
sudo chmod 700 "$APPS_DIR/Nextcloud/db"
sudo chown "$WEB_UID:$WEB_UID" "$APPS_DIR/Nextcloud/html" "$POOL_DIR/Nextcloud/data"
# Nextcloud refuses a data directory other users can read.
sudo chmod 770 "$POOL_DIR/Nextcloud/data"

sudo tee "$APPS_DIR/Nextcloud/WHERE-IS-MY-DATA.txt" >/dev/null <<NOTE
Nextcloud keeps its halves on two kinds of disk.

  This folder      $APPS_DIR/Nextcloud
                   html/  Nextcloud's code, config and apps.
                   db/    Postgres: the file index, shares, users, settings.

  Everyone's files $POOL_DIR/Nextcloud/data/<username>/files
                   Plain files, one folder per person, on the disk pool.

Losing the database costs shares and settings, not the files.
Written by deploy/install-nextcloud.sh.
NOTE

echo "==> Secrets"
random() { python3 -c 'import secrets,string; print("".join(secrets.choice(string.ascii_letters+string.digits) for _ in range(32)))'; }
if kube -n pi get secret nextcloud-db >/dev/null 2>&1; then
  echo "  database password: already present — leaving it alone"
else
  kube -n pi create secret generic nextcloud-db --from-literal="password=$(random)" >/dev/null
  echo "  database password: generated, stored only in the cluster"
fi
if kube -n pi get secret nextcloud-admin >/dev/null 2>&1; then
  echo "  admin login: already present — leaving it alone"
else
  kube -n pi create secret generic nextcloud-admin \
    --from-literal="username=admin" --from-literal="password=$(random)" >/dev/null
  echo "  admin login: generated (shown at the end)"
fi

TZ_NAME="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
[ -n "$TZ_NAME" ] || TZ_NAME="Etc/UTC"
TAILNET="$(sudo tailscale status --json 2>/dev/null | jq -r '.MagicDNSSuffix // empty')"
[ -n "$TAILNET" ] || { echo "Could not read the tailnet name from tailscaled." >&2; exit 1; }
DOMAIN="cloud.${TAILNET}"
# Where the tailscale ingress proxy connects from: the pod ranges of the nodes.
POD_CIDRS="$(kube get nodes -o jsonpath='{.items[*].spec.podCIDR}')"
[ -n "$POD_CIDRS" ] || { echo "Could not read the cluster's pod range from the nodes." >&2; exit 1; }

echo "==> Manifests"
sed -e "s|__APPS_DIR__|${APPS_DIR}|g" \
    -e "s|__POOL_DIR__|${POOL_DIR}|g" \
    -e "s|__MEDIA_DIR__|${MEDIA_DIR}|g" \
    -e "s|__DOMAIN__|${DOMAIN}|g" \
    -e "s|__TZ__|${TZ_NAME}|g" \
    -e "s|__POD_CIDRS__|${POD_CIDRS}|g" \
    "${REPO_ROOT}/k8s/nextcloud.yaml" | kube apply -f -

echo "==> Waiting for the database and cache"
kube -n pi rollout status deployment/nextcloud-postgres --timeout=300s
kube -n pi rollout status deployment/nextcloud-redis --timeout=300s
echo "==> Waiting for Nextcloud (the first start installs it, several minutes)"
kube -n pi rollout status deployment/nextcloud --timeout=1200s

occ() { kube -n pi exec deploy/nextcloud -c nextcloud -- su -s /bin/sh www-data -c "php /var/www/html/occ $*"; }

for _ in $(seq 1 60); do
  [ "$(occ status --output=json 2>/dev/null | jq -r '.installed' 2>/dev/null)" = true ] && break
  sleep 10
done
if [ "$(occ status --output=json 2>/dev/null | jq -r '.installed' 2>/dev/null)" != true ]; then
  echo "Nextcloud did not finish installing. Logs: sudo k3s kubectl -n pi logs deploy/nextcloud -c nextcloud" >&2
  exit 1
fi

echo "==> Settings"
# Background jobs come from the cron container, which sleeps through quiet
# hours. The maintenance window (UTC) is when Nextcloud runs its heavy daily
# jobs: 19:00 UTC is the 20:00–24:00 slot the other apps' schedules use.
occ background:cron >/dev/null
occ config:system:set maintenance_window_start --type=integer --value=19 >/dev/null
echo "  background jobs  every 5 min, paused 00:00–06:00"

# Jellyfin's library for the admin only, read-only twice over: the mount is
# read-only in the pod, and the external storage is flagged read-only too.
ADMIN_USER="$(kube -n pi get secret nextcloud-admin -o jsonpath='{.data.username}' | base64 -d)"
occ app:enable files_external >/dev/null
if occ files_external:list --output=json 2>/dev/null | jq -e 'any(.[]; .mount_point == "/Jellyfin")' >/dev/null; then
  echo "  /Jellyfin        already mounted for the admin"
else
  id=$(occ files_external:create /Jellyfin local null::null -c datadir=/mnt/jellyfin | grep -o '[0-9]\+' | tail -1)
  occ files_external:applicable --add-user="$ADMIN_USER" "$id" >/dev/null
  occ files_external:option "$id" readonly true >/dev/null 2>&1 || true
  echo "  /Jellyfin        mounted read-only for $ADMIN_USER"
fi

echo
echo "==> Done"
echo "  address   https://${DOMAIN}"
echo "  admin     ${ADMIN_USER}"
echo "  password  sudo k3s kubectl -n pi get secret nextcloud-admin -o jsonpath='{.data.password}' | base64 -d; echo"
echo
echo "  Family accounts: log in as ${ADMIN_USER}, then Accounts > New account."
echo "  Set each person's quota there. Their files land in"
echo "  ${POOL_DIR}/Nextcloud/data/<username>/files."
echo
echo "  On a phone: install Tailscale and accept the share of the 'cloud'"
echo "  machine, then the Nextcloud app, with the address above."
