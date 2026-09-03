#!/usr/bin/env bash
# Makes a plugged-in drive mount itself. Run on any board. Idempotent.
#
# Plugging a disk in should be the whole job — USB, SATA, whatever the kernel
# recognises. Without this it takes an ssh session, a mount, an fstab line and
# a re-run of setup-browse.sh, which is four steps too many for "I attached a
# drive".
#
# A udev rule hands each new partition to systemd-mount, which mounts it under
# /media and unmounts it again when the device goes away. That is how a desktop
# Linux behaves; nothing here is exotic. /media is already in the agent's
# writable roots, so the drive arrives browsable and writable with no config.
#
# The partitions the board boots from are excluded explicitly, by device and by
# PARTUUID. The first version of this rule trusted systemd-mount to skip
# devices already in fstab, and that trust was wrong: fstab names them by
# PARTUUID while the rule hands systemd-mount a /dev node, and both boards
# ended up with their own root and boot filesystems mounted under /media —
# writable, through the console's file browser, one stray delete from an
# unbootable board.
set -euo pipefail

RULE=/etc/udev/rules.d/99-jug-automount.rules
MEDIA=/media

# Everything udev will ever see the boot partitions as, resolved from the live
# mounts so the rule works on any board however it boots.
self_excludes=""
self_sources=""
for mountpoint in / /boot/firmware; do
  src=$(findmnt -no SOURCE "$mountpoint" 2>/dev/null) || continue
  case "$src" in
    /dev/*)
      self_excludes="$self_excludes ENV{DEVNAME}!=\"$src\""
      self_sources="$self_sources $src"
      ;;
  esac
  partuuid=$(findmnt -no PARTUUID "$mountpoint" 2>/dev/null) || true
  case "$partuuid" in
    ''|-) ;;  # not every filesystem has one; the DEVNAME match still guards
    *) self_excludes="$self_excludes ENV{ID_PART_ENTRY_UUID}!=\"$partuuid\"" ;;
  esac
done
# A board whose root could not be named still gets a rule that parses, matching
# nothing, rather than one udev rejects outright.
[ -n "$self_excludes" ] || self_excludes='ENV{DEVNAME}=="__no_such_node__"'

echo "==> Ensuring $MEDIA exists"
sudo mkdir -p "$MEDIA"

echo "==> Writing $RULE (excluding$self_sources from automount)"
# ENV{ID_FS_USAGE}=="filesystem" skips swap, raid members and empty devices.
# The systemd-mount --automount=yes means the mount happens on first access
# rather than at plug time, so a sleeping drive is not spun up to be indexed.
sudo tee "$RULE" >/dev/null <<RULE_BODY
# Managed by deploy/setup-automount.sh in the PI repo. Edit the repo, not this.
#
# Mount any newly attached filesystem under /media/<label or device>, and take
# it away again on removal. The partitions this board boots from are excluded
# by device and by PARTUUID — see setup-automount.sh for why trusting fstab to
# keep them out did not work.

ACTION=="add", SUBSYSTEM=="block", ENV{ID_FS_USAGE}=="filesystem", \\
  ENV{DEVTYPE}=="partition", ENV{ID_BUS}!="", ${self_excludes} \\
  RUN{program}+="/usr/bin/systemd-mount --no-block --automount=yes --collect \$devnode /media/\$env{ID_FS_LABEL}"

ACTION=="remove", SUBSYSTEM=="block", ENV{ID_FS_USAGE}=="filesystem", \\
  ENV{DEVTYPE}=="partition", ENV{ID_BUS}!="", \\
  RUN{program}+="/usr/bin/systemd-umount /media/\$env{ID_FS_LABEL}"
RULE_BODY

echo "==> Reloading udev"
sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=block --action=add

# An older version of this rule mounted the board's own partitions under /media,
# and those mounts outlive the rule that made them. Take them down here so a
# re-run leaves the board as intended, without waiting for a reboot. Touching
# the directory first trips systemd's automount into mounting the real
# filesystem, which is the thing findmnt has to see to recognise it.
if [ -n "$self_sources" ]; then
  for point in "$MEDIA"/*; do
    [ -d "$point" ] || continue
    ls "$point" >/dev/null 2>&1 || true
    src=$(findmnt -no SOURCE -T "$point" 2>/dev/null) || continue
    case "$self_sources" in
      *" $src "*)
        sudo systemd-umount "$point" 2>/dev/null || sudo umount "$point"
        sudo rmdir "$point" 2>/dev/null || true
        echo "==> Unmounted $point — it was $src, the operating system"
        ;;
    esac
  done
fi

echo
echo "==> Mounted under $MEDIA"
if [ -n "$(ls -A "$MEDIA" 2>/dev/null)" ]; then
  for point in "$MEDIA"/*; do
    [ -d "$point" ] || continue
    printf '  %-24s %s\n' "$(basename "$point")" "$(findmnt -no SOURCE,SIZE "$point" 2>/dev/null || echo 'not mounted')"
  done
else
  echo "  nothing yet — plug a drive in and it appears here"
fi

cat <<'NOTE'

  A drive without a filesystem label mounts under its device name instead, so
  label them if you want the console to show something readable:

      sudo e2label /dev/sdX1 photos

  This does not touch the disks the board already had. Those stay in fstab and
  stay where they are.
NOTE
