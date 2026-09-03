# PI

Raspberry Pi homelab — build notes, configs, and experiments.

Two boards. `pi` runs the OSINT ingest under Docker Compose; `pi2` is the
k3s control plane and hosts the fleet dashboard. Names follow the storage,
not the silicon.

## What is here

| | |
|---|---|
| `docs/build-log.md` | what was done to each board, in order, with the reasoning and the measured numbers |
| `docs/dashboard.md` | fleet dashboard design and data contract |
| `docs/storage.md` | the browse root, the Storage view, and the Samba shares |
| `agent/` | node agents — Glances plus a Pi-specific shim for power draw and throttle state |
| `dashboard/` | the dashboard itself: `node:http` server, static client, no framework |
| `deploy/` | install scripts run on a board — the dashboard, the services, the disks |
| `k8s/` | manifests applied to the cluster — the dashboard, Uptime Kuma, Vaultwarden, Jellyfin, Kiwix, the Tailscale operator |
| `Makefile` | the deploy commands — `make` on its own lists them |

## The disks

Two rules, and everything else follows from them.

**A drive is a folder.** Open a board's share and you see its drives, named for
what they are. Two disks in pi2 is two folders. Plug a third in and there are
three. Nothing that is not a drive sits beside them.

```
pi2/
├── SSD-1TB/            the 1TB, whole: "1) Archive" first, then the OS
│   ├── 1) Archive/     apps, databases, backups, keys — your data
│   ├── bin/ boot/ etc/ usr/ ...
│   └── srv/
└── HDD-6TB/            the 6TB
    ├── Jellyfin/Media/ films and shows
    ├── Kiwix/          .zim archives
    └── Downloads/
```

**The split is by how a file is read, not by what it is called.** Anything read
at random — settings, databases, caches, artwork — lives on the SSD under
`1) Archive/Apps/`. Anything you would recognise as a file — films, `.zim`
archives, downloads — lives on the 6TB. A database is called data and behaves
like an app: Jellyfin's library index is 50MB and thousands of tiny seeks, and
on a spinning disk it makes the whole interface feel slow.

`1) Archive` is a directory, not a mount or a shortcut. It sorts first because
digits sort before letters. Three earlier attempts put it somewhere clever and
each one made the same files reachable by two paths at once, which is what a
duplicate is.

