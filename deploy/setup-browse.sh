#!/usr/bin/env bash
# Builds /srv/browse — one directory per disk, which is what Samba and
# Filebrowser are both pointed at. Idempotent: re-run it after plugging a
# drive in and the new disk joins the tree without touching either service.
#
# Bind mounts, not symlinks. Samba refuses to follow a symlink out of a share
# unless `wide links = yes`, and that option turns off a protection worth
# keeping. A bind mount is the same thing without the hole.
#
# Nothing here formats, partitions or writes to a disk. It mounts what is
# already mounted, a second time, somewhere tidier.
set -euo pipefail

BROWSE="${BROWSE:-/srv/browse}"
ARCHIVE="${ARCHIVE:-/srv/archive}"
OWNER="${OWNER:-$(id -un)}"
FSTAB=/etc/fstab
MARK="# pi-browse"

# Mount points that are the operating system rather than storage. Everything
# else that is a real block device gets a place in the tree.
skip_re='^(/|/boot.*|/proc.*|/sys.*|/run.*|/dev.*|/var/lib/docker.*|/snap.*)$'

echo "==> Reading mounted filesystems"
# -n no headings, -l list form, -o the three columns wanted. SOURCE is the
# device; anything not under /dev is a pseudo-filesystem and is not storage.
mapfile -t rows < <(findmnt -nlo TARGET,SOURCE,FSTYPE | sort -u)

declare -A picked=()
for row in "${rows[@]}"; do
  read -r target source fstype <<<"$row"
  [[ "$source" == /dev/* ]] || continue
  [[ "$target" =~ $skip_re ]] && continue
  [[ "$target" == "$BROWSE"/* ]] && continue   # our own bind mounts
  [[ "$target" == "$ARCHIVE" ]] && continue    # linked under its own name below
  picked["$target"]="$source ($fstype)"
done

sudo mkdir -p "$BROWSE"

# The archive is the curated tree and keeps its name whether or not it has a
# disk of its own yet. It may not exist: setup-archive.sh has its own run.
if [ -d "$ARCHIVE" ]; then
  picked["$ARCHIVE"]="the curated tree"
fi

if [ ${#picked[@]} -eq 0 ]; then
  echo "  Nothing to expose. No data filesystem is mounted outside the OS." >&2
  echo "  Mount a disk first, then re-run this." >&2
  exit 1
fi

# A mount point becomes a directory name: /mnt/ssd-1tb -> ssd-1tb, and
# /srv/archive -> archive. Bare enough to read in Finder.
name_for() {
  local target="$1"
  basename "$target" | tr -c 'A-Za-z0-9._-' '-' | sed 's/-\+/-/g;s/^-//;s/-$//'
}

echo "==> Binding into $BROWSE"
declare -A wanted=()
for target in "${!picked[@]}"; do
  name=$(name_for "$target")
  wanted["$name"]=1
  point="$BROWSE/$name"
  sudo mkdir -p "$point"

  if mountpoint -q "$point"; then
    echo "  $name already bound"
  else
    sudo mount --bind "$target" "$point"
    echo "  $name  <-  $target  ${picked[$target]}"
  fi

  line="$target  $point  none  bind,nofail  0  0  $MARK"
  # nofail so a disk that is not there on the next boot does not stop the boot.
  if ! grep -qF "  $point  " "$FSTAB"; then
    printf '%s\n' "$line" | sudo tee -a "$FSTAB" >/dev/null
  fi
done

# A disk that went away leaves a stale directory and a stale fstab line. Drop
# both, but only ones this script wrote — the marker is what makes that safe.
echo "==> Pruning entries for disks that are gone"
for point in "$BROWSE"/*; do
  [ -d "$point" ] || continue
  name=$(basename "$point")
  [ -n "${wanted[$name]:-}" ] && continue
  mountpoint -q "$point" && sudo umount "$point"
  sudo sed -i "\\|  $point  .*$MARK|d" "$FSTAB"
  sudo rmdir "$point" 2>/dev/null && echo "  removed $name"
done

sudo chown "$OWNER:$(id -gn "$OWNER")" "$BROWSE"
sudo chmod 0755 "$BROWSE"

echo
echo "==> $BROWSE"
findmnt -nlo TARGET,SOURCE,SIZE,USED,AVAIL --target "$BROWSE" -R 2>/dev/null | sed 's/^/  /' || ls -la "$BROWSE" | sed 's/^/  /'
echo
echo "Serve it with:  bash deploy/install-samba.sh   and   bash deploy/install-filebrowser.sh"
