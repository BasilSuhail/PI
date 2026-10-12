#!/usr/bin/env bash
# Mirrors the two SSDs, so either one can die and jug3 keeps running.
#
# Before: the 250GB SSD holds Debian, the 1TB SSD holds "1) Archive". Lose
# either and the machine is down until someone rebuilds it.
#
# After: both SSDs carry the same three things, and Linux (mdadm RAID 1)
# writes every change to both at once:
#
#   p1  EFI       1G    each disk boots on its own; the firmware tries the
#                       next disk when one is dead
#   p2  root    100G    Debian, mirrored                       -> /
#   p3  apps    115G    "1) Archive", mirrored                 -> /srv/ssd
#   p4  swap     12G    one per disk, not mirrored
#   p5  spare   rest    only on a disk with room left over     -> /srv/spare
#
# The 250GB stays the main disk: reads come from it. The 1TB's half is marked
# write-mostly, so it takes every write and stays an exact copy without doing
# the reading. A disk dropping out posts to Discord with @everyone, and so
# does a boot with only one disk left (pi-raid-alert).
#
# A mirror is not a backup. A deleted or corrupted file is deleted on both
# disks at once; this only covers a disk dying.
#
# Every path stays the same (/, /srv/ssd, /1) Archive), so no app changes.
#
#   sudo bash deploy/ssd-mirror.sh check            read-only: the disks and the plan
#   sudo bash deploy/ssd-mirror.sh stage1           build the mirror on the 1TB, boot it once
#   sudo bash deploy/ssd-mirror.sh stage2           after that boot: add the 250GB, alerts on
#   sudo bash deploy/ssd-mirror.sh status           both disks, sync progress, boot entries
#   sudo bash deploy/ssd-mirror.sh add /dev/sdX [--backup]   a new or replacement SSD
#   sudo bash deploy/ssd-mirror.sh remove /dev/sdX           take an SSD out on purpose
#
# Stage 1 never touches the 250GB. Its reboot uses BootNext, a one-time boot:
# if the mirror does not come up, a power cycle lands back on the 250GB as it
# was, with the apps already pointed at the mirror so they still run.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || exec sudo -E bash "$0" "$@"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE=/etc/pi-ssd-mirror.env
STAGE_DIR="${STAGE_DIR:-/srv/storage/.ssd-mirror-stage}"
NEW=/mnt/ssd-mirror
ESP_TYPE=c12a7328-f81f-11d2-ba4b-00a0c93ec93b
ESP_GB=1 ROOT_GB=100 APPS_GB=115 SWAP_GB=12
# A disk must hold p1-p4 and a little slack. The 250GB has 232.9GiB.
NEED_GIB=$((ESP_GB + ROOT_GB + APPS_GB + SWAP_GB + 1))
GIB=$((1024 * 1024 * 1024))

say() { echo "==> $*"; }
die() { echo "  $*" >&2; exit 1; }

# --- disks -------------------------------------------------------------------

# Mount sources come back as /dev/sdd2[/1) Archive] for a bind; the device is
# the part before the bracket.
src_of() { local s; s=$(findmnt -nfo SOURCE "$1" 2>/dev/null) || return 1; echo "${s%%[*}"; }
disk_of() { echo "/dev/$(lsblk -no PKNAME "$1" | head -1)"; }
part_of() { case "$1" in *[0-9]) echo "${1}p$2" ;; *) echo "$1$2" ;; esac; }
size_of() { blockdev --getsize64 "$1"; }
uuid() { blkid -s UUID -o value "$1"; }
describe() { lsblk -dno MODEL,SIZE,TRAN "$1" | xargs; }

# sdX letters move between boots on this board; the by-id name does not.
by_id() {
  local l
  for l in /dev/disk/by-id/ata-* /dev/disk/by-id/nvme-*; do
    [ -e "$l" ] || continue
    case "$l" in *-part*) continue ;; esac
    [ "$(readlink -f "$l")" = "$1" ] && { echo "$l"; return 0; }
  done
  echo "$1"
}

# The array named root or apps, whatever number the kernel gave it.
md_dev() {
  local md
  for md in /dev/md[0-9]*; do
    [ -b "$md" ] || continue
    mdadm --detail "$md" 2>/dev/null | grep -Eq "^ *Name : ([^ ]*:)?$1( |$)" && { echo "$md"; return 0; }
  done
  return 1
}

