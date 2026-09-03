#!/usr/bin/env bash
# Jellyfin and Kiwix, and moves Vaultwarden and Uptime Kuma onto the same
# storage layout. Runs on the board.
#
# One idea, applied four times: an app has two halves, and they belong on
# different drives for different reasons.
#
#   APPS_DIR   the SSD. Everything the computer reads at random: settings,
#              databases, caches, artwork, indexes. Small, and the part where
#              speed is felt — a seek costs a spinning disk about 5ms against
#              an SSD's 0.1, and a database is thousands of seeks.
#   DATA_DIR   the 6TB. Everything you would recognise as a file: films, .zim
#              archives, the vault. Large, read start to finish, which is what
#              a spinning disk is actually good at.
#
# The cut is by how a file is read, not by whether it is called data. Calling a
# database "data" and putting it on the big disk is the mistake this layout was
# one revision away from making: Jellyfin's library index is 50MB and would
# have made the whole interface feel slow from the far side of a seek.
#
# Both are overridable, which is the point:
#
#     DATA_DIR=/srv/storage/media bash deploy/install-media.sh
#
# Nothing here uses a PersistentVolumeClaim. k3s' local-path provisioner puts
# volumes in /var/lib/rancher/k3s/storage/pvc-<uuid>_<ns>_<name>, and a
# directory named after a UUID inside a container runtime's internals cannot
# be found in Finder, cannot be backed up without knowing k3s, and cannot tell
# you what is eating the disk. Named directories on named drives do all three.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OWNER="${OWNER:-$(id -un)}"
OWNER_UID="$(id -u "$OWNER")"
OWNER_GID="$(id -g "$OWNER")"

# The archive moved from /srv/archive to "/1) Archive". Both are accepted so
# this works whichever the board is carrying, rather than failing on a board
# that has not run deploy/setup-archive.sh since the rename.
if [ -z "${APPS_DIR:-}" ]; then
  for candidate in "/1) Archive" /srv/archive; do
    [ -d "$candidate" ] && { APPS_DIR="$candidate/Apps"; break; }
  done
fi
APPS_DIR="${APPS_DIR:-/1) Archive/Apps}"

# The 6TB, by its mount point rather than its device: a disk swapped for a
# bigger one at the same path should need no edit here.
DATA_DIR="${DATA_DIR:-/srv/storage}"

APPS=(Jellyfin Kiwix Vaultwarden Uptime)
# Uptime Kuma is entirely on the SSD: a few megabytes of heartbeats, written
# constantly, which would keep the 6TB awake for nothing.
DATA_APPS=(Jellyfin Kiwix Vaultwarden)

if ! sudo systemctl is-active --quiet k3s; then
  echo "k3s is not running on this board. This installs into the cluster." >&2
  exit 1
fi

kube() { sudo k3s kubectl "$@"; }

if ! kube -n tailscale get secret operator-oauth >/dev/null 2>&1; then
  echo "The Tailscale operator is not installed — run 'make uptime' first." >&2
  echo "Jellyfin and Kiwix each want a tailnet name of their own, and the" >&2
  echo "operator is what hands those out." >&2
  exit 1
fi

# Say where everything is going before touching anything. The whole point of
# this layout is that you can answer "where is my data" without reading a
# manifest, and that starts with the install telling you.
echo "==> Layout"
printf '  %-14s %s\n' "apps  (SSD)" "$APPS_DIR"
printf '  %-14s %s\n' "data  (6TB)" "$DATA_DIR"
echo
for app in "${APPS[@]}"; do
  printf '  %-12s %s\n' "$app" "$APPS_DIR/$app"
  case " ${DATA_APPS[*]} " in
    *" $app "*) printf '  %-12s %s\n' "" "$DATA_DIR/$app" ;;
    *)          printf '  %-12s %s\n' "" "(nothing on the 6TB — it is small)" ;;
  esac
done
echo

# A missing DATA_DIR almost always means the 6TB is not mounted, and creating
# the directory anyway would silently write the media library onto the boot
# SSD until it filled. Refuse instead.
if [ ! -d "$DATA_DIR" ]; then
  echo "$DATA_DIR does not exist. Is the drive mounted? Check: findmnt $DATA_DIR" >&2
  exit 1
fi

# Existing is not the same as mounted. A mount point is a real directory on the
# boot disk when nothing is mounted on it, so "the folder is there" proves
# nothing — and creating the app folders inside an unmounted mount point is
# exactly how the whole media library ends up on the boot SSD, invisible, until
# the disk is mounted over the top of it.
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

echo "==> Creating the folders"
for app in "${APPS[@]}"; do sudo mkdir -p "$APPS_DIR/$app"; done
# Kuma takes ownership of everything inside its mount, so its data sits one
# level below the app folder and the note stays outside it.
sudo mkdir -p "$APPS_DIR/Uptime/data"
for app in "${DATA_APPS[@]}"; do sudo mkdir -p "$DATA_DIR/$app"; done
# Jellyfin's brain on the SSD, its films on the 6TB.
sudo mkdir -p "$APPS_DIR/Jellyfin/data" "$APPS_DIR/Jellyfin/cache" \
              "$DATA_DIR/Jellyfin/Media/Movies" "$DATA_DIR/Jellyfin/Media/Shows"
