#!/usr/bin/env bash
# Creates the archive tree. Run on pi2. Idempotent — safe to re-run.
#
# The 8TB is still blocked on 12V and does not need to block the archive with
# it. pi2 has 873GB free, which holds Wikipedia, the book library and a first
# laptop backup with room to spare. Nothing here assumes the disk underneath:
# every service is pointed at the path, never at a device, so when the 8TB is
# finally mounted at this path the services do not notice.
#
# Read the migration note this prints at the end before mounting that disk.
set -euo pipefail

ARCHIVE="${ARCHIVE:-/srv/archive}"
OWNER="${OWNER:-$(id -un)}"
# Wikipedia alone is ~100GB; refuse to start somewhere that cannot hold it.
MIN_FREE_GB="${MIN_FREE_GB:-200}"

DIRS=(backups documents photos movies books wikipedia repos)

# $ARCHIVE does not exist yet, and nor may its parent if it was overridden.
probe="$ARCHIVE"
while [ ! -d "$probe" ]; do probe=$(dirname "$probe"); done
free_gb=$(df -BG --output=avail "$probe" | tail -1 | tr -dc '0-9')
if [ "$free_gb" -lt "$MIN_FREE_GB" ]; then
  echo "Only ${free_gb}GB free where $ARCHIVE would live; wanted ${MIN_FREE_GB}GB." >&2
  exit 1
fi

echo "==> Creating $ARCHIVE (${free_gb}GB free)"
sudo mkdir -p "$ARCHIVE"
for d in "${DIRS[@]}"; do sudo mkdir -p "$ARCHIVE/$d"; done
sudo chown -R "$OWNER:$(id -gn "$OWNER")" "$ARCHIVE"
# Group-writable and setgid, so anything added later inherits the group rather
# than depending on whichever daemon happened to write the file.
sudo chmod -R 2775 "$ARCHIVE"

echo
for d in "${DIRS[@]}"; do printf '  %s/%s\n' "$ARCHIVE" "$d"; done
echo
df -h "$ARCHIVE" | sed 's/^/  /'

if mountpoint -q "$ARCHIVE"; then
  echo
  echo "==> $ARCHIVE is a mount point. The archive is on its own disk."
  exit 0
fi

device=$(findmnt -no SOURCE --target "$ARCHIVE")
cat <<NOTE

==> $ARCHIVE is on ${device}, the root filesystem — not a separate disk yet.

    When the 8TB arrives, do NOT simply mount it here. Mounting over a
    directory hides what is underneath: the files stay on ${device}, keep
    consuming it, and become invisible and unrecoverable without unmounting
    again. Instead:

      sudo mount /dev/sdX1 /mnt/new
      sudo rsync -aHAX --info=progress2 $ARCHIVE/ /mnt/new/
      sudo umount /mnt/new
      sudo mv $ARCHIVE $ARCHIVE.on-root       # keep until the copy is verified
      sudo mkdir -p $ARCHIVE
      # add the fstab line by UUID, then:
      sudo mount -a && ls $ARCHIVE
      # only once that looks right:
      sudo rm -rf $ARCHIVE.on-root

    The fstab line wants nofail, or a disconnected drive stops the board
    booting at all:

      UUID=<uuid>  $ARCHIVE  ext4  defaults,noatime,nofail  0  2
NOTE