# Every mount of any partition on a disk, deepest first, so binds come off
# before what they bind.
mounts_on() {
  local s t
  findmnt -rno SOURCE,TARGET | while read -r s t; do
    s=$(printf '%b' "$s"); s=${s%%[*}
    case "$s" in "$1"[0-9]*|"$1"p[0-9]*) printf '%b\n' "$t" ;; esac
  done | awk '{ print length, $0 }' | sort -rn | cut -d' ' -f2-
}

unmount_disk() {
  local m try
  for try in 1 2 3; do
    [ -z "$(mounts_on "$1")" ] && return 0
    while IFS= read -r m; do
      # Slave first: a peer of / passes its unmounts back up otherwise.
      mount --make-rslave "$m" 2>/dev/null || true
      umount "$m" 2>/dev/null || true
    done < <(mounts_on "$1")
    sleep 1
  done
  [ -z "$(mounts_on "$1")" ] && return 0
  echo "  Still mounted:" >&2
  mounts_on "$1" | sed 's/^/    /' >&2
  mounts_on "$1" | head -1 | xargs -d '\n' -r fuser -vm 2>&1 | sed 's/^/    /' >&2 || true
  return 1
}

# p1-p4 on every disk, p5 with whatever a bigger disk has left.
partition() {
  local disk=$1 p
  for p in $(lsblk -nrpo NAME,TYPE "$disk" | awk '$2 == "part" { print $1 }'); do
    mdadm --zero-superblock --force "$p" >/dev/null 2>&1 || true
    wipefs -aq "$p" || true
  done
  wipefs -aq "$disk"
  sgdisk --zap-all "$disk" >/dev/null
  sgdisk -n1:0:+${ESP_GB}G -t1:EF00 -c1:EFI \
         -n2:0:+${ROOT_GB}G -t2:FD00 -c2:mirror-root \
         -n3:0:+${APPS_GB}G -t3:FD00 -c3:mirror-apps \
         -n4:0:+${SWAP_GB}G -t4:8200 -c4:swap "$disk" >/dev/null
  if [ $(( $(size_of "$disk") / GIB - NEED_GIB )) -gt 20 ]; then
    sgdisk -n5:0:0 -t5:8300 -c5:spare "$disk" >/dev/null
  fi
  partprobe "$disk"; udevadm settle
  for p in 1 2 3 4 5; do
    [ -b "$(part_of "$disk" $p)" ] || continue
    wipefs -aq "$(part_of "$disk" $p)" || true
  done
}

# Fstab lines are rewritten by mount point, keeping options and comments.
fstab_set() { # file, mount point, UUID
  local f=$1 tmp; tmp=$(mktemp)
  awk -v m="$2" -v u="UUID=$3" '
    $1 !~ /^#/ && NF >= 3 && $2 == m { $1 = u; if (m == "/boot/efi" && $4 !~ /nofail/) $4 = $4 ",nofail" }
    { print }' "$f" > "$tmp"
  install -m 644 "$tmp" "$f"; rm -f "$tmp"
}

# Swap lines whose partition is gone: a disk taken out, or the 250GB's old one.
prune_swap() {
  local tmp; tmp=$(mktemp)
  awk '$1 !~ /^#/ && $3 == "swap" && $1 ~ /^UUID=/ {
         if (system("test -e /dev/disk/by-uuid/" substr($1, 6)) != 0) next }
       { print }' /etc/fstab > "$tmp"
  install -m 644 "$tmp" /etc/fstab; rm -f "$tmp"
}

boot_entry() { # label -> Boot#### number
  efibootmgr | sed -n "s/^Boot\([0-9A-F]\{4\}\)\*\{0,1\} $1\([[:space:]].*\)\{0,1\}$/\1/p" | tail -1
}

add_boot_entry() { # disk -> prints the new Boot#### number
  local disk=$1 label n loader='\EFI\debian\grubx64.efi' tmp
  label="jug3 mirror $(lsblk -dno SERIAL "$disk" | xargs)"
  while n=$(boot_entry "$label") && [ -n "$n" ]; do efibootmgr -q -b "$n" -B; done
  tmp=$(mktemp -d); mount "$(part_of "$disk" 1)" "$tmp"
  [ -f "$tmp/EFI/debian/shimx64.efi" ] && loader='\EFI\debian\shimx64.efi'
  umount "$tmp"; rmdir "$tmp"
  # -c puts the new entry first; callers set the order they want after.
  efibootmgr -q -c -d "$disk" -p 1 -L "$label" -l "$loader"
  boot_entry "$label"
}

