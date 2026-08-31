#!/usr/bin/env bash
# Shares /srv/browse over SMB so the disks mount in Finder. Run on the board
# holding the disks. Idempotent — safe to re-run.
#
# Tailnet only. `interfaces` plus `bind interfaces only` means smbd never
# listens on the LAN, so there is nothing to find on port 445 from the wifi
# and nothing that would matter if the router were misconfigured. Do not port
# forward this. SMB is not a protocol to expose to the internet.
#
# The config is written whole rather than edited, for the same reason apps.json
# is: the repo is the source of truth and a board-side edit is a thing that
# silently disappears. The original is kept once, on the first run.
set -euo pipefail

BROWSE="${BROWSE:-/srv/browse}"
SHARE_USER="${SHARE_USER:-$(id -un)}"
CONF=/etc/samba/smb.conf
# Tailscale hands out addresses from the carrier-grade NAT range. Nothing on a
# home LAN can hold one, so this allows the tailnet and nothing else.
TAILNET_CIDR="100.64.0.0/10"

if [ ! -d "$BROWSE" ]; then
  echo "$BROWSE does not exist. Run deploy/setup-browse.sh first." >&2
  exit 1
fi

echo "==> Installing samba"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y samba

if [ -f "$CONF" ] && [ ! -f "$CONF.before-pi" ]; then
  echo "==> Keeping the original config at $CONF.before-pi"
  sudo cp "$CONF" "$CONF.before-pi"
fi

echo "==> Writing $CONF"
sudo tee "$CONF" >/dev/null <<CONFIG
# Managed by deploy/install-samba.sh in the PI repo. Edit the repo, not this.

[global]
   workgroup = WORKGROUP
   server string = pi
   server role = standalone server
   security = user
   map to guest = never

   # The whole of the exposure decision is these two lines.
   interfaces = lo tailscale0
   bind interfaces only = yes
   hosts allow = ${TAILNET_CIDR} 127.0.0.1
   hosts deny = 0.0.0.0/0

   # SMB1 is what ransomware worms travel on. There is no client here that
   # needs it; macOS has spoken SMB3 for a decade.
   server min protocol = SMB3
   client min protocol = SMB3

   # macOS interoperability. catia and streams_xattr let resource forks and
   # names with colons survive on ext4; fruit is what stops Finder being slow.
   vfs objects = catia fruit streams_xattr
   fruit:metadata = stream
   fruit:model = MacSamba
   fruit:posix_rename = yes
   fruit:veto_appledouble = no
   fruit:wipe_intentionally_left_blank_rfork = yes
   fruit:delete_empty_adfiles = yes

   logging = file
   log file = /var/log/samba/log.%m
   max log size = 1000

[browse]
   comment = Every disk on pi
   path = ${BROWSE}
   browseable = yes
   read only = no
   valid users = ${SHARE_USER}
   create mask = 0664
   directory mask = 2775
CONFIG

echo "==> Checking the config"
testparm -s >/dev/null

# A Samba password is separate from the Unix one and has to be set explicitly.
# It is typed here, never stored in the repo, and never passed on a command
# line where it would land in shell history.
if sudo pdbedit -L 2>/dev/null | cut -d: -f1 | grep -qx "$SHARE_USER"; then
  echo "==> $SHARE_USER already has an SMB password (change it with: sudo smbpasswd $SHARE_USER)"
else
  echo "==> Set the SMB password for $SHARE_USER"
  echo "    This is what Finder will ask for. It is not the board's login password."
  sudo smbpasswd -a "$SHARE_USER"
fi

echo "==> Starting"
sudo systemctl enable --now smbd
sudo systemctl restart smbd
systemctl is-active smbd

echo
echo "==> Listening on"
ss -tln | grep ':445\b' | sed 's/^/  /' || echo "  port 445 not bound — check: sudo journalctl -u smbd -n 30"
echo
host=$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName":"\([^".]*\)\..*/\1/p' | head -1)
cat <<NEXT

  In Finder:  Go > Connect to Server (Cmd-K)

    smb://${host:-$(hostname)}.<tailnet>.ts.net/browse

  Log in as ${SHARE_USER} with the password just set.

  One share, deliberately. No Time Machine target: backups here are manual.
NEXT
