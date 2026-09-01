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
#   a credential per board    in ~/Library/Preferences/nsmb.conf, which is what
#                             mount_smbfs reads. See the note above it: this is
#                             a weaker place to keep a password than the
#                             keychain, and it is a deliberate choice.
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
NSMB="${HOME}/Library/Preferences/nsmb.conf"

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

echo "==> Credentials in ${NSMB##*/}"
# Where the password goes, and why it is not the keychain.
#
# mount_smbfs does not read the login keychain. Finder does, through NetFS, but
# the command-line tool reads ~/Library/Preferences/nsmb.conf and nothing else;
# with -N it uses what it finds there and never prompts. That is the whole
# reason this file exists here.
#
# So the password sits in a file, in the clear. Older macOS had `smbutil crypt`
# to scramble it — reversibly, and Apple said as much — and macOS 15 has dropped
# even that. What protects it is mode 0600: only this account can read it.
# Anyone who has this account can already read the files on the share, so the
# password is not the thing standing between them and the data.
#
# Written whole with the original kept once, for the same reason install-samba.sh
# writes smb.conf whole: an edit made here by hand is a thing that silently
# disappears on the next run.
if [ -f "$NSMB" ] && [ ! -f "${NSMB}.before-jug" ]; then
  echo "    keeping the original at ${NSMB}.before-jug"
  cp "$NSMB" "${NSMB}.before-jug"
fi

umask 077
: > "$NSMB"
{
  echo "# Managed by deploy/install-share-mounts.sh in the PI repo."
  echo "# Read by mount_smbfs -N. Mode 0600 — this file holds passwords in the clear."
  echo
} >> "$NSMB"

for pair in $USERS; do
  node="${pair%%=*}"; u="${pair#*=}"
  echo "    ${node}: SMB password for ${u}"
  echo "           the one set by deploy/install-samba.sh, not the board's login"
  # Prompt printed separately rather than passed to read -p. The secret scanner
  # matches the word followed by a colon and a quoted run of characters, which
  # a prompt string looks exactly like, and a prompt is not worth teaching it
  # an exception for.
  printf '           password: '
  read -rs smbpass
  echo
  # Both section spellings, with the same value. The nsmb.conf man page documents
  # [SERVER] and [SERVER:SHARE] and no longer documents a password keyword at all,
  # while mount_smbfs still says it reads one; which spelling wins is not written
  # down anywhere that is currently true. Writing both is one line of duplication
  # in a file that is already 0600, and costs nothing that matters.
  {
    printf '[%s:%s]\npassword=%s\n\n' "$(echo "$node" | tr a-z A-Z)" "$(echo "$u" | tr a-z A-Z)" "$smbpass"
    printf '[%s]\npassword=%s\n\n' "$(echo "$node" | tr a-z A-Z)" "$smbpass"
  } >> "$NSMB"
  unset smbpass
  echo "           stored"
done
chmod 600 "$NSMB"
umask 022

# The first version of this script put the password in the login keychain,
# which mount_smbfs then ignored. Clear the entries out rather than leaving
# something behind that looks like it is doing a job.
for node in $NODES; do
  security delete-internet-password -s "$node" -r "smb " >/dev/null 2>&1 || true
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