write_mostly() { # md, partition
  echo writemostly > "/sys/block/$(basename "$(readlink -f "$1")")/md/dev-$(basename "$2")/state"
}

# --- check -------------------------------------------------------------------

preflight() {
  ROOT_SRC=$(src_of /) || die "Cannot read the root mount."
  case "$ROOT_SRC" in /dev/md*) die "Root is already on the mirror. Next: sudo bash deploy/ssd-mirror.sh stage2" ;; esac
  APPS_SRC=$(src_of /srv/ssd) || die "/srv/ssd is not mounted. Is the 1TB SSD in?"
  MAIN=$(disk_of "$ROOT_SRC")
  BACKUP=$(disk_of "$APPS_SRC")
  [ "$MAIN" != "$BACKUP" ] || die "/ and /srv/ssd are on the same disk ($MAIN)."
  grep -q '^md' /proc/mdstat 2>/dev/null && die "An md array already exists (cat /proc/mdstat). Not touching it."

  ROOT_USED=$(df -B1 --output=used / | tail -1)
  APPS_USED=$(df -B1 --output=used /srv/ssd | tail -1)
  mountpoint -q "$(dirname "$STAGE_DIR")" || die "$(dirname "$STAGE_DIR") is not mounted; it holds the copy of the apps."
  STAGE_FREE=$(df -B1 --output=avail "$(dirname "$STAGE_DIR")" | tail -1)

  say "Disks"
  printf '  %-8s %-10s %s\n' main "$MAIN" "$(describe "$MAIN")  ($(by_id "$MAIN"))"
  printf '  %-8s %-10s %s\n' backup "$BACKUP" "$(describe "$BACKUP")  ($(by_id "$BACKUP"))"
  local bad=0
  for d in "$MAIN" "$BACKUP"; do
    [ "$(lsblk -dno TRAN "$d" | xargs)" = sata ] || echo "  note: $d is not on SATA ($(lsblk -dno TRAN "$d"))"
    if [ $(( $(size_of "$d") / GIB )) -lt $NEED_GIB ]; then
      echo "  FAIL  $d holds $(( $(size_of "$d") / GIB ))GiB; the layout needs ${NEED_GIB}GiB" >&2; bad=1
    fi
  done

  say "Space"
  printf '  %-26s %4s GiB used, fits in %s GiB\n' "Debian (/)" $((ROOT_USED / GIB)) $ROOT_GB
  printf '  %-26s %4s GiB used, fits in %s GiB\n' "apps (/srv/ssd)" $((APPS_USED / GIB)) $APPS_GB
  printf '  %-26s %4s GiB free\n' "staging ($(dirname "$STAGE_DIR"))" $((STAGE_FREE / GIB))
  [ "$ROOT_USED" -lt $(( (ROOT_GB - 10) * GIB )) ] || { echo "  FAIL  Debian is too big for ${ROOT_GB}GiB" >&2; bad=1; }
  [ "$APPS_USED" -lt $(( (APPS_GB - 10) * GIB )) ] || { echo "  FAIL  the apps are too big for ${APPS_GB}GiB" >&2; bad=1; }
  [ "$STAGE_FREE" -gt $(( APPS_USED + 20 * GIB )) ] || { echo "  FAIL  not enough room to stage the apps" >&2; bad=1; }
  [ -d /sys/firmware/efi ] || { echo "  FAIL  not booted in UEFI mode" >&2; bad=1; }
  [ "$bad" -eq 0 ] || exit 1

  say "Plan"
  echo "  1. stop the apps, copy /srv/ssd to $STAGE_DIR"
  echo "  2. ERASE $BACKUP ($(describe "$BACKUP")), lay out EFI / root / apps / swap / spare"
  echo "  3. copy Debian and the apps onto it, make it bootable"
  echo "  4. one-time boot from it; the 250GB is untouched until stage 2"
}

# --- stage 1 -----------------------------------------------------------------

