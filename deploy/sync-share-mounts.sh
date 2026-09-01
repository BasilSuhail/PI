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
#
# Nothing here may block. launchd will not start a second copy of an agent that
# is still running, so a pass that hangs does not miss one beat — it is the last
# pass that ever runs, and it hangs holding the very mount it was supposed to
# clear. Every operation that touches a mount point is therefore either bounded
# or pushed into the background and abandoned.
set -uo pipefail
# Deliberately not -e: one board being unreachable must not skip the other,
# and unmounting a mount that is already gone is an expected failure.

NODES="${STORAGE_NODES:-pi pi2}"
SHARE="${SHARE:-browse}"
# Who to log in to each board as, written by the installer as "pi=pi pi2=pi".
# It is not this Mac's username: `install-samba.sh` takes `valid users` from the
# board's own login name, so mounting as the Mac's user is rejected before the
# password is even looked at.
SHARE_USERS="${SHARE_USERS:-}"
# Under the home directory, not /Volumes, because macOS removes a mount point
# when the mount goes away — including one that was there first, made by hand
# with sudo. /Volumes is root-owned, so once it had been reaped this pass could
# never recreate it, and a share dropped for being wedged would never come
# back. Here the pass owns the directory and can make it whenever it needs one,
# which is why nothing in this arrangement needs privilege at all.
MOUNT_ROOT="${MOUNT_ROOT:-${HOME}/Shares}"
# How long a mount is given to answer before it is treated as dead. Generous:
# the cost of being wrong is unmounting a share that was merely slow, and it is
# remounted on the next pass a few seconds later.
PROBE_TIMEOUT="${PROBE_TIMEOUT:-5}"
# Somewhere to leave a note that a forced unmount is already running, so a
# stuck one is not started again every pass.
WORK="${TMPDIR:-/tmp}/pi-share-mounts"
mkdir -p "$WORK"

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

# Is this mount still answering?
#
# The hard part is that there is no safe way to ask. Every probe tried blocks on
# a wedged path, including `smbutil statshares`, which reads kernel state rather
# than the server and still hung until the mount was forced away by hand. So the
# probe cannot be trusted to return, and this cannot wait for it.
#
# A child does the reading and touches a file if it gets an answer. The parent
# watches the clock and walks away when it runs out, without reaping the child:
# a process blocked in uninterruptible I/O on a dead mount may not die on
# SIGKILL either, and waiting for it to would be the same hang by another route.
# The forced unmount that follows is what actually releases it.
#
# `ls` rather than a stat, because a stat of the mount point is answered from
# the kernel's cache and a directory read is not. Only the round trip proves
# anything.
#
# A child that exits without leaving the file has an answer too — a permission
# error is a live server refusing, not a dead one — so it counts as alive.
answering() {
  local mp="$1" flag child waited=0
  flag="${WORK}/probe.$$.$RANDOM"
  rm -f "$flag"
  ( /bin/ls -f "$mp" >/dev/null 2>&1; : > "$flag" ) &
  child=$!
  while [ "$waited" -lt "$PROBE_TIMEOUT" ]; do
    if [ -e "$flag" ]; then rm -f "$flag"; return 0; fi
    kill -0 "$child" 2>/dev/null || { rm -f "$flag"; return 0; }
    sleep 1
    waited=$((waited + 1))
  done
  kill -9 "$child" 2>/dev/null
  rm -f "$flag"
  return 1
}

# Start a forced unmount and do not wait for it. Three attempts, weakest first:
# a clean unmount is preferred, a server that has vanished will not give one,
# and leaving the mount is worse than forcing it, since every later pass
# inherits the same wedged path.
#
# One at a time per mount point. A forced unmount of something truly stuck can
# take a while — the one that cleared pi2 by hand said `pthread_cond_timeout
# failed; continuing with unmount` before it succeeded — and starting another
# every 15 seconds would pile up processes fighting over the same path.
#
# Returns 1 when one is already in flight, so the caller knows not to say
# anything: the log should record the decision once, not every pass until it
# takes effect.
drop() {
  local mp="$1" lock
  lock="${WORK}/$(printf '%s' "$mp" | tr '/' '_').unmount"
  if [ -f "$lock" ] && kill -0 "$(cat "$lock" 2>/dev/null)" 2>/dev/null; then
    return 1
  fi
  (
    /sbin/umount "$mp" 2>/dev/null \
      || /sbin/umount -f "$mp" 2>/dev/null \
      || /usr/sbin/diskutil unmount force "$mp" >/dev/null 2>&1
    rm -f "$lock"
  ) &
  echo $! > "$lock"
  return 0
}

up=false
tailnet_up && up=true

for node in $NODES; do
  mp="${MOUNT_ROOT}/${node}"

  want=false
  $up && node_online "$node" && want=true

  if $want; then
    if mounted "$mp"; then
      # Mounted and the board is reachable is not the same as working. The
      # session can be dead while the server is perfectly fine — a laptop that
      # changes network, or a wifi drop long enough for the server to forget
      # the session. The mount table still lists it, `tailscale status` still
      # shows the board, and every earlier version of this pass concluded there
      # was nothing to do and left the wedge in place forever. It is the one
      # failure this whole agent exists to prevent.
      answering "$mp" && continue
      if drop "$mp"; then
        log "${mp} stopped answering — forcing it off, will remount next pass"
      fi
      continue
    fi
    # Made here rather than assumed, since the last unmount took it away.
    if ! mkdir -p "$mp" 2>/dev/null; then
      log "cannot create ${mp}"
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
    # Not checked afterwards, because the unmount runs in the background and
    # checking would mean waiting for it. The next pass reports the truth: the
    # mount is either gone from the table or it is not.
    if drop "$mp"; then
      log "unmounting ${mp} ($($up && echo "${node} went offline" || echo "tailnet down"))"
    fi
  fi
done
