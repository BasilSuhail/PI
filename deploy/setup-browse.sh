#!/usr/bin/env bash
# Builds /srv/browse — "1) Archive" first, then one directory per disk.
#
# Two kinds of thing sit at the top, and the split is the point:
#
#   1) Archive   the data. Apps, databases, storage, backups, keys — the one
#                folder worth copying somewhere else, because copying it takes
#                everything that matters and nothing that does not.
#   SSD-1TB      a disk, whole. The OS, /etc, and every random directory a
#                Linux install accumulates. A disk that hides its own /etc is
#                a brochure, not a view, so none of it is hidden — it is just
#                not mixed in with the data.
#   HDD-6TB      another disk, and every disk added later joins on the same
#                terms: its own folder at the top, nothing implied about what
#                goes in it.
#
# The console's Files view carries the same names from the same sysfs facts
# (read_disks in the agent, withRotation in the dashboard server), so both
# doors into the files agree.
#
# Bind mounts, not symlinks: Samba refuses to follow a symlink out of a share
# unless `wide links = yes`, and that option turns off a protection worth
# keeping. A bind mount is the same thing without the hole.
#
# One trap the shape has to defuse, learned the hard way: a mount under a bound
# root is invisible through the bind — the bind shows the directory underneath,
# not the filesystem mounted on it. So a second filesystem on the SAME disk
# (the boot partition) is bound again inside the disk's folder, at its real
# path. A filesystem on a DIFFERENT disk is deliberately not: /srv/storage on
# the SSD holds none of the SSD, the HDD has a folder of its own at the top,
# and the empty directory the SSD really has there is the truthful thing to
# show.
#
# Nothing here formats, partitions or writes to a disk. Idempotent: re-run it
# after mounting anything new and the tree is rebuilt to match.
set -euo pipefail

BROWSE="${BROWSE:-/srv/browse}"
MEDIA="${MEDIA:-/media}"
OWNER="${OWNER:-$(id -un)}"
FSTAB=/etc/fstab
MARK="# jug-browse"

# Mount points that are plumbing rather than a disk's contents: the OS's own
# pseudo-filesystems, container state, and /media, where the automount rule
# puts a second copy of any disk that fires a udev event. / is deliberately
# absent from this list — the whole point of a per-disk tree is that the
# system's files sit under the disk they live on.
skip_re='^(/proc.*|/sys.*|/run.*|/dev.*|/media.*|/mnt/new|/var/lib/docker.*|/var/lib/kubelet.*|/var/lib/rancher.*|/snap.*)$'

# The physical disk a mounted source belongs to: sda2 -> sda. A source with no
# parent device names itself.
disk_of() {
  local parent
  parent=$(lsblk -no pkname "$1" 2>/dev/null || true)
  echo "${parent:-$(basename "$1")}"
}

# Size in bytes and the rotational flag for a disk, from the same sysfs files
# the agent reads. Empty when the disk cannot be named.
disk_facts() {
  local base="/sys/block/$1" sectors rotational device_path
  [ -r "$base/size" ] || return 0
  read -r sectors < "$base/size" || return 0
  rotational=1
  [ -r "$base/queue/rotational" ] && read -r rotational < "$base/queue/rotational" || true
  # USB-SATA bridges don't pass through the rotational flag; the kernel
  # defaults to 1 (spinning). If the device path walks through USB, assume SSD.
  if [ "$rotational" = 1 ]; then
    device_path=$(readlink -f "$base/device" 2>/dev/null || echo "")
    [[ "$device_path" == *usb* ]] && rotational=0
  fi
  echo "$((sectors * 512)) $rotational"
}

# Sold-as capacity, integer arithmetic: 0.98TB reads "1TB", 5.95TB reads
# "6TB", and a sub-TB disk snaps to the size the shelf sold it as, because
# "SSD 502GB" is noise and nobody has ever said it.
capacity_of() {
  local bytes=$1 tb gb c sold
  if (( bytes >= 950000000000 )); then
    tb=$(( bytes / 1000000000000 ))
    if (( bytes % 1000000000000 >= 500000000000 )); then tb=$(( tb + 1 )); fi
    echo "${tb}TB"
    return
  fi
  gb=$(( (bytes + 500000000) / 1000000000 ))
  sold=""
  for c in 120 128 250 256 500 512 750 768; do
    if (( gb >= c * 92 / 100 && gb <= c * 108 / 100 )); then sold=$c; break; fi
  done
  echo "${sold:-$gb}GB"
}