stage1() {
  command -v pi-when >/dev/null && { say "Who is using it"; pi-when now || true; }
  preflight
  echo
  printf '  Type WIPE to erase %s (%s) and start: ' "$BACKUP" "$(describe "$BACKUP")"
  read -r reply
  [ "$reply" = WIPE ] || die "Stopped. Nothing was changed."

  say "Tools"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q mdadm gdisk dosfstools efibootmgr rsync >/dev/null

  say "Stopping the apps"
  ERASED=0
  restore() {
    [ "$ERASED" -eq 0 ] || return 0
    echo "  Stopped before anything was erased. Starting everything again." >&2
    mount -a 2>/dev/null || true
    systemctl start smbd nmbd k3s 2>/dev/null || true
  }
  trap restore EXIT
  systemctl stop k3s
  # Stopping k3s leaves its containers running, by design. Its own teardown
  # kills them and lifts their mounts; a database still running would keep
  # writing under the copy.
  [ -x /usr/local/bin/k3s-killall.sh ] || die "k3s-killall.sh is missing; cannot stop the containers."
  /usr/local/bin/k3s-killall.sh >/dev/null 2>&1 || true
  local i
  for i in $(seq 30); do pgrep -f containerd-shim >/dev/null || break; sleep 1; done
  if pgrep -f containerd-shim >/dev/null; then
    pgrep -af containerd-shim | head -5 | sed 's/^/    /' >&2
    die "Containers are still running. Nothing was erased."
  fi
  echo "  all containers stopped"
  systemctl stop smbd nmbd 2>/dev/null || true

  say "Copying the apps to $STAGE_DIR"
  mkdir -p "$STAGE_DIR"
  rsync -aAXH --numeric-ids --delete --info=progress2 /srv/ssd/ "$STAGE_DIR/"
  # Second pass: quick, and picks up anything that moved during the first.
  rsync -aAXH --numeric-ids --delete /srv/ssd/ "$STAGE_DIR/"
  local diff
  diff=$(rsync -aAXHn --numeric-ids --delete --itemize-changes /srv/ssd/ "$STAGE_DIR/")
  if [ -n "$diff" ]; then
    echo "  Still changing under the copy (something outside k3s writes here):" >&2
    echo "$diff" | head -20 | sed 's/^/    /' >&2
    die "The copy does not match /srv/ssd. Nothing was erased."
  fi
  echo "  copy matches"

  say "Unmounting $BACKUP"
  unmount_disk "$BACKUP" || die "Could not free $BACKUP. Nothing was erased."

  say "Laying out $BACKUP"
  ERASED=1
  trap - EXIT
  trap 'echo; echo "  Failed after $BACKUP was erased. The apps are safe in $STAGE_DIR; the 250GB is untouched. Paste this output." >&2' EXIT
  partition "$BACKUP"
  mdadm --create /dev/md/root --name=root --level=1 --metadata=1.2 --bitmap=internal \
    --raid-devices=2 --run "$(part_of "$BACKUP" 2)" missing <<<y
  mdadm --create /dev/md/apps --name=apps --level=1 --metadata=1.2 --bitmap=internal \
    --raid-devices=2 --run "$(part_of "$BACKUP" 3)" missing <<<y
  udevadm settle
  MD_ROOT=$(md_dev root); MD_APPS=$(md_dev apps)
  mkfs.ext4 -q -F -L root "$MD_ROOT"
  mkfs.ext4 -q -F -L apps -m 1 "$MD_APPS"
  mkfs.vfat -F 32 -n EFI "$(part_of "$BACKUP" 1)" >/dev/null
  mkswap -q -L swap "$(part_of "$BACKUP" 4)"
  SPARE=""
  if [ -b "$(part_of "$BACKUP" 5)" ]; then
    SPARE=$(part_of "$BACKUP" 5)
    mkfs.ext4 -q -F -L spare "$SPARE"
  fi

  say "Copying Debian"
  mkdir -p "$NEW"
  mount "$MD_ROOT" "$NEW"
  # -x stays on the root filesystem, but /srv/browse/SSD-250GB is a bind of
  # that same filesystem and would be copied again inside itself.
  rsync -aAXHx --numeric-ids --info=progress2 \
    --exclude='/srv/browse/*/*' --exclude="$NEW/*" --exclude='/lost+found' / "$NEW/"
  mkdir -p "$NEW/boot/efi"
  mount "$(part_of "$BACKUP" 1)" "$NEW/boot/efi"
  rsync -rt /boot/efi/ "$NEW/boot/efi/"

  say "Copying the apps back from $STAGE_DIR"
  mkdir -p "$NEW/srv/ssd"
  mount "$MD_APPS" "$NEW/srv/ssd"
  rsync -aAXH --numeric-ids --info=progress2 "$STAGE_DIR/" "$NEW/srv/ssd/"
  if [ -n "$(rsync -aAXHn --numeric-ids --delete --itemize-changes "$STAGE_DIR/" "$NEW/srv/ssd/")" ]; then
    die "The apps on the mirror do not match the staged copy."
  fi
  echo "  copy matches"

  say "Pointing the copy at the mirror"
  fstab_set "$NEW/etc/fstab" / "$(uuid "$MD_ROOT")"
  fstab_set "$NEW/etc/fstab" /boot/efi "$(uuid "$(part_of "$BACKUP" 1)")"
  fstab_set "$NEW/etc/fstab" /srv/ssd "$(uuid "$MD_APPS")"
  # The 250GB's swap goes; this disk's own comes in.
  sed -i '/^[^#].*[[:space:]]swap[[:space:]]/d' "$NEW/etc/fstab"
  echo "UUID=$(uuid "$(part_of "$BACKUP" 4)") none swap sw,nofail 0 0" >> "$NEW/etc/fstab"
  if [ -n "$SPARE" ]; then
    mkdir -p "$NEW/srv/spare"
    echo "UUID=$(uuid "$SPARE") /srv/spare ext4 defaults,noatime,nofail 0 2" >> "$NEW/etc/fstab"
  fi
  for conf in /etc/mdadm/mdadm.conf "$NEW/etc/mdadm/mdadm.conf"; do
    sed -i '/^ARRAY /d' "$conf"
    mdadm --detail --brief "$MD_ROOT" "$MD_APPS" >> "$conf"
  done
  # A kernel or initramfs that cannot find its root reboots after 10 seconds
  # instead of waiting at a prompt nobody can see. BootNext is spent by then,
  # so that reboot lands on the 250GB.
  grep -q 'panic=' "$NEW/etc/default/grub" ||
    sed -i 's/^GRUB_CMDLINE_LINUX_DEFAULT="\(.*\)"/GRUB_CMDLINE_LINUX_DEFAULT="\1 panic=10"/' "$NEW/etc/default/grub"
  printf 'MAIN_ID=%s\nBACKUP_ID=%s\n' "$(by_id "$MAIN")" "$(by_id "$BACKUP")" | tee "$STATE" > "$NEW$STATE"

  say "Making it bootable"
  for d in dev proc sys run; do mount --rbind "/$d" "$NEW/$d"; mount --make-rslave "$NEW/$d"; done
  chroot "$NEW" update-initramfs -u -k all
  chroot "$NEW" grub-install --target=x86_64-efi --efi-directory=/boot/efi \
    --bootloader-id=debian --no-nvram --force-extra-removable
  chroot "$NEW" update-grub 2>&1 | sed 's/^/  /'
  grep -q "$(uuid "$MD_ROOT")" "$NEW/boot/grub/grub.cfg" || die "grub.cfg does not boot the mirror."
  lsinitramfs "$(ls -1 "$NEW"/boot/initrd.img-* | sort -V | tail -1)" | grep -q 'sbin/mdadm' ||
    die "The initramfs has no mdadm in it; it could not find the mirror."
  umount -R "$NEW"

  say "Boot entry"
  ORDER=$(efibootmgr | sed -n 's/^BootOrder: //p')
  ENTRY=$(add_boot_entry "$BACKUP")
  [ -n "$ENTRY" ] || die "Could not create the boot entry."
  # Usual order back, the mirror last, and the mirror once via BootNext.
  efibootmgr -q -o "${ORDER:+$ORDER,}$ENTRY"
  efibootmgr -q -n "$ENTRY"
  echo "  Boot$ENTRY  $(describe "$BACKUP")  -- next boot only"

  say "Apps on this system point at the mirror too"
  # If the mirror's first boot fails, this system comes back with its apps.
  fstab_set /etc/fstab /srv/ssd "$(uuid "$MD_APPS")"
  systemctl daemon-reload
  mount /srv/ssd && mount '/1) Archive' || true

  trap - EXIT
  cat <<NEXT

Stage 1 done. Reboot now:

  sudo reboot

Give it 3 minutes, SSH back in, then:

  sudo bash $REPO_ROOT/deploy/ssd-mirror.sh status

It should say root is on the mirror. If jug3 has not come back after 5
minutes, switch it off at the power button and on again: it boots the 250GB as
before, with the apps on the mirror. Nothing is lost either way.

$STAGE_DIR is the staged copy of the apps. Keep it until stage 2 is done.
NEXT
}

