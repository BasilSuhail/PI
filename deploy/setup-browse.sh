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
MARK="# jug-browse"

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

# The archive is the curated tree and keeps its name whether or not it has a
# disk of its own yet. It may not exist: setup-archive.sh has its own run.
if [ -d "$ARCHIVE" ]; then
  picked["$ARCHIVE"]="the curated tree"
fi

if [ ${#picked[@]} -eq 0 ]; then
  # The usual case on these boards: the SSD is the root filesystem rather than
  # a separate mount, so every candidate was skipped as the OS. Nothing is
  # wrong with the disk — there is simply no mount point to bind.
  root_dev=$(findmnt -no SOURCE /)
  root_free=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
  cat >&2 <<NOTE
  Nothing to expose yet.

  Every filesystem here is the operating system's own. $root_dev is mounted
  at / with ${root_free}GB free, and / is skipped on purpose: binding it would
  put the whole OS in Finder and in the console.

  You do not need another disk for this. Make the archive tree first, which
  lives on whatever filesystem is underneath and is what every service points
  at anyway:

      make archive        # or: bash deploy/setup-archive.sh

  Then re-run this. When a real disk does arrive, mount it anywhere with
  nofail and re-run this again — it is picked up with no further config.
NOTE
  exit 1
fi

# Only now is there something to hold. Creating it earlier left an empty
# directory behind on a failed run, which the console then read as an empty
# disk rather than as a board that needs setting up.
sudo mkdir -p "$BROWSE"

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
# One line per disk. `findmnt --target ... -R` was printing every mount on the
# board — sysfs, proc, and every k3s container overlay — because --target
# resolves to the filesystem holding the path, which here is the root one.
printf '  %-16s %8s %8s %8s  %s\n' NAME SIZE USED AVAIL SOURCE
for point in "$BROWSE"/*; do
  [ -d "$point" ] || continue
  read -r size used avail < <(df -h --output=size,used,avail "$point" | tail -1)
  printf '  %-16s %8s %8s %8s  %s\n' \
    "$(basename "$point")" "$size" "$used" "$avail" "$(findmnt -no SOURCE "$point" 2>/dev/null || echo '-')"
done
echo
echo "Share it in Finder with:  make samba NODE=$(hostname)"
echo "It is already in the console under Storage."
