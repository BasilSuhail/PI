#!/usr/bin/env bash
# One pass at making the Finder mounts match what the tailnet can reach right
# now: mount what is missing, unmount what has gone stale. Runs on the Mac, on
# an interval, from the agent that deploy/install-share-mounts.sh sets up.
#
# Nothing is remembered between passes. The mount table and `tailscale status`
# are the two sources of truth; a third opinion kept in a file here would only
# be one more thing to go stale.
#
# Nothing here may block. launchd will not start a second copy of an agent that
# is still running, so a pass that hangs does not miss one beat — it is the last
# pass that ever runs, and it hangs holding the very mount it was supposed to
# clear. Every operation that touches a mount point is therefore either bounded
# or pushed into the background and abandoned.
#
# Mounting goes through NetFS, not mount_smbfs. mount_smbfs takes a password
# from a terminal and nothing else: it opens /dev/tty and ignores stdin, so it
# works when a person is sitting there to type and never works from an agent.
# That is not a detail — it is the whole reason an earlier version of this file
# logged an authentication error every fifteen seconds for hours while the
# stored password was perfectly correct. NetFS takes the credential as a
# parameter, which is what an unattended mount needs.
set -uo pipefail
# Deliberately not -e: one board being unreachable must not skip the other, and
# unmounting a mount that is already gone is an expected failure.

NODES="${STORAGE_NODES:-jug jug2}"
SHARE_USERS="${SHARE_USERS:-}"
# NetFS names the mount after the share, and nothing can talk it out of that —
# so the share on each board is named after the board. See install-samba.sh.
MOUNT_ROOT="${MOUNT_ROOT:-/Volumes}"
PROBE_TIMEOUT="${PROBE_TIMEOUT:-5}"
MOUNT_TIMEOUT="${MOUNT_TIMEOUT:-25}"
WORK="${TMPDIR:-/tmp}/jug-share-mounts"
mkdir -p "$WORK"

TS=""
for candidate in \
  /usr/local/bin/tailscale \
  /Applications/Tailscale.app/Contents/MacOS/Tailscale \
  /opt/homebrew/bin/tailscale
do
  [ -x "$candidate" ] && { TS="$candidate"; break; }
done

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# Said once, then not again until it changes. A permanent condition repeating at
# timer rate buries the events the log exists to record.
say_once() {
  local key="$1"; shift
  local file="${WORK}/said.$(printf '%s' "$key" | tr -c 'A-Za-z0-9' '_')"
  local now="$*"
  [ -f "$file" ] && [ "$(cat "$file" 2>/dev/null)" = "$now" ] && return
  printf '%s' "$now" > "$file"
  log "$now"
}
forget() { rm -f "${WORK}/said.$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '_')"; }

if [ -z "$TS" ]; then
  say_once notailscale "no tailscale binary found — cannot tell whether the tailnet is up"
  exit 1
fi

tailnet_up() { "$TS" status >/dev/null 2>&1; }

node_online() {
  local row
  row=$("$TS" status 2>/dev/null | awk -v n="$1" '$2 == n { print; exit }')
  [ -n "$row" ] && [[ "$row" != *offline* ]]
}

# The share carries the board's name, so the mount point does too.
point_for() { printf '%s/%s' "$MOUNT_ROOT" "$1"; }

mounted() { /sbin/mount | grep -q " on $(point_for "$1") ("; }

user_for() {
  local pair
  for pair in $SHARE_USERS; do
    [ "${pair%%=*}" = "$1" ] && { printf '%s' "${pair#*=}"; return; }
  done
  printf '%s' "$(id -un)"
}

# `security -w` prints the password as a hex dump, with no marker and no
# warning, whenever it holds a byte outside printable ASCII. Anything that used
# that output would authenticate with the literal string "6122..." and be
# refused for ever, which is a failure with nothing in it to suggest a cause.
#
# `-g` is unambiguous: it writes `password: 0x...` for the hex case and
# `password: "..."` otherwise, so the two can be told apart rather than guessed
# at — a password of nothing but hex digits is a perfectly ordinary password.
password_for() {
  local shown hex
  shown=$(security find-internet-password -g -a "$2" -s "$1" -r "smb " 2>&1 >/dev/null \
    | sed -n 's/^password: //p')
  case "$shown" in
    0x*)
      hex=${shown#0x}
      hex=${hex%% *}
      printf '%s' "$hex" | xxd -r -p
      ;;
    *)
      security find-internet-password -a "$2" -s "$1" -r "smb " -w 2>/dev/null || true
      ;;
  esac
}