# --- add / stage 2 -----------------------------------------------------------

# Lays out a disk, joins it to both mirrors, copies the EFI partition and gives
# it a boot entry. Prints the entry number last.
add_disk() { # disk, role (main|backup)
  local disk=$1 role=$2 md p tmp
  MD_ROOT=$(md_dev root) || die "No mirror named root."
  MD_APPS=$(md_dev apps) || die "No mirror named apps."
  [ $(( $(size_of "$disk") / GIB )) -ge $NEED_GIB ] || die "$disk is smaller than ${NEED_GIB}GiB."
  [ -z "$(mounts_on "$disk")" ] || die "$disk has mounted partitions: $(mounts_on "$disk" | xargs)"
  grep -qw "$(basename "$disk")[0-9p]*" /proc/mdstat && die "$disk is already in a mirror."

  partition "$disk"
  mdadm --add "$MD_ROOT" "$(part_of "$disk" 2)" >/dev/null
  mdadm --add "$MD_APPS" "$(part_of "$disk" 3)" >/dev/null
  if [ "$role" = backup ]; then
    write_mostly "$MD_ROOT" "$(part_of "$disk" 2)"
    write_mostly "$MD_APPS" "$(part_of "$disk" 3)"
  fi

  mkfs.vfat -F 32 -n EFI "$(part_of "$disk" 1)" >/dev/null
  mountpoint -q /boot/efi || mount /boot/efi
  tmp=$(mktemp -d); mount "$(part_of "$disk" 1)" "$tmp"
  rsync -rt --delete /boot/efi/ "$tmp/"
  umount "$tmp"; rmdir "$tmp"

  mkswap -q -L swap "$(part_of "$disk" 4)"
  echo "UUID=$(blkid -s UUID -o value "$(part_of "$disk" 4)") none swap sw,nofail 0 0" >> /etc/fstab
  swapon "$(part_of "$disk" 4)" || true
  p=$(part_of "$disk" 5)
  if [ -b "$p" ]; then
    mkfs.ext4 -q -F -L spare "$p"
    if ! awk '$1 !~ /^#/ && $2 == "/srv/spare"' /etc/fstab | grep -q .; then
      mkdir -p /srv/spare
      echo "UUID=$(blkid -s UUID -o value "$p") /srv/spare ext4 defaults,noatime,nofail 0 2" >> /etc/fstab
      systemctl daemon-reload; mount /srv/spare || true
    fi
  fi

  add_boot_entry "$disk"
}

