#!/usr/bin/env bash
# One pass at making the Finder mounts match what the tailnet can reach right
# now: mount what is missing, unmount what has gone stale. Runs on the Mac,
# on an interval, from the agent that deploy/install-share-mounts.sh sets up.
#
# Nothing is remembered between passes. The mount table and `tailscale status`
# are the two sources of truth; a third opinion kept in a file here would only
# be one more thing to go stale.
#
# The unmount half matters more than the mount half. An SMB mount whose server
# has gone is not inert — Finder blocks on it, and so does anything that walks
# the filesystem. Dropping the mount the moment the tailnet goes is the point
# of running this on a timer rather than once at login.
set -uo pipefail
# Deliberately not -e: one board being unreachable must not skip the other,
# and unmounting a mount that is already gone is an expected failure.

NODES="${STORAGE_NODES:-jug jug2}"
SHARE="${SHARE:-browse}"
# Who to log in to each board as, written by the installer as "jug=jug jug2=jug".
# It is not this Mac's username: `install-samba.sh` takes `valid users` from the
# board's own login name, so mounting as the Mac's user is rejected before the
# password is even looked at.
SHARE_USERS="${SHARE_USERS:-}"
# /Volumes is where macOS expects network mounts, and where Finder puts them in
# the sidebar. The directories are made once, by the installer, with sudo;
# nothing here needs privilege.
MOUNT_ROOT="${MOUNT_ROOT:-/Volumes}"

# launchd hands an agent a near-empty PATH, so the tools are named in full.
# Tailscale ships as a CLI under /usr/local/bin from the standalone package and
# inside the bundle from the App Store build. Either is fine; neither is on the
# agent's PATH.
TS=""
for candidate in \
  /usr/local/bin/tailscale \
  /Applications/Tailscale.app/Contents/MacOS/Tailscale \
  /opt/homebrew/bin/tailscale
do
  [ -x "$candidate" ] && { TS="$candidate"; break; }
done

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# Quiet on the happy path. This runs every few seconds and logs only when it
# changes something, so the log is a list of events rather than a heartbeat.

if [ -z "$TS" ]; then
  log "no tailscale binary found — cannot tell whether the tailnet is up"
  exit 1
fi

# `tailscale status` exits non-zero when the daemon is stopped or logged out,
# which is exactly the question being asked.
tailnet_up() { "$TS" status >/dev/null 2>&1; }

# A peer that is powered off still has a row, marked offline. Reading the row
# is cheaper and far faster than waiting for a mount attempt to time out.
node_online() {
  local row
  row=$("$TS" status 2>/dev/null | awk -v n="$1" '$2 == n { print; exit }')
  [ -n "$row" ] && [[ "$row" != *offline* ]]
}

mounted() { /sbin/mount | grep -q " on ${1} ("; }

# Falls back to this Mac's username, which is wrong on this setup but is the
# only guess available if the installer did not write a mapping. The mount then
# fails with an authentication error, which is what the log will say.
user_for() {
  local pair
  for pair in $SHARE_USERS; do
    [ "${pair%%=*}" = "$1" ] && { printf '%s' "${pair#*=}"; return; }
  done
  printf '%s' "$(id -un)"
}

# One entry per board in the login keychain, written by the installer. Printed
# with a trailing newline because that is what a prompt expects to read.
#
# A miss prints nothing, and the empty line that follows is refused by the
# board — which is the right shape of failure. Guessing at a password, or
# falling back to prompting, would be worse.
password_for() {
  local pw
  pw=$(security find-internet-password -a "$2" -s "$1" -r "smb " -w 2>/dev/null) || pw=""
  printf '%s\n' "$pw"
}

# Three attempts, weakest first. A clean unmount is preferred; a server that
# has vanished will not give one, and leaving the mount is worse than forcing
# it, since every later pass inherits the same wedged path.
unmount() {
  /sbin/umount "$1" 2>/dev/null \
    || /sbin/umount -f "$1" 2>/dev/null \
    || /usr/sbin/diskutil unmount force "$1" >/dev/null 2>&1
}

up=false
tailnet_up && up=true

for node in $NODES; do
  mp="${MOUNT_ROOT}/${node}"

  want=false
  $up && node_online "$node" && want=true

  if $want; then
    mounted "$mp" && continue
    if [ ! -d "$mp" ]; then
      log "${mp} does not exist — run deploy/install-share-mounts.sh"
      continue
    fi
    # The password goes in on stdin, which is the only channel that keeps it out
    # of everything: not in the argv that ps shows, not in a file on disk. The
    # keychain hands it over here and nowhere else.
    #
    # No -N. That flag suppresses the prompt, and the prompt is what reads
    # stdin — with it, the pipe is ignored and the mount fails with no password
    # at all. An empty read is safe: mount_smbfs takes the blank line, the
    # board refuses it, and the pass logs an authentication error instead of
    # waiting for input that is never coming.
    u="$(user_for "$node")"
    if err=$(password_for "$node" "$u" | /sbin/mount_smbfs "//${u}@${node}/${SHARE}" "$mp" 2>&1); then
      log "mounted ${node} at ${mp}"
    else
      log "could not mount ${node}: ${err}"
    fi
  else
    mounted "$mp" || continue
    unmount "$mp"
    if mounted "$mp"; then
      log "could not unmount ${mp} — something still has it open"
    else
      log "unmounted ${mp} ($($up && echo "${node} went offline" || echo "tailnet down"))"
    fi
  fi
done
