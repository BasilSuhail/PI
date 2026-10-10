#!/usr/bin/env bash
# Nextcloud in k3s, on its own tailnet name. Runs on the board. Safe to re-run.
#
# Needs the Tailscale operator (make uptime) and the disk pool (make pool).
#
#   APPS_DIR   the SSD: Nextcloud's code, config and Postgres.
#   POOL_DIR   the mergerfs pool: everyone's files.
#   HDD1_DIR / HDD2_DIR  both HDDs whole, shown to the admin writable,
#                        except the app folders (PROTECTED below).
#   ARCHIVE_DIR  the SSD archive, shown to the admin writable, except
#                APPS_DIR (PROTECTED below).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

APPS_DIR="${APPS_DIR:-/1) Archive/Apps}"
POOL_DIR="${POOL_DIR:-/srv/pool}"
HDD1_DIR="${HDD1_DIR:-/srv/storage}"
HDD2_DIR="${HDD2_DIR:-/srv/hdd2}"
ARCHIVE_DIR="${ARCHIVE_DIR:-$(dirname "$APPS_DIR")}"
OWNER="${OWNER:-$(id -un)}"
OWNER_UID="$(id -u "$OWNER")"

# The app folders, read-only in Nextcloud. Must match the read-only mounts
# in k8s/nextcloud.yaml.
PROTECTED=("$APPS_DIR" "$HDD1_DIR/Jellyfin" "$HDD1_DIR/Downloads"
           "$HDD2_DIR/Immich" "$HDD2_DIR/Nextcloud" "$HDD2_DIR/ArchiveBox"
           "$HDD2_DIR/Kiwix" "$HDD2_DIR/Backups")

PG_UID=999      # the official postgres image
WEB_UID=33      # www-data in the nextcloud image

kube() { sudo k3s kubectl "$@"; }
# Refuses to install over a second copy of an app; see the file.
. "${REPO_ROOT}/deploy/lib/guard.sh"

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
for disk in "$HDD1_DIR" "$HDD2_DIR"; do
  if ! mountpoint -q "$disk"; then
    echo "$disk is not mounted. The admin's disk views need it: findmnt $disk" >&2
    exit 1
  fi
done
command -v jq >/dev/null || sudo apt-get install -y jq >/dev/null

echo "==> Layout"
printf '  %-18s %s\n' "code+config (SSD)" "$APPS_DIR/Nextcloud/html" \
                      "database    (SSD)" "$APPS_DIR/Nextcloud/db" \
                      "files      (pool)" "$POOL_DIR/Nextcloud/data" \
                      "HDD1 (editable)" "$HDD1_DIR" \
                      "HDD2 (editable)" "$HDD2_DIR" \
                      "SSD1 (editable)" "$ARCHIVE_DIR" \
                      "  but read-only" "${PROTECTED[*]}"

sudo mkdir -p "$APPS_DIR/Nextcloud/html" "$APPS_DIR/Nextcloud/db" "$POOL_DIR/Nextcloud/data"
sudo chown "$PG_UID:$PG_UID" "$APPS_DIR/Nextcloud/db"
sudo chmod 700 "$APPS_DIR/Nextcloud/db"
sudo chown "$WEB_UID:$WEB_UID" "$APPS_DIR/Nextcloud/html" "$POOL_DIR/Nextcloud/data"
# Nextcloud refuses a data directory other users can read.
sudo chmod 770 "$POOL_DIR/Nextcloud/data"

# The admin's editable folders stay owned by the login user, so Finder works as
# before; an ACL gives Nextcloud (www-data) write access alongside. The default
# ACLs apply the same to anything created later, from either side.
command -v setfacl >/dev/null || sudo apt-get install -y acl >/dev/null
# grant [-R] dir. setfacl wants its options before the path.
grant() {
  local r=""; if [ "$1" = -R ]; then r=-R; shift; fi
  sudo setfacl $r -m "u:$WEB_UID:rwX" -m "d:u:$WEB_UID:rwX" -m "d:u:$OWNER_UID:rwX" "$1"
}
# Each read-only mount needs its folder to exist, or the pod will not start.
for d in "${PROTECTED[@]}"; do
  [ -d "$d" ] || sudo install -d -o "$OWNER" -g "$OWNER" "$d"