# Main disk first, the rest of the mirror next, anything else after. Entries
# for EFI partitions that no longer exist (the 250GB's old one) are deleted.
boot_order() { # first entry, second entry
  local n uuid order="$1${2:+,$2}"
  while read -r n uuid; do
    [ -e "/dev/disk/by-partuuid/$uuid" ] || { efibootmgr -q -b "$n" -B; echo "  removed stale Boot$n"; }
  done < <(efibootmgr -v | sed -n 's/^Boot\([0-9A-F]\{4\}\).*HD([0-9]*,GPT,\([0-9a-fA-F-]*\),.*File(\\EFI\\debian\\.*/\1 \2/p')
  for n in $(efibootmgr | sed -n 's/^BootOrder: //p' | tr ',' ' '); do
    case ",$order," in *",$n,"*) ;; *) efibootmgr | grep -q "^Boot$n" && order="$order,$n" ;; esac
  done
  efibootmgr -q -o "$order"
}

install_alerts() {
  say "Alerts"
  install -m 755 "$REPO_ROOT/deploy/pi-raid-alert.sh" /usr/local/bin/pi-raid-alert
  install -m 755 "$REPO_ROOT/deploy/pi-esp-sync.sh" /usr/local/bin/pi-esp-sync
  local conf=/etc/mdadm/mdadm.conf
  sed -i '/^PROGRAM /d' "$conf"
  echo "PROGRAM /usr/local/bin/pi-raid-alert" >> "$conf"
  cat > /etc/systemd/system/pi-raid-check.service <<'UNIT'
[Unit]
Description=Post to Discord if jug3 booted with an SSD missing from the mirror
Wants=network-online.target
After=network-online.target mdmonitor.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/pi-esp-sync
ExecStart=/usr/local/bin/pi-raid-alert --boot

[Install]
WantedBy=multi-user.target
UNIT
  # Any package change can touch GRUB or the kernel; every disk's EFI
  # partition gets the result, not only the mounted one.
  echo 'DPkg::Post-Invoke { "/usr/local/bin/pi-esp-sync || true"; };' > /etc/apt/apt.conf.d/99-pi-esp-sync
  systemctl daemon-reload
  systemctl enable pi-raid-check.service >/dev/null 2>&1
  systemctl restart mdmonitor.service 2>/dev/null || systemctl start mdmonitor.service 2>/dev/null || true
  printf '  %-14s %s\n' mdmonitor "$(systemctl is-active mdmonitor.service 2>/dev/null || true)"
  /usr/local/bin/pi-raid-alert TestMessage "$(md_dev root)" && echo "  test message sent to Discord"
}

