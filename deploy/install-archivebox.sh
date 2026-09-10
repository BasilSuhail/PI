#!/usr/bin/env bash
# ArchiveBox: a self-hosted internet archive. Runs on the board.
#
# Feed it URLs — one at a time, or a browser history export, or an RSS feed —
# and it saves full copies of everything it finds: HTML, screenshots, PDFs,
# media, WARC files, git repos. It uses wget, yt-dlp, and a headless browser
# under the hood, so you get what a real browser would see.
#
# The split is the same as every other app here:
#
#   SSD   the index. A SQLite database and the config. Small, read at random,
#         and the part where speed is felt.
#   6TB   the archived content. The pages, videos, and PDFs that are the whole
#         point. Large, read sequentially.
#
# ArchiveBox wants everything in one directory. The installer symlinks the
# index.sqlite3 from the 6TB back to the SSD, so the database gets fast seeks
# and the content gets the space it needs.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OWNER="${OWNER:-$(id -un)}"
OWNER_UID="$(id -u "$OWNER")"
OWNER_GID="$(id -g "$OWNER")"

if [ -z "${APPS_DIR:-}" ]; then
  for candidate in "/1) Archive" /srv/archive; do
    [ -d "$candidate" ] && { APPS_DIR="$candidate/Apps"; break; }
  done
fi
APPS_DIR="${APPS_DIR:-/1) Archive/Apps}"
DATA_DIR="${DATA_DIR:-/srv/storage}"

if ! sudo systemctl is-active --quiet k3s; then
  echo "k3s is not running on this board. This installs into the cluster." >&2
  exit 1
fi

kube() { sudo k3s kubectl "$@"; }

if ! kube -n tailscale get secret operator-oauth >/dev/null 2>&1; then
  echo "The Tailscale operator is not installed — run 'make uptime' first." >&2
  exit 1
fi

if [ ! -d "$DATA_DIR" ]; then
  echo "$DATA_DIR does not exist. Is the drive mounted? Check: findmnt $DATA_DIR" >&2
  exit 1
fi

if ! mountpoint -q "$DATA_DIR" 2>/dev/null; then
  echo >&2
  echo "  WARNING: $DATA_DIR is not a mount point." >&2
  echo "  Nothing is mounted there, so this is space on the boot disk." >&2
  echo "  If you meant the 6TB, stop now and check: findmnt $DATA_DIR" >&2
  echo >&2
  printf "  Continue anyway? [y/N] " >&2
  read -r reply
  case "$reply" in
    [yY]) echo "  Continuing on the boot disk." >&2 ;;
    *) echo "  Stopped. Nothing was changed." >&2; exit 1 ;;
  esac
fi

echo "==> Layout"
printf '  %-14s %s\n' "index (SSD)" "$APPS_DIR/ArchiveBox"
printf '  %-14s %s\n' "data  (6TB)" "$DATA_DIR/ArchiveBox"
echo

echo "==> Creating the folders"
sudo mkdir -p "$APPS_DIR/ArchiveBox" "$DATA_DIR/ArchiveBox"
sudo chown -R "$OWNER_UID:$OWNER_GID" "$APPS_DIR/ArchiveBox" "$DATA_DIR/ArchiveBox"

sudo tee "$APPS_DIR/ArchiveBox/WHERE-IS-MY-DATA.txt" >/dev/null <<NOTE
ArchiveBox

  This folder      $APPS_DIR/ArchiveBox
                   the SQLite index and config. Small, fast, and the part
                   worth looking at if the archive seems slow.

  Its content      $DATA_DIR/ArchiveBox
                   the archived pages, videos, PDFs, and screenshots.
                   This is the big half, and what the 6TB is for.

  The index.sqlite3 in the data folder is a symlink back here, so the
  database gets fast seeks on the SSD while the content gets capacity.

Written by deploy/install-archivebox.sh.
NOTE
sudo chown -R "$OWNER_UID:$OWNER_GID" "$APPS_DIR/ArchiveBox"

