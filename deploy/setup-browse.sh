#!/usr/bin/env bash
# Builds /srv/browse — one directory per disk, named by what the disk is.
#
# The tree answers "which drive, then where on it": SSD-1TB, HDD-6TB, and under
# each the whole of that disk's own filesystem, system files included — a disk
# that hides its own /etc is a brochure, not a view. The console's Files view
# carries the same names from the same sysfs facts (read_disks in the agent,
# withRotation in the dashboard server), so both doors into the files agree.
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
  local base="/sys/block/$1" sectors rotational
  [ -r "$base/size" ] || return 0
  read -r sectors < "$base/size" || return 0
  rotational=1
  [ -r "$base/queue/rotational" ] && read -r rotational < "$base/queue/rotational" || true
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
mapfile -t rows < <(findmnt -nlo TARGET,SOURCE | sort -u)

declare -A disk_root=()   # disk -> its shallowest mount, the folder's contents
declare -A disk_depth=()  # depth of that mount, "/" being the shallowest
mounts=()
for row in "${rows[@]}"; do
  read -r target source <<<"$row"
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
    sudo umount -R "$point" || {
      echo "  $point is busy. Close Finder windows and shells on it, then re-run." >&2
      exit 1
    }
  fi
done
sudo find "$BROWSE" -mindepth 1 -delete

echo "==> Binding one folder per disk"
declare -A used_names=()
bind() { # source, destination
  sudo mount --bind "$1" "$2"
  printf '%s  %s  none  bind,nofail  0  0  %s\n' "$1" "$2" "$MARK" | sudo tee -a "$FSTAB" >/dev/null
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