kind_of() { # $1 = rotational flag, $2 = device name
  if [ "$1" = 1 ]; then echo HDD
  elif [ "$1" = 0 ]; then echo SSD
  elif [[ "$2" == mmcblk* ]]; then echo "SD card"
  else echo disk
  fi
}

# "SSD 1TB" -> "SSD-1TB". Finder takes dashes over spaces without complaint.
name_for() { basename "$1" | tr -c 'A-Za-z0-9._-' '-' | sed 's/-\+/-/g;s/^-//;s/-$//'; }

echo "==> Reading mounted filesystems"
# -n no headings, -l list form. SOURCE is the device; anything not under /dev
# is a pseudo-filesystem or a bind of a directory, and is not a disk.
#
# SOURCE first, TARGET second, because `read` splits on whitespace and a mount
# point may now contain a space ("1) Archive"). A device name never does, so
# reading the device into its own word and letting the target take the rest of
# the line is the ordering that cannot mis-split.
mapfile -t rows < <(findmnt -nlo SOURCE,TARGET | sort -u)

declare -A disk_root=()   # disk -> its shallowest mount, the folder's contents
declare -A disk_depth=()  # depth of that mount, "/" being the shallowest
mounts=()
for row in "${rows[@]}"; do
  read -r source target <<<"$row"
  [[ "$source" == /dev/* ]] || continue
  [[ "$target" =~ $skip_re ]] && continue
  [[ "$target" == "$BROWSE"/* ]] && continue
  disk=$(disk_of "$source")
  [ -z "$(disk_facts "$disk")" ] && continue   # loop/ram/zram: not a disk
  mounts+=("$target|$disk")
  depth=${target//[^\/]/}
  if [ -z "${disk_root[$disk]:-}" ] || [ ${#depth} -lt ${disk_depth[$disk]} ]; then
    disk_root[$disk]=$target
    disk_depth[$disk]=${#depth}
  fi
done

if [ ${#disk_root[@]} -eq 0 ]; then
  echo "No mounted disk to expose. Plug one in, or check: findmnt -l" >&2
  exit 1
fi

echo "==> Clearing the old tree"
# Old fstab lines first, then unmount what they describe. umount -R walks the
# nested binds inside each folder; a folder that stays busy means Finder or a
# shell is sitting in it, and deleting around a live mount is exactly the
# mistake this script refuses to make — abort and say so instead.
sudo sed -i "\|$MARK|d" "$FSTAB"
sudo mkdir -p "$BROWSE"
for point in "$BROWSE"/*; do
  [ -e "$point" ] || continue
  if mountpoint -q "$point"; then
    # Cut propagation first. The removable mirror is a slave of /media, but a
    # mirror re-created from fstab at boot is a shared peer of it, and
    # unmounting a peer unmounts the original — every plugged-in drive, ejected
    # by a script that only meant to rebuild a folder. Making it slave again is
    # a no-op when it already is.
    sudo mount --make-rslave "$point" 2>/dev/null || true
    sudo umount -R "$point" || {
      echo "  $point is busy. Close Finder windows and shells on it, then re-run." >&2
      exit 1
    }
  fi
done

# Belt and braces before a recursive delete. If anything under here is still a
# mount, the delete would walk into the filesystem behind it — /media, and the
# drive someone has plugged into it. Nothing about rebuilding a folder tree is
# worth that risk, so stop instead.
if findmnt -rno TARGET | grep -q "^$BROWSE/"; then
  echo "  Something under $BROWSE is still mounted. Refusing to delete around it." >&2
  findmnt -rno TARGET | grep "^$BROWSE/" | sed 's/^/    /' >&2
  exit 1
fi
sudo find "$BROWSE" -mindepth 1 -delete

echo "==> Binding one folder per disk"
declare -A used_names=()
# fstab splits its fields on whitespace, so a path containing a space has to
# carry it as \040 or the line silently describes a different mount. "1)
# Archive" is exactly that case, and mount reads the escape back on boot.
fstab_escape() { printf '%s' "${1// /\\040}"; }

bind() { # source, destination
  sudo mount --bind "$1" "$2"
  printf '%s  %s  none  bind,nofail  0  0  %s\n' \
    "$(fstab_escape "$1")" "$(fstab_escape "$2")" "$MARK" | sudo tee -a "$FSTAB" >/dev/null
}

# A live mirror rather than a snapshot. --bind copies the directory as it is
# now, and a filesystem mounted under the source afterwards stays invisible
# through it — which for /media means a stick plugged in after this ran would
# not appear until it ran again. --rbind carries the mounts that exist, and
# because systemd leaves / shared the copy joins the same propagation group,
# so mounts that appear later propagate into the mirror on their own.
#
# --make-rslave then makes the propagation one-way. Left shared, unmounting
# the mirror would travel back along the same path and unmount the drive
# itself: re-running this script would quietly eject every plugged-in stick.
# Slave receives, never sends.
rbind() { # source, destination
  sudo mount --rbind "$1" "$2"
  sudo mount --make-rslave "$2"
  printf '%s  %s  none  rbind,nofail  0  0  %s\n' \
    "$(fstab_escape "$1")" "$(fstab_escape "$2")" "$MARK" | sudo tee -a "$FSTAB" >/dev/null
}

for disk in "${!disk_root[@]}"; do
  read -r size rotational < <(disk_facts "$disk")
  name=$(name_for "/$(kind_of "$rotational" "$disk") $(capacity_of "$size")")
  while [ -n "${used_names[$name]:-}" ]; do name="${name}-${disk}"; done
  used_names[$name]=1

  point="$BROWSE/$name"
  sudo mkdir -p "$point"
  bind "${disk_root[$disk]}" "$point"
  echo "  $name  <-  ${disk_root[$disk]}"

  # Same-disk filesystems beyond the root, bound inside at their real path so
  # the root bind does not shadow them. Cross-disk mounts stay out — see the
  # header for why showing the empty underlying directory is the honest view.
  for m in "${mounts[@]}"; do
    IFS='|' read -r target mdisk <<<"$m"
    [ "$mdisk" = "$disk" ] || continue
    [ "$target" = "${disk_root[$disk]}" ] && continue
    nested="$point$target"
    sudo mkdir -p "$nested"
    bind "$target" "$nested"
    echo "  ${name}${target}  <-  $target"
  done
done

# The archive is a folder of its own at the top, beside the disks — not a pin
# inside one. It is the one place data lives: apps, databases, storage,
# backups, keys. Everything a disk holds that is not that — the OS, /etc, the
# random directories a Linux install accumulates — stays outside it, reachable
# under the disk's own folder. The rule is simple enough to hold in your head:
# copy this one folder and you have everything that matters.
#
# The leading "1)" is the whole sorting mechanism. Digits sort before letters,
# so Finder puts it first with no pinning, no shortcut and no second copy of
# the same bytes appearing further down the same disk — which is what the pin
# this replaces actually did, and what made /srv read 60.6GB on a disk holding
# 27.3GB.
ARCHIVE="${ARCHIVE:-/srv/archive}"
ARCHIVE_FOLDER="${ARCHIVE_FOLDER:-1) Archive}"
if [ -d "$ARCHIVE" ]; then
  archive_point="$BROWSE/$ARCHIVE_FOLDER"
  sudo mkdir -p "$archive_point"
  bind "$ARCHIVE" "$archive_point"
  echo "  $ARCHIVE_FOLDER  <-  $ARCHIVE"
else
  echo "  no $ARCHIVE yet — run deploy/setup-archive.sh to create it" >&2
fi

# Anything plugged in, mirrored live from /media, where the udev rule in
# deploy/setup-automount.sh mounts it. A folder rather than a per-disk entry
# because the whole point is that nothing has to be configured first: plug a
# stick in and it is in Finder, unplug it and it is gone, with this script
# never run again.
#
# /media stays in skip_re above, so a stick does not also become a disk folder
# of its own at the top. One place to look, and it is this one.
REMOVABLE_FOLDER="${REMOVABLE_FOLDER:-2) Plugged in}"
removable_point="$BROWSE/$REMOVABLE_FOLDER"
sudo mkdir -p "$MEDIA" "$removable_point"
rbind "$MEDIA" "$removable_point"
echo "  $REMOVABLE_FOLDER  <-  $MEDIA  (live: mounts appear and vanish on their own)"

sudo chown "$OWNER:$(id -gn "$OWNER")" "$BROWSE"
sudo chmod 0755 "$BROWSE"

echo
echo "==> $BROWSE"
printf '  %-20s %8s %8s  %s\n' NAME SIZE USED SOURCE
for point in "$BROWSE"/*; do
  [ -d "$point" ] || continue
  read -r size used _ < <(df -h --output=size,used "$point" | tail -1)
  printf '  %-20s %8s %8s  %s\n' "$(basename "$point")" "$size" "$used" \
    "$(findmnt -no SOURCE "$point" 2>/dev/null || echo '-')"
done
echo
echo "In Finder: the board's share, then the disk, then the path — the same"
echo "names the console's Files view uses."