stage2() {
  ROOT_SRC=$(src_of /)
  case "$ROOT_SRC" in /dev/md*) ;; *)
    die "Root is on $ROOT_SRC, not the mirror. Stage 1's boot did not take; paste: sudo bash deploy/ssd-mirror.sh status" ;;
  esac
  [ -r "$STATE" ] || die "$STATE is missing; it names the two disks."
  # shellcheck disable=SC1090
  . "$STATE"
  MAIN=$(readlink -f "$MAIN_ID"); BACKUP=$(readlink -f "$BACKUP_ID")
  [ -b "$MAIN" ] || die "The 250GB ($MAIN_ID) is not here."
  [ "$(disk_of "$ROOT_SRC")" != "$MAIN" ] || die "Root runs from $MAIN; it cannot be the disk being erased."
  if grep -qw "$(basename "$MAIN")[0-9]*" /proc/mdstat; then
    echo "  $MAIN is already in the mirror. Showing status."; status; return
  fi

  local p
  for p in $(lsblk -nrpo NAME,TYPE "$MAIN" | awk '$2 == "part" { print $1 }'); do swapoff "$p" 2>/dev/null || true; done
  unmount_disk "$MAIN" || die "Could not free $MAIN."

  say "Disks"
  printf '  %-8s %-10s %s\n' main "$MAIN" "$(describe "$MAIN")  -- erased now, joins the mirror"
  printf '  %-8s %-10s %s\n' backup "$BACKUP" "$(describe "$BACKUP")  -- running, kept"
  printf '  Type WIPE to erase %s (%s): ' "$MAIN" "$(describe "$MAIN")"
  read -r reply
  [ "$reply" = WIPE ] || die "Stopped. Nothing was changed."

  # The mirror becomes the normal boot now, so a reboot mid-way still lands
  # on it rather than on the 250GB's old system.
  local backup_entry main_entry
  backup_entry=$(boot_entry "jug3 mirror $(lsblk -dno SERIAL "$BACKUP" | xargs)")
  [ -n "$backup_entry" ] && boot_order "$backup_entry"

  say "Laying out $MAIN and joining it to the mirror"
  main_entry=$(add_disk "$MAIN" main | tail -1)
  prune_swap

  say "1TB as the backup half (write-mostly)"
  write_mostly "$(md_dev root)" "$(part_of "$BACKUP" 2)"
  write_mostly "$(md_dev apps)" "$(part_of "$BACKUP" 3)"

  say "Boot order"
  boot_order "$main_entry" "$backup_entry"
  efibootmgr | grep -E '^Boot(Order|[0-9A-F]{4}\*? jug3)' | sed 's/^/  /'

  install_alerts
  update-initramfs -u >/dev/null 2>&1 || true
  systemctl daemon-reload
  echo
  status
  cat <<NEXT

Stage 2 done. The 250GB is copying itself from the 1TB (the % above); the
machine is fully usable while it does. Then:

  sudo bash $REPO_ROOT/deploy/setup-browse.sh

$STAGE_DIR can be deleted once you are happy:  sudo rm -rf $STAGE_DIR
NEXT
}

add_cmd() {
  local disk=${1:-} role=main entry
  [ -b "$disk" ] || die "Usage: ssd-mirror.sh add /dev/sdX [--backup]"
  [ "${2:-}" = --backup ] && role=backup
  disk=$(readlink -f "$disk")
  say "Adding $disk ($(describe "$disk")) as $role"
  printf '  Type WIPE to erase it: '
  read -r reply
  [ "$reply" = WIPE ] || die "Stopped. Nothing was changed."
  prune_swap
  entry=$(add_disk "$disk" "$role" | tail -1)
  # A main disk boots first; a backup boots second.
  if [ "$role" = main ]; then
    boot_order "$entry"
    sed -i "s|^MAIN_ID=.*|MAIN_ID=$(by_id "$disk")|" "$STATE" 2>/dev/null || true
  else
    boot_order "$(efibootmgr | sed -n 's/^BootOrder: \([0-9A-F]\{4\}\).*/\1/p')" "$entry"
    sed -i "s|^BACKUP_ID=.*|BACKUP_ID=$(by_id "$disk")|" "$STATE" 2>/dev/null || true
  fi
  update-initramfs -u >/dev/null 2>&1 || true
  status
}

