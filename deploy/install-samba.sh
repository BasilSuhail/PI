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

# Bind by address, not by interface name. Samba resolves a named interface
# through its own detection, which skips point-to-point devices that have no
# broadcast address — precisely what a Tailscale tun device is. Given
# "tailscale0" it silently binds whatever is left, which is lo, and then the
# share is unreachable from anywhere while the install reports success.
TS_IP=$(tailscale ip -4 2>/dev/null | head -1 || true)
if [ -z "$TS_IP" ]; then
  echo "This board has no Tailscale IPv4 address. Bring tailscale up first." >&2
  exit 1
fi

if [ ! -d "$BROWSE" ]; then
  echo "$BROWSE does not exist. Run deploy/setup-browse.sh first." >&2
  exit 1
fi

echo "==> Installing samba"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y samba

if [ -f "$CONF" ] && [ ! -f "$CONF.before-jug" ]; then
  echo "==> Keeping the original config at $CONF.before-jug"
  sudo cp "$CONF" "$CONF.before-jug"
fi

echo "==> Writing $CONF"
sudo tee "$CONF" >/dev/null <<CONFIG
# Managed by deploy/install-samba.sh in the PI repo. Edit the repo, not this.

[global]
   workgroup = WORKGROUP
   server string = jug
   server role = standalone server
   security = user
   map to guest = never

   # The whole of the exposure decision is these two lines.
   #
   # The netmasks are load-bearing. A bare address here is a lookup, matched
   # against the interfaces Samba's own enumeration found — and that
   # enumeration never sees the Tailscale tun device, so the entry is silently
   # dropped and smbd binds localhost alone. An address with a netmask is a
   # definition, used as given, which is the documented way to name an
   # interface Samba cannot discover for itself.
   interfaces = 127.0.0.1/8 ${TS_IP}/32
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
   comment = Every disk on jug
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

# The samba package enables a domain controller, a NetBIOS name service and a
# domain user lookup daemon. None are wanted: the tailnet resolves names by
# DNS, there is no domain, and this board shares 8GB with an ingest workload.
echo "==> Disabling the services samba brings that are not wanted here"
for unit in samba-ad-dc nmbd winbind; do
  sudo systemctl disable --now "$unit" 2>/dev/null || true
done

# smbd binds its addresses at startup, so at boot it has to come up after the
# address exists. Without this the share is unreachable until something
# restarts it by hand.
echo "==> Making smbd wait for tailscaled"
sudo mkdir -p /etc/systemd/system/smbd.service.d
sudo tee /etc/systemd/system/smbd.service.d/after-tailscale.conf >/dev/null <<'UNIT'
[Unit]
After=tailscaled.service
Wants=tailscaled.service
UNIT
sudo systemctl daemon-reload

echo "==> Starting"
sudo systemctl enable --now smbd
sudo systemctl restart smbd
systemctl is-active smbd

echo
echo "==> Listening on"
ss -tln | grep ':445\b' | sed 's/^/  /' || true
# Being bound somewhere is not the test. Being bound on the tailnet is, and
# this is the check that would have caught the lo-only bind.
if ss -tln | grep -q "${TS_IP}:445"; then
  echo "  reachable on the tailnet at ${TS_IP}"
else
  # Say why, rather than leaving a person to go and find out. These three
  # together answer it: what Samba was told, what Samba believes it has, and
  # what the kernel actually has.
  {
    echo
    echo "  NOT bound on ${TS_IP} — Finder will not connect."
    echo
    echo "  smb.conf says:"
    testparm -s --parameter-name=interfaces 2>/dev/null | sed 's/^/    /'
    echo "  samba sees these interfaces:"
    smbd -b 2>/dev/null | grep -i interface | sed 's/^/    /' || true
    net usershare info >/dev/null 2>&1 || true
    echo "  the kernel has these addresses:"
    ip -o -4 addr show | awk '{print "    " $2 "  " $4}'
    echo
    echo "  Last words from smbd:"
    journalctl -u smbd -n 15 --no-pager 2>/dev/null | sed 's/^/    /'
  } >&2
  exit 1
fi
echo
host=$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName":"\([^".]*\)\..*/\1/p' | head -1)
cat <<NEXT

  In Finder:  Go > Connect to Server (Cmd-K)

    smb://${host:-$(hostname)}.taild9f605.ts.net/browse

  Log in as ${SHARE_USER} with the password just set.

  One share, deliberately. No Time Machine target: backups here are manual.
NEXT