echo "==> Admin credentials"
CM_NAME="archivebox-config"
if kube -n pi get configmap "$CM_NAME" >/dev/null 2>&1; then
  echo "  already present — leaving them alone"
  echo "  (replace with: sudo k3s kubectl -n pi delete configmap ${CM_NAME}, then re-run)"
else
  AB_USER="${ARCHIVEBOX_ADMIN_USER:-admin}"
  if [ -z "${ARCHIVEBOX_ADMIN_PASS:-}" ]; then
    printf '  Admin password for ArchiveBox (username: %s): ' "$AB_USER"
    IFS= read -rs AB_PASS; echo
    if [ -z "$AB_PASS" ]; then
      echo "  Password is empty. Nothing was created." >&2
      exit 1
    fi
  else
    AB_PASS="$ARCHIVEBOX_ADMIN_PASS"
  fi

  kube -n pi create configmap "$CM_NAME" \
    --from-literal=ADMIN_USERNAME="$AB_USER" \
    --from-literal=ADMIN_PASSWORD="$AB_PASS" >/dev/null
  unset AB_PASS
  echo "  stored in the cluster as configmap/$CM_NAME"
fi

echo "==> Applying manifests"
render() {
  sed -e "s|__APPS_DIR__|${APPS_DIR}|g" \
      -e "s|__DATA_DIR__|${DATA_DIR}|g" \
      -e "s|__UID__|${OWNER_UID}|g" \
      -e "s|__GID__|${OWNER_GID}|g" "$1"
}
render "${REPO_ROOT}/k8s/archivebox.yaml" | kube apply -f -

echo
echo "==> Waiting for the rollout"
kube -n pi rollout status deployment/archivebox --timeout=300s || {
  echo "  archivebox did not come up. Logs:" >&2
  kube -n pi logs deployment/archivebox --tail=30 2>&1 | sed 's/^/    /' >&2
}

echo
echo "==> Can the app write to its data folder?"
if kube -n pi exec deployment/archivebox -- sh -c \
    't="/data/.write-test.$$"; touch "$t" 2>/dev/null && rm -f "$t"' >/dev/null 2>&1; then
  printf '  ok    %-14s %s\n' "archivebox" "/data"
else
  printf '  FAIL  %-14s %s  <- cannot write\n' "archivebox" "/data"
  cat >&2 <<'FIXIT'

  The container cannot write to its folder. This is an ownership mismatch:

    sudo k3s kubectl -n pi exec deployment/archivebox -- id
    sudo chown -R <uid>:<gid> <the folder printed above>

FIXIT
fi

echo
echo "==> Address"
kube -n pi get ingress archivebox \
  -o custom-columns=NAME:.metadata.name,HOST:.spec.tls[0].hosts[0] \
  --no-headers 2>/dev/null |
  while read -r name host; do printf '  %-12s https://%s.%s\n' "$name" "$host" "<tailnet>.ts.net"; done

cat <<NEXT

ArchiveBox is up. Open it at its tailnet address and log in with the
admin account you just created.

To archive a URL:

  sudo k3s kubectl -n pi exec deployment/archivebox -- archivebox add 'https://example.com'

Or open the web interface, log in, and paste URLs into the Add page.

To archive from a browser history or bookmarks export, copy the file
onto the board and run:

  sudo k3s kubectl -n pi exec deployment/archivebox -- archivebox add < exported-bookmarks.html

Data lands in ${DATA_DIR}/ArchiveBox, which is HDD-6TB/ArchiveBox in Finder.
The SQLite index lives on the SSD at ${APPS_DIR}/ArchiveBox/index.sqlite3.

Rollback:  sudo k3s kubectl -n pi delete -f ${REPO_ROOT}/k8s/archivebox.yaml
           sudo k3s kubectl -n pi delete configmap ${CM_NAME}
NEXT