remove_cmd() {
  local disk=${1:-} md p label n
  [ -b "$disk" ] || die "Usage: ssd-mirror.sh remove /dev/sdX"
  disk=$(readlink -f "$disk")
  for md in $(md_dev root) $(md_dev apps); do
    [ "$(mdadm --detail "$md" | sed -n 's/^ *Active Devices : //p')" -ge 2 ] ||
      die "$(basename "$md") has only one disk left; removing it would stop jug3."
  done
  say "Taking $disk ($(describe "$disk")) out of the mirror"
  printf '  The other SSD carries on alone until a new one is added. Type REMOVE: '
  read -r reply
  [ "$reply" = REMOVE ] || die "Stopped. Nothing was changed."
  # Planned, so no @everyone for the next ten minutes.
  mkdir -p /run/pi-raid-alert && touch /run/pi-raid-alert/quiet
  for md in $(md_dev root) $(md_dev apps); do
    for p in $(lsblk -nrpo NAME "$disk" | tail -n +2); do
      if mdadm --detail "$md" | grep -q "$p\$"; then
        mdadm "$md" --fail "$p" --remove "$p" >/dev/null
        mdadm --zero-superblock "$p" 2>/dev/null || true
        echo "  $p left $(basename "$md")"
      fi
    done
  done
  for p in $(lsblk -nrpo NAME "$disk" | tail -n +2); do swapoff "$p" 2>/dev/null || true; done
  if [ "$(disk_of "$(src_of /boot/efi 2>/dev/null || echo /dev/null)" 2>/dev/null)" = "$disk" ]; then
    umount /boot/efi
  fi
  unmount_disk "$disk" || true
  # Point /boot/efi at a disk that stays; pi-esp-sync mounts one if needed.
  /usr/local/bin/pi-esp-sync || true
  p=$(src_of /boot/efi 2>/dev/null) && fstab_set /etc/fstab /boot/efi "$(blkid -s UUID -o value "$p")"
  label="jug3 mirror $(lsblk -dno SERIAL "$disk" | xargs)"
  while n=$(boot_entry "$label") && [ -n "$n" ]; do efibootmgr -q -b "$n" -B; echo "  removed Boot$n"; done
  echo "  Power off, swap the disk, power on, then: sudo bash deploy/ssd-mirror.sh add /dev/sdX --backup"
}

# --- status ------------------------------------------------------------------

status() {
  say "Mounts"
  for m in / /srv/ssd /boot/efi /srv/spare; do
    printf '  %-10s %s\n' "$m" "$(src_of "$m" 2>/dev/null || echo '(not mounted)')"
  done
  say "Mirrors"
  local md name found=0
  for md in /dev/md[0-9]*; do
    [ -b "$md" ] || continue
    found=1
    name=$(mdadm --detail "$md" | sed -n 's/^ *Name : \([^ ]*:\)\{0,1\}\([^ ]*\).*/\2/p')
    printf '  %-5s %-9s %s\n' "$name" "$(basename "$md")" "$(mdadm --detail "$md" | sed -n 's/^ *State : //p')"
    mdadm --detail "$md" | awk '$NF ~ /^\/dev\// && $1 ~ /^[0-9]+$/ {
        s = ""; for (i = 5; i < NF; i++) s = s $i " "; print $NF, s }' |
      while read -r p role; do
        printf '        %-10s %-28s %s\n' "$p" "$role" "$(describe "$(disk_of "$p")")"
      done
    sed -n "/^$(basename "$md") /,/^$/p" /proc/mdstat | grep -o '\(recovery\|resync\) *=.*' | sed 's/^/        /' || true
  done
  [ "$found" -eq 1 ] || echo "  none"
  say "Swap"
  swapon --show=NAME,SIZE --noheadings | sed 's/^/  /'
  say "Boot"
  efibootmgr | grep -E '^Boot(Next|Order|[0-9A-F]{4})' | sed 's/^/  /'
}

case "${1:-}" in
  check) preflight ;;
  stage1) stage1 ;;
  stage2) stage2 ;;
  status) status ;;
  add) shift; add_cmd "$@" ;;
  remove) shift; remove_cmd "$@" ;;
  *) sed -n '/^#   sudo/p' "$0" | sed 's/^# *//'; exit 1 ;;
esac
