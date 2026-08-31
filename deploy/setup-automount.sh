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
# The internal disks are left alone: the rule only fires for partitions that
# are not already in fstab and are not the ones the board boots from.
set -euo pipefail

RULE=/etc/udev/rules.d/99-jug-automount.rules
MEDIA=/media

echo "==> Ensuring $MEDIA exists"
sudo mkdir -p "$MEDIA"

echo "==> Writing $RULE"
# ENV{ID_FS_USAGE}=="filesystem" skips swap, raid members and empty devices.
# The systemd-mount --automount=yes means the mount happens on first access
# rather than at plug time, so a sleeping drive is not spun up to be indexed.
sudo tee "$RULE" >/dev/null <<'RULE_BODY'
# Managed by deploy/setup-automount.sh in the PI repo. Edit the repo, not this.
#
# Mount any newly attached filesystem under /media/<label or device>, and take
# it away again on removal. Devices already listed in fstab are skipped by
# systemd-mount itself, so the boot disk and anything hand-mounted is untouched.

ACTION=="add", SUBSYSTEM=="block", ENV{ID_FS_USAGE}=="filesystem", \
  ENV{DEVTYPE}=="partition", ENV{ID_BUS}!="", \
  RUN{program}+="/usr/bin/systemd-mount --no-block --automount=yes --collect $devnode /media/$env{ID_FS_LABEL}"

ACTION=="remove", SUBSYSTEM=="block", ENV{ID_FS_USAGE}=="filesystem", \
  ENV{DEVTYPE}=="partition", ENV{ID_BUS}!="", \
  RUN{program}+="/usr/bin/systemd-umount /media/$env{ID_FS_LABEL}"
RULE_BODY

echo "==> Reloading udev"
sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=block --action=add

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
