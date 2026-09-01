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
#   nothing to create        NetFS makes and removes the mount point itself,
#                             under /Volumes, named after the share. That is
#                             why each board's share carries the board's name.
#   a credential per board    in the login keychain, handed to mount_smbfs on
#                             stdin at mount time. See the note beside it for
#                             why stdin and not the two more obvious channels.
#   a LaunchAgent             which runs deploy/sync-share-mounts.sh on a
#                             timer. A timer rather than a login item because
#                             Tailscale is not up all the time: coming back
#                             has to be noticed, and so does going away.
set -euo pipefail

[ "$(uname -s)" = "Darwin" ] || { echo "This one runs on the Mac, not on a board." >&2; exit 1; }

NODES="${STORAGE_NODES:-jug jug2}"
SHARE="${SHARE:-browse}"
MOUNT_ROOT="${MOUNT_ROOT:-/Volumes}"
LABEL="jug.share-mounts"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS="${HERE}/sync-share-mounts.sh"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG="${HOME}/Library/Logs/${LABEL}.log"

[ -x "$PASS" ] || { echo "Missing ${PASS} — run this from a checkout." >&2; exit 1; }

# The board's login name, not this Mac's. install-samba.sh sets `valid users`
# from whoever runs it on the board, so a share on jug admits jug and refuses
# everyone else — including a Mac account with a different name. Read from the
# ssh config, which already records how to reach each board, so there is one
# place to change it rather than two. SHARE_USER overrides for all boards.
user_for() {
  local u
  if [ -n "${SHARE_USER:-}" ]; then printf '%s' "$SHARE_USER"; return; fi
  u=$(ssh -G "$1" 2>/dev/null | awk '/^user /{print $2; exit}')
  printf '%s' "${u:-$(id -un)}"
}

echo "==> Boards"
USERS=""
for node in $NODES; do
  u="$(user_for "$node")"
  USERS="${USERS}${USERS:+ }${node}=${u}"
  echo "    ${node}: logging in as ${u}"
done

echo "==> SMB passwords in the login keychain"
# Three ways to give mount_smbfs a password, and only one of them is any good.
#
# In the URL, as //user:password@host — it is then in argv, which ps shows to
# every process on this Mac. In ~/Library/Preferences/nsmb.conf — which is what
# `man mount_smbfs` still tells you to do, but macOS 15 no longer reads a
# password from that file, and `smbutil crypt`, which used to scramble the
# value, has been removed too. That was tried here and it silently did nothing.
#
# The third is stdin. mount_smbfs prompts for a password, and a prompt reads
# whatever is on stdin, so a pipe answers it. The password is then in neither
# argv nor a file: it goes from the keychain into a pipe and no further. -N
# must not be used with it, since that suppresses the prompt and the prompt is
# the thing doing the reading.
for pair in $USERS; do
  node="${pair%%=*}"; u="${pair#*=}"
  if security find-internet-password -a "$u" -s "$node" -r "smb " >/dev/null 2>&1; then
    echo "    ${node}: already stored"
    continue
  fi
  echo "    ${node}: SMB password for ${u}"
  echo "           the one set by deploy/install-samba.sh, not the board's login"
  # Prompt printed separately rather than passed to read -p. The secret scanner
  # matches the word followed by a colon and a quoted run of characters, which
  # a prompt string looks exactly like, and a prompt is not worth teaching it
  # an exception for.
  printf '           password: '
  # IFS= matters. Without it read strips leading and trailing whitespace, while
  # smbpasswd on the board uses getpass and keeps every character — so a
  # password with a space at either end would be stored here trimmed and be
  # refused for ever, no matter how carefully it was typed in both places.
  IFS= read -rs smbpass
  echo
  # -r "smb " is the four-character protocol code, trailing space included.
  # -T names the one binary allowed to read the entry back, which is the same
  # `security` the mount pass uses; naming it here is what stops macOS putting
  # a dialog in front of an agent that runs with nobody watching.
  security add-internet-password \
    -a "$u" -s "$node" -r "smb " -l "${node} (SMB)" \
    -T /usr/bin/security -U -w "$smbpass"
  unset smbpass
  echo "           stored"