# Ownership, and the one non-obvious case.
#
# hostPath volumes are NOT chowned by Kubernetes. fsGroup is honoured for
# volume types that support ownership management and a raw hostPath is not one
# of them, so whatever these directories are created as is what the container
# gets. A directory left owned by root is a container that cannot write.
#
# Jellyfin and Kiwix run as the login user, so their folders are its own.
#
# Uptime Kuma is the case that would have broken. Its entrypoint drops to the
# image's `node` account through setpriv, which is uid 1000 in the node base
# image — the same number as the login user here, but by coincidence rather
# than agreement. It used to sit on a local-path volume, and that provisioner
# creates its directories world-writable, which is the only reason this was
# never a problem before. Its folder is under APPS_DIR and so is covered by the
# chown below; the write test after the rollout is what proves the coincidence
# held.
#
# Vaultwarden still runs as root and can write to anything, so its folder is
# deliberately left alone rather than given away to a user it does not use.
sudo chown -R "$OWNER_UID:$OWNER_GID" \
  "$APPS_DIR" "$DATA_DIR/Jellyfin" "$DATA_DIR/Kiwix"

# A note in each app's SSD folder, because a folder holding only a config file
# does not explain itself six months later.
for app in "${APPS[@]}"; do
  sudo tee "$APPS_DIR/$app/WHERE-IS-MY-DATA.txt" >/dev/null <<NOTE
$app

  This folder      $APPS_DIR/$app
                   settings, database, cache. Small, fast, and the part
                   worth backing up.

  Its content      $DATA_DIR/$app
                   the big files. Films, .zim archives, attachments.

Written by deploy/install-media.sh. Change the split by re-running it with
APPS_DIR= or DATA_DIR= set.
NOTE
done
sudo chown -R "$OWNER_UID:$OWNER_GID" "$APPS_DIR"

echo "==> Applying manifests"
# The paths are substituted here rather than being fixed in the manifests,
# which is what makes them configurable. sed's delimiter is | because the
# values are paths and one of them contains a space and a bracket.
render() {
  sed -e "s|__APPS_DIR__|${APPS_DIR}|g" \
      -e "s|__DATA_DIR__|${DATA_DIR}|g" \
      -e "s|__UID__|${OWNER_UID}|g" \
      -e "s|__GID__|${OWNER_GID}|g" "$1"
}

for manifest in jellyfin kiwix vaultwarden uptime-kuma; do
  render "${REPO_ROOT}/k8s/${manifest}.yaml" | kube apply -f -
done

# The old PVCs are deliberately left in place. Vaultwarden is empty and Kuma's
# heartbeat history is being started over, so neither is worth migrating — but
# deleting a volume in the same breath as repointing the thing that used it is
# how data goes missing. Remove them by hand once the pods are up and right.
echo
echo "==> The old volumes are still there, untouched:"
kube -n jug get pvc 2>/dev/null | sed 's/^/  /' || true
echo "  Remove when you are happy:  sudo k3s kubectl -n jug delete pvc vaultwarden uptime-kuma"

echo
echo "==> Waiting for the rollouts"
for app in jellyfin kiwix vaultwarden uptime-kuma; do
  kube -n jug rollout status "deployment/$app" --timeout=300s || {
    echo "  $app did not come up. Logs:" >&2
    kube -n jug logs "deployment/$app" --tail=30 2>&1 | sed 's/^/    /' >&2
  }
done

# Readiness proves the process answers, not that it can write where it was
# pointed — and a media server that cannot write its database will happily
# serve a login page while failing at the only thing it is for. Ask each
# container directly.
echo
echo "==> Can each app write to its data folder?"
write_test() { # deployment, path inside the container
  kube -n jug exec "deployment/$1" -- sh -c \
    'd=$1; t="$d/.write-test.$$"; touch "$t" 2>/dev/null && rm -f "$t"' sh "$2" >/dev/null 2>&1
}
failed=0
for pair in "jellyfin /data" "kiwix /config" "vaultwarden /data" "uptime-kuma /app/data"; do
  set -- $pair
  if write_test "$1" "$2"; then
    printf '  ok    %-14s %s\n' "$1" "$2"
  else
    printf '  FAIL  %-14s %s  <- cannot write\n' "$1" "$2"
    failed=1
  fi
done
if [ "$failed" = 1 ]; then
  cat >&2 <<'FIXIT'

  A container that cannot write to its folder is an ownership mismatch: the
  directory on the board belongs to a different uid than the one inside the
  container. Find the uid it actually runs as, and hand it the folder:

    sudo k3s kubectl -n jug exec deployment/<app> -- id
    sudo chown -R <uid>:<gid> <the folder printed above>

FIXIT
fi

echo
echo "==> Addresses"
kube -n jug get ingress -o custom-columns=NAME:.metadata.name,HOST:.spec.tls[0].hosts[0] --no-headers 2>/dev/null |
  while read -r name host; do printf '  %-12s https://%s.%s\n' "$name" "$host" "taild9f605.ts.net"; done

cat <<NEXT

Jellyfin
  Open it and run the setup wizard. Add a library pointing at /media/Movies
  and /media/Shows — those are ${DATA_DIR}/Jellyfin/Media/* from the board.
  Copy films in through the HDD-6TB folder in Finder.

  This board direct-plays. It does not meaningfully transcode: a client that
  needs the video re-encoded will stutter, and 4K will not work at all. Play
  to something that handles the codec natively and it is fine.

Kiwix
  Serving an empty catalogue until there is something to serve. Download a
  .zim from https://download.kiwix.org/zim/ into ${DATA_DIR}/Kiwix, then:

    sudo k3s kubectl -n jug rollout restart deployment/kiwix

  The library is rebuilt from whatever is in that folder on every start, so
  the folder is the truth and there is no index to keep in step with it.

Rollback:  sudo k3s kubectl -n jug delete -f ${REPO_ROOT}/k8s/jellyfin.yaml -f ${REPO_ROOT}/k8s/kiwix.yaml
NEXT