done
# The disk tops, not recursively: new folders can be made there, and the app
# folders keep their permissions. Then every other top-level folder, whole.
is_protected() { local p; for p in "${PROTECTED[@]}"; do [ "$1" = "$p" ] && return 0; done; return 1; }
for disk in "$HDD1_DIR" "$HDD2_DIR" "$ARCHIVE_DIR"; do
  grant "$disk"
  for d in "$disk"/*/; do
    d="${d%/}"
    [ -d "$d" ] || continue
    is_protected "$d" && continue
    [ "$(basename "$d")" = lost+found ] && continue
    grant -R "$d"
    printf '  %-18s %s\n' "editable" "$d"
  done
done

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
    -e "s|__DOMAIN__|${DOMAIN}|g" \
    -e "s|__TZ__|${TZ_NAME}|g" \
    -e "s|__POD_CIDRS__|${POD_CIDRS}|g" \
    -e "s|__HDD1_DIR__|${HDD1_DIR}|g" \
    -e "s|__HDD2_DIR__|${HDD2_DIR}|g" \
    -e "s|__ARCHIVE_DIR__|${ARCHIVE_DIR}|g" \
    "${REPO_ROOT}/k8s/nextcloud.yaml" | apply_guarded

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
# jobs: 06:00 UTC, the morning slot every automatic job on the machine uses.
# Nothing automatic runs at night or in the evening; people do.
occ background:cron >/dev/null
occ config:system:set maintenance_window_start --type=integer --value=6 >/dev/null
echo "  background jobs  every 5 min, paused 00:00–06:00"
# New accounts start empty: no sample documents, photos or templates.
occ config:system:set skeletondirectory --value= >/dev/null
occ config:system:set templatedirectory --value= >/dev/null
echo "  new accounts     start empty"

# Storage only. Everything below is a feature, not storage, and each one is
# something a family member can open and get lost in. Kept: files, previews,
# deleted files, versions, sharing between accounts, external storage, the
# security apps, and the provisioning API the phone and desktop apps log in
# through. Apps Nextcloud will not let go of are left as they are.
for app in activity app_api circles comments contactsinteraction dashboard \
           federation files_downloadlimit files_reminders firstrunwizard \
           nextcloud_announcements photos privacy recommendations \
           related_resources sharebymail support survey_client systemtags \
           updatenotification user_status weather_status webhook_listeners; do
  occ app:disable "$app" >/dev/null 2>&1 || true
done
# Impersonate: the admin opens any account as that person, from the Users
# page, to look after a family member's files. Changes go through Nextcloud,
# so their own view stays in step, which the admin's whole-disk view of the
# data folder cannot do. Only admins can impersonate.
occ app:install impersonate >/dev/null 2>&1 || occ app:enable impersonate >/dev/null 2>&1 || true
# With the dashboard gone, a login lands on the files.
occ config:system:set defaultapp --value=files >/dev/null
echo "  apps             storage only; opens straight to Files; admin can impersonate"

# The admin's three disks, as external storage visible to the admin only.
# What is read-only is decided in the pod (read-only mounts over the app
# folders), so none are flagged read-only in Nextcloud, which would block the
# whole disk. Names have no spaces: they pass through a shell inside the pod.
ADMIN_USER="$(kube -n pi get secret nextcloud-admin -o jsonpath='{.data.username}' | base64 -d)"
occ app:enable files_external >/dev/null
existing=$(occ files_external:list --output=json 2>/dev/null || echo '[]')
attach() { # mount point, path in the pod, ro|rw
  local id
  id=$(jq -r --arg m "$1" 'first(.[] | select(.mount_point == $m) | .mount_id) // empty' <<<"$existing")
  if [ -n "$id" ]; then
    # Earlier versions of this script flagged the HDDs read-only.
    occ files_external:option "$id" readonly "$([ "$3" = ro ] && echo true || echo false)" >/dev/null 2>&1 || true
    # Who may see it is enforced on every run, not only when it is created. A
    # mount carried over from another machine kept whatever it had, and one
    # with no applicable user is visible to every account: a family member
    # could browse the whole disk, backups included.
    occ files_external:applicable --add-user="$ADMIN_USER" "$id" >/dev/null
    printf '  %-16s already attached, admin only\n' "$1"
    return 0
  fi
  id=$(occ files_external:create "$1" local null::null -c "datadir=$2" | grep -o '[0-9]\+' | tail -1)
  occ files_external:applicable --add-user="$ADMIN_USER" "$id" >/dev/null
  if [ "$3" = ro ]; then occ files_external:option "$id" readonly true >/dev/null 2>&1 || true; fi
  printf '  %-16s attached for %s\n' "$1" "$ADMIN_USER"
}
# Views from earlier versions of this script, now inside HDD1 and SSD1.
detach() { # mount point
  local id
  for id in $(jq -r --arg m "$1" '.[] | select(.mount_point == $m) | .mount_id' <<<"$existing"); do
    occ files_external:delete --yes "$id" >/dev/null
    printf '  %-16s removed (now inside %s)\n' "$1" "$2"
  done
}
detach /Jellyfin    HDD1
detach /Mac-backups SSD1
detach /Pictures    SSD1
attach /HDD1 /mnt/hdd1 rw
attach /HDD2 /mnt/hdd2 rw
attach /SSD1 /mnt/ssd1 rw

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