done

# Storing a password and reading one back are different permissions, and the
# second is the one that matters: the pass runs from an agent, with nobody
# there to click a dialog. Read each entry back now, while there is a person
# watching, so a keychain that will not answer is found here rather than at the
# next time the tailnet drops.
for pair in $USERS; do
  node="${pair%%=*}"; u="${pair#*=}"
  if [ -z "$(security find-internet-password -a "$u" -s "$node" -r "smb " -w 2>/dev/null)" ]; then
    echo "    ${node}: stored, but it cannot be read back without a prompt." >&2
    echo "           The agent has no way to answer one. Fix the entry's access" >&2
    echo "           control in Keychain Access, or delete it and re-run:" >&2
    echo "             security delete-internet-password -a ${u} -s ${node} -r 'smb '" >&2
    exit 1
  fi
done
echo "    all readable without a prompt"

# Earlier versions mounted under ~/Shares. Left alone, those mounts are
# invisible to this pass — it looks for the share under ~/Shares — so it would
# mount the same share a second time, and macOS refuses that with a message
# about the file existing. Take the old one down first.
#
# No sudo: this account mounted it, so this account can unmount it. An empty
# directory left behind in /Volumes is harmless and needs root to remove, so it
# is mentioned rather than tidied.
for node in $NODES; do
  stale="${HOME}/Shares/${node}"
  if /sbin/mount | grep -q " on ${stale} ("; then
    echo "    unmounting the older ${stale}"
    /sbin/umount "$stale" 2>/dev/null || /sbin/umount -f "$stale" 2>/dev/null || true
  fi
  if [ -d "$stale" ] && [ -z "$(ls -A "$stale" 2>/dev/null)" ]; then
    rmdir "$stale" 2>/dev/null && echo "    removed the empty ${stale}"
  fi
done

# The nsmb.conf written by the previous attempt is dead weight: mount_smbfs
# does not read a password from it, so it is a file holding a password in the
# clear for no benefit at all. Put back whatever was there before, or take it
# away — but only if this script is what wrote it.
NSMB="${HOME}/Library/Preferences/nsmb.conf"
if [ -f "$NSMB" ] && head -1 "$NSMB" | grep -q "install-share-mounts.sh"; then
  if [ -f "${NSMB}.before-jug" ]; then
    mv "${NSMB}.before-jug" "$NSMB"
    echo "    removed the nsmb.conf this script wrote, put the original back"
  else
    rm -f "$NSMB"
    echo "    removed the nsmb.conf this script wrote — it held a password for nothing"
  fi
fi

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
    <key>SHARE_USERS</key>
    <string>${USERS}</string>
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
# Run it here too, in the foreground, so a wrong password is seen now rather
# than found later in a log.
STORAGE_NODES="$NODES" SHARE="$SHARE" SHARE_USERS="$USERS" MOUNT_ROOT="$MOUNT_ROOT" \
  bash "$PASS" || true

if /sbin/mount | grep -q smbfs; then
  /sbin/mount | grep smbfs | sed 's/^/  /'
else
  cat >&2 <<'FAILED'
  Nothing mounted.

  "Authentication error" means the password above is not the one the board has.
  Set it again on the board and then re-run this script:

      ssh <node> 'sudo smbpasswd <user>'
FAILED
  exit 1
fi

cat <<NEXT

  Done. While Tailscale is up the boards mount themselves; when it goes down
  they are unmounted rather than left to wedge Finder.

  Log:     tail -f ${LOG}
  Stop:    launchctl bootout gui/$(id -u)/${LABEL}
  Start:   launchctl bootstrap gui/$(id -u) ${PLIST}
NEXT
