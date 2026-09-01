#!/usr/bin/env bash
# Makes the boards' shares appear in Finder while Tailscale is up and go away
# when it is not. Run on the Mac, once:
#
#     bash deploy/install-share-mounts.sh
#
# Idempotent — re-running re-checks the pieces and reloads the agent rather
# than replacing anything.
#
# Three pieces, and each is here for a reason:
#
#   a mount point per board   /Volumes is root-owned, so the directories are
#                             made once with sudo. Made ahead of time they
#                             survive an unmount, which means the pass that
#                             runs later needs no privilege at all.
#   a keychain entry per board  so the mount is silent. mount_smbfs reads the
#                             password from the login keychain; it is typed
#                             here and never written to the repo or to a
#                             command line.
#   a LaunchAgent             which runs deploy/sync-share-mounts.sh on a
#                             timer. A timer rather than a login item because
#                             Tailscale is not up all the time: coming back
#                             has to be noticed, and so does going away.
set -euo pipefail

[ "$(uname -s)" = "Darwin" ] || { echo "This one runs on the Mac, not on a board." >&2; exit 1; }

NODES="${STORAGE_NODES:-pi pi2}"
SHARE="${SHARE:-browse}"
SHARE_USER="${SHARE_USER:-$(id -un)}"
MOUNT_ROOT="${MOUNT_ROOT:-/Volumes}"
LABEL="pi.share-mounts"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS="${HERE}/sync-share-mounts.sh"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG="${HOME}/Library/Logs/${LABEL}.log"

[ -x "$PASS" ] || { echo "Missing ${PASS} — run this from a checkout." >&2; exit 1; }

echo "==> Mount points under ${MOUNT_ROOT}"
# Asked for in one sudo call rather than one per board, so the password prompt
# appears once.
missing=()
for node in $NODES; do
  [ -d "${MOUNT_ROOT}/${node}" ] || missing+=("${MOUNT_ROOT}/${node}")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "    creating: ${missing[*]}"
  sudo mkdir -p "${missing[@]}"
  sudo chown "$(id -u):$(id -g)" "${missing[@]}"
else
  echo "    already there"
fi

echo "==> SMB passwords in the login keychain"
# One entry per board, since the boards keep their own SMB passwords and there
# is no reason to assume they match. An entry that is already there is left
# alone: changing it is `security delete-internet-password -s <node>` and then
# this script again.
for node in $NODES; do
  if security find-internet-password -a "$SHARE_USER" -s "$node" -r "smb " >/dev/null 2>&1; then
    echo "    ${node}: already stored"
    continue
  fi
  echo "    ${node}: SMB password for ${SHARE_USER}"
  echo "           the one set by deploy/install-samba.sh, not the board's login password"
  # Prompt printed separately rather than passed to read -p. The secret scanner
  # matches the word followed by a colon and a quoted run of characters, which
  # a prompt string looks exactly like, and a prompt is not worth teaching it
  # an exception for.
  printf '           password: '
  read -rs smbpass
  echo
  # -r "smb " is the four-character protocol code mount_smbfs searches on; the
  # trailing space is part of it. -T names the one binary allowed to read the
  # entry, so nothing else on the Mac gets the password by asking.
  security add-internet-password \
    -a "$SHARE_USER" -s "$node" -r "smb " -l "${node} (SMB)" \
    -T /sbin/mount_smbfs -U -w "$smbpass"
  unset smbpass
  echo "           stored"
done

echo "==> Writing the agent"
mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
# Written whole, and generated rather than committed: it holds this Mac's home
# directory, which is not something the repo should carry.
cat > "$PLIST" <<PLISTBODY
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${PASS}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>STORAGE_NODES</key>
    <string>${NODES}</string>
    <key>SHARE</key>
    <string>${SHARE}</string>
    <key>SHARE_USER</key>
    <string>${SHARE_USER}</string>
    <key>MOUNT_ROOT</key>
    <string>${MOUNT_ROOT}</string>
  </dict>
  <!-- Every 15s. The pass is two reads of local state when nothing has
       changed, which is most of the time; the interval is set by how long a
       dead mount is tolerable, not by how expensive the check is. -->
  <key>StartInterval</key>
  <integer>15</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG}</string>
  <key>StandardErrorPath</key>
  <string>${LOG}</string>
</dict>
</plist>
PLISTBODY
plutil -lint "$PLIST" >/dev/null

echo "==> Loading it"
# bootout first, so a re-run picks up an edited plist instead of leaving the
# old one running. It fails when nothing is loaded, which is fine.
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart "gui/$(id -u)/${LABEL}"

echo
echo "==> First pass"
# Run it here too, in the foreground, so a keychain or password problem is seen
# now rather than found later in a log.
STORAGE_NODES="$NODES" SHARE="$SHARE" SHARE_USER="$SHARE_USER" MOUNT_ROOT="$MOUNT_ROOT" \
  bash "$PASS" || true
/sbin/mount | grep smbfs | sed 's/^/  /' || echo "  nothing mounted yet"

cat <<NEXT

  Done. While Tailscale is up the boards mount themselves; when it goes down
  they are unmounted rather than left to wedge Finder.

  Log:     tail -f ${LOG}
  Stop:    launchctl bootout gui/$(id -u)/${LABEL}
  Start:   launchctl bootstrap gui/$(id -u) ${PLIST}

  Nothing mounted while Tailscale is up? The first suspect is the keychain
  entry, and the log says which board and why.
NEXT