Issues carry the planning: [#1](../../issues/1) what fits on one board,
[#2](../../issues/2) what a single big box would take,
[#5](../../issues/5) running the two boards as one cluster.

## Deploying

On the Mac. Not on the Pi.

```bash
cd ~/folders/PI
git checkout main && git pull
make bootstrap NODE=pi2    # first time on a board only
make dashboard-k8s          # the dashboard as a k3s Deployment, which is what runs
```

`make dashboard` still installs the old systemd unit and is kept as the way
back. Do not run both: two servers answer on different ports and the tailnet
URL follows whichever `tailscale serve` points at. `make check` says which one
the board is holding.

`make agents` if `agent/` changed. `make` lists the rest.

Details and troubleshooting: [`docs/deploy.md`](docs/deploy.md).

## The services

All on pi2, each on its own tailnet name with a real certificate, all reachable
from a phone. They are tiles in the console's Apps tab, and any of them can be
installed as its own app from a browser — Safari's File, then Add to Dock.

| | | |
|---|---|---|
| Console | `pi2.<tailnet>.ts.net` | the fleet, the files, the launcher |
| Uptime | `uptime.<tailnet>.ts.net` | `make uptime` |
| Vault | `vault.<tailnet>.ts.net` | `make vault` |
| Jellyfin | `jellyfin.<tailnet>.ts.net` | `make media` |
| Kiwix | `kiwix.<tailnet>.ts.net` | `make media` |
| qBittorrent | `torrent.<tailnet>.ts.net` | `make torrent` — off by default |

`make media` also moves every app's files into the layout above: settings on the
SSD under `1) Archive/Apps/`, content on the 6TB. It replaced local-path volumes,
which put the vault in a directory named after a UUID inside k3s' internals —
findable by nobody and backed up by nothing.

<details>
<summary><strong>Storage — one-time setup</strong></summary>

On the Mac. In order. `make archive` and `make automount` reach both boards;
`make samba` asks for a password so it takes one board at a time.

```bash
cd ~/folders/PI
```

```bash
git checkout main && git pull
```

```bash
make bootstrap NODE=pi
```

```bash
make agents
```

```bash
make archive
```

```bash
make automount
```

```bash
make dashboard
```

```bash
ssh pi 'sudo apt-get install -y libvips-tools'
```

```bash
ssh pi2 'sudo apt-get install -y libvips-tools'
```

Then the services, once the Tailscale operator exists — `make uptime` installs
it and everything after that reuses it:

```bash
make uptime
```

```bash
make vault
```

```bash
make media
```

Check it worked:

```bash
curl -s http://pi.<tailnet>.ts.net:9101/files
```

</details>

<details>
<summary><strong>Storage — mounting the disks in Finder</strong></summary>

Optional. Boards first, then the Mac.

```bash
make samba NODE=pi
```

```bash
make samba NODE=pi2
```

```bash
make mounts
```

`make mounts` asks for each board's SMB password once, stores it in the login
keychain, reads it back and refuses to continue if what comes back is not what
you typed. Nothing needs `sudo`. You do not run it again on this Mac unless you
change a board's SMB password.

After that the shares appear in Finder as `pi` and `pi2` whenever Tailscale is
up, and unmount when it goes down — across reboots, sleep and dropped wifi, with
nothing to click.

By hand instead, ⌘K in Finder:

```
smb://pi/pi
```

```
smb://pi2/pi2
```

Check what is mounted:

```bash
mount | grep smbfs
```

Watch what the agent is doing:

```bash
tail -f ~/Library/Logs/pi.share-mounts.log
```

</details>

<details>
<summary><strong>Storage — day to day</strong></summary>

Drag files from Finder onto a column in the console to upload them. Right-click
anything for the same actions the bar offers.

After plugging a drive in, nothing — `make automount` handles it. Only if a
drive was mounted by hand:

```bash
make browse
```

After changing the agent or the dashboard:

```bash
make agents
```

```bash
make dashboard
```

What each does: [`docs/storage.md`](docs/storage.md).

</details>

<details>
<summary><strong>Dashboard — the Tailscale key, and when it dies</strong></summary>

Running in k3s costs one thing that running under systemd did not.

Under systemd the dashboard asked the board's own `tailscale` command which
machines exist. A pod has no tailscaled socket, so it asks Tailscale's web API
instead, and that needs a key. **Tailscale caps those at ninety days.**

When it lapses the fleet empties and `/api/nodes` answers 502. Nothing else
notices: both health checks hit a static page that keeps returning 200, so
Kubernetes reports the pod perfectly healthy the whole time.

So the console shows the date. The Fleet strip carries a tile reading
`Tailscale key`, with the expiry date and the days left. It is grey normally,
orange inside the last two weeks, and red once it has gone.

**Making one.** At [the keys page](https://login.tailscale.com/admin/settings/keys),
under **API access tokens** — not the auth keys above them. Auth keys start
`tskey-auth-` and join devices to a tailnet; this needs `tskey-api-`.

**Replacing it**, when it is close or already gone:

```bash
ssh pi2 'sudo k3s kubectl -n pi delete secret pi-console-tailscale'
```

```bash
make dashboard-k8s
```

It asks for the key and nothing else. The expiry is recorded as ninety days
from today, which is both the longest Tailscale allows and what its form
offers by default, so for a key made a minute earlier it is right.

Chose a shorter one deliberately? Correct it below, or set `TS_EXPIRES` when
running the installer on the board itself.

**Correcting just the date**, without touching the key:

```bash
ssh pi2 'sudo k3s kubectl -n pi patch secret pi-console-tailscale --type merge \
  -p "{\"stringData\":{\"expires\":\"2027-01-31\"}}"'
```

```bash
ssh pi2 'sudo k3s kubectl -n pi rollout restart deployment/pi-console'
```

The restart is needed either way: the date arrives as an environment variable,
and a running pod does not see a Secret change.

**What is stored.** The key and the date live in one Secret, `pi-console-tailscale`
in the `pi` namespace. The key is never echoed, never written to the board's
disk, and never passed on a command line the console builds. The date is not a
secret and is only there because Tailscale will not tell a token its own expiry.

</details>

<details>
<summary><strong>Uptime Kuma — alerts when something dies</strong></summary>

```bash
make uptime
```

Puts Uptime Kuma on pi2 at its own tailnet name, `https://uptime.<tailnet>.ts.net`,
so it does not have to share the console's URL. Roughly 100 MB.

**Once, in the Tailscale admin console, before the first run.** The operator
registers machines on your tailnet, so it needs its own credentials:

1. Access Controls: add tag owners for `tag:k8s-operator` and `tag:k8s`.
2. Settings, then OAuth clients, then Generate. Give it **write** scope on
   Devices Core and on Auth Keys, tagged `tag:k8s-operator`.

`make uptime` asks for the client ID and secret once and puts them straight
into a Secret. Neither is echoed and neither lands on the board's disk.

**Once, in Discord, for alerts.** Uptime Kuma can show red on a page, but it
cannot reach you without somewhere to send to:

1. Pick or make a channel for alerts.
2. Gear icon next to the channel, then Integrations, then Webhooks.
3. New Webhook, name it, then Copy Webhook URL.

**Then, in Uptime Kuma itself.** The first visit asks you to create an admin
account. After that, Settings, then Notifications, then Setup Notification,
choose Discord, paste the URL, hit Test, and tick Default enabled so new
monitors use it without being asked.

The webhook is a credential and belongs only in Kuma's own settings. It never
goes in this repo.

**Worth monitoring**: the OSINT API and news page, both boards' Glances agents
on port 61208, the console itself, and the shim on 9101.

</details>

<details>
<summary><strong>Vaultwarden — a copy of the password vault</strong></summary>

```bash
make vault
```

Needs `make uptime` first, which installs the Tailscale operator this uses to
get a name of its own. Lands at `https://vault.<tailnet>.ts.net`, roughly
40 MB.

**What this is, and is not.** Bitwarden's own service stays the source of
truth and is not touched. This holds a copy, imported once and left alone.
Nothing syncs between them, so the copy drifts the moment a password changes
in one and not the other.

A Bitwarden client points at one server at a time, so the two do not fight:
keep the browser extension and desktop app on bitwarden.com as they are, and
use Vaultwarden through its own web page.

**After the deploy, in this order:**

1. Open the URL and create an account. Use a different master password: this
   is not the vault you already have.
2. In Bitwarden, Tools, Export vault, format `.json`. Here, Tools, Import
   data, "Bitwarden (json)". Delete the export afterwards, it is plain text.
3. Close registration:

```bash
ssh pi2 'sudo k3s kubectl -n pi patch configmap vaultwarden-config \
  --type merge -p "{\"data\":{\"SIGNUPS_ALLOWED\":\"false\"}}"'
```

```bash
ssh pi2 'sudo k3s kubectl -n pi rollout restart deployment/vaultwarden'
```

**What a JSON export leaves behind:** file attachments, Sends, and password
history. Everything else, TOTP codes included, comes across.

**Where it lives.** `1) Archive/Apps/Vaultwarden/` on pi2's SSD — visible in
Finder, copyable like anything else. It used to be a local-path volume in a
directory named after a UUID inside k3s' internals, which is a bad place for
the most important file on the board: you cannot back up what you cannot find.

**There is still no backup of it.** Findable is not the same as backed up.
Worth remembering before anything is written here that exists nowhere else.

</details>

<details>
<summary><strong>qBittorrent — downloads, behind AirVPN</strong></summary>

```bash
make torrent
```

Installs **stopped**. Two containers in one pod sharing one network namespace:
gluetun brings up WireGuard and owns the routing, qBittorrent has no network of
its own. That shared namespace is the whole point — the client cannot be
configured around the VPN, cannot fall back to the board's connection, and
cannot send a packet before the tunnel exists, because there is no other route
for it to take.

It is also why the VPN is not separately switchable. A toggle that could leave
the client running with the tunnel down is the exact failure this shape makes
impossible, so the two start and stop together.

**Nothing here touches the board's networking.** The WireGuard interface lives
in the pod's namespace; the Pi's routing table, and tailscaled with it, are in a
different one and never see it. A VPN installed on the board itself would take
the default route and drop Tailscale — the console, the shares and SSH with it.

**Before the first run**, from AirVPN's Client Area:

1. Config Generator, choose WireGuard and a server. You need the `[Interface]`
   PrivateKey, the `[Peer]` PresharedKey, and the `[Interface]` Address.
2. Ports, and reserve one. Traffic only reaches the client on a port AirVPN is
   forwarding; without one it downloads but seeds poorly.

`make torrent` asks for those four and puts them straight into a Secret.
Nothing is echoed and nothing lands on the board's disk. Eddie is not involved
— this is a separate device on the same subscription and uses one of the plan's
connection slots.

**Turning it on.** The console's Apps tab, the qBittorrent tile, the power
switch on it. Works from a phone; there is no terminal step. The tile shows
the address traffic is actually leaving from, read from gluetun rather than
inferred from the pod being up — "running" and "protected" are different
claims and only the second one matters.

`make torrent-on` and `make torrent-off` do the same from the Mac. They exist
so the button stays optional: the console's permission to press it is a single
RoleBinding, and deleting it leaves both commands working.

**What the button can do, and cannot.** The console has been read-only against
the cluster until this. The grant is a `Role` in one namespace, on
`deployments/scale`, for one deployment by name. The subresource is the part
doing the work: write access to a *deployment* would let a compromised console
add a privileged container with the host filesystem mounted and take the board,
while `scale` accepts one integer and refuses everything else.

**Where downloads go.** `/data/Downloads` in the client, which is
`HDD-6TB/Downloads` in Finder. The add-torrent form shows that path and lets
you change it per torrent — anywhere under `/data`, which is the whole 6TB.
Incomplete files sit beside the finished ones rather than staging on the SSD,
so completing a download is a rename inside one filesystem and never a copy.

The whole 6TB is mounted for the same reason: a finished download is
hard-linked into place, and a hard link cannot cross a mount boundary. Two
mounts would mean a 40GB film costing 80GB for as long as it kept seeding.

**First login.** qBittorrent 5 does not ship a default password. It generates
one and prints it to its log:

```bash
ssh pi2 'sudo k3s kubectl -n pi logs deploy/qbittorrent -c qbittorrent | grep -i password'
```

</details>

## Scope

- **Kubernetes** — k3s on ARM, and where an orchestrator is not worth it
- **Clustering** — multi-node Pi setup, networking, storage
- **Homelab** — self-hosted services, monitoring
- **Hardware** — boards, HATs, cooling, boot media

## Status

k3s on pi2 with the console on it as a Deployment behind Traefik. Agents on
both boards. Live over Tailscale.

pi2 carries a 1TB SSD and a 6TB HDD on a Waveshare PCIe SATA HAT, on its own
12V supply. Both appear as folders in Finder and as their own meters on the
console's node card. `make sata NODE=pi2` reports the port, the controller and
whether the controller is actually switched on — a hot-plugged drive once left
it disabled while looking perfectly healthy — without changing anything.

Jellyfin, Kiwix, Vaultwarden and Uptime Kuma are running, each on its own
tailnet name, each with its settings on the SSD and its content on the 6TB.

Everything is one disk deep. There is no backup of anything yet, the vault
included, and that is the next thing worth solving.

pi has not had the cgroup flag applied, so its `mem_limit`s are unenforced and
container memory reads blank on the console.