# Is this mount still answering?
#
# There is no safe way to ask. Every probe blocks on a wedged path, including
# `smbutil statshares`, which reads kernel state rather than the server and still
# hung until the mount was forced away by hand. So a child does the reading and
# touches a file if it gets an answer, and the parent watches the clock and
# walks away when it runs out — without reaping the child, since a process
# blocked in uninterruptible I/O may not die on SIGKILL either. The forced
# unmount that follows is what actually releases it.
#
# `ls` rather than a stat: a stat of the mount point is answered from the
# kernel's cache and a directory read is not. A child that exits without leaving
# the file has answered too — a permission error is a live server refusing.
answering() {
  local mp="$1" flag child waited=0
  flag="${WORK}/probe.$$.$RANDOM"
  rm -f "$flag"
  ( /bin/ls -f "$mp" >/dev/null 2>&1; : > "$flag" ) &
  child=$!
  while [ "$waited" -lt "$PROBE_TIMEOUT" ]; do
    [ -e "$flag" ] && { rm -f "$flag"; return 0; }
    kill -0 "$child" 2>/dev/null || { rm -f "$flag"; return 0; }
    sleep 1
    waited=$((waited + 1))
  done
  kill -9 "$child" 2>/dev/null
  rm -f "$flag"
  return 1
}

# Start a forced unmount and do not wait for it. One at a time per mount point:
# a forced unmount of something truly stuck can take a while, and starting
# another every fifteen seconds would pile up processes fighting over the path.
# Returns 1 when one is already running, so the caller says nothing.
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

# Mount through NetFS. The script is fed to osascript on stdin rather than named
# on its command line, so the password is not in argv where ps would show it to
# every process on this Mac, and it is never written to disk.
#
# Quotes and backslashes are escaped because the password lands inside an
# AppleScript string literal; without that, a password containing either would
# produce a script that does not compile, and the mount would fail for a reason
# having nothing to do with the credential.
#
# Bounded and abandoned, like everything else here: NetFS puts a dialog up when
# it does not like an answer, and a dialog in an agent nobody is watching is a
# wait with no end.
netfs_mount() {
  local node="$1" user="$2" pw="$3" out rc
  pw=${pw//\\/\\\\}
  pw=${pw//\"/\\\"}
  out="${WORK}/mount.$$.$RANDOM"
  (
    printf 'try\n  mount volume "smb://%s/%s" as user name "%s" with password "%s"\n  return "ok"\non error e number n\n  return "err " & n & ": " & e\nend try\n' \
      "$node" "$node" "$user" "$pw" | /usr/bin/osascript - > "$out" 2>&1
  ) &
  local child=$! waited=0
  while [ "$waited" -lt "$MOUNT_TIMEOUT" ]; do
    kill -0 "$child" 2>/dev/null || break
    sleep 1
    waited=$((waited + 1))
  done
  if kill -0 "$child" 2>/dev/null; then
    kill -9 "$child" 2>/dev/null
    rm -f "$out"
    printf 'timed out after %ss' "$MOUNT_TIMEOUT"
    return 1
  fi
  rc=$(cat "$out" 2>/dev/null); rm -f "$out"
  [ "$rc" = "ok" ] && return 0
  printf '%s' "${rc:-no answer from NetFS}"
  return 1
}

up=false
tailnet_up && up=true

for node in $NODES; do
  mp="$(point_for "$node")"

  want=false
  $up && node_online "$node" && want=true

  if $want; then
    if mounted "$mp"; then
      # Mounted and reachable is not the same as working. A session can be dead
      # while the server is fine, and the mount table still lists it.
      answering "$mp" && { forget "mount-$node"; continue; }
      drop "$mp" && log "${mp} stopped answering — forcing it off, will remount next pass"
      continue
    fi
    u="$(user_for "$node")"
    pw="$(password_for "$node" "$u")"
    if [ -z "$pw" ]; then
      say_once "mount-$node" "no keychain entry for ${u}@${node} — run: make mounts"
      continue
    fi
    if err=$(netfs_mount "$node" "$u" "$pw"); then
      forget "mount-$node"
      log "mounted ${node} at ${mp}"
    else
      say_once "mount-$node" "could not mount ${node}: ${err}"
    fi
    unset pw
  else
    mounted "$mp" || continue
    # Not checked afterwards: the unmount runs in the background and checking
    # would mean waiting for it. The next pass reports what actually happened.
    drop "$mp" && log "unmounting ${mp} ($($up && echo "${node} went offline" || echo "tailnet down"))"
  fi
done
