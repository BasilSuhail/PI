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
| `deploy/` | installs the dashboard as a service on a node |
| `k8s/` | manifests applied to the cluster — the dashboard, Uptime Kuma, the Tailscale operator |
| `Makefile` | the deploy commands — `make` on its own lists them |

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

**There is no backup of this volume.** Worth remembering before anything is
written here that exists nowhere else.

</details>

## Scope

- **Kubernetes** — k3s on ARM, and where an orchestrator is not worth it
- **Clustering** — multi-node Pi setup, networking, storage
- **Homelab** — self-hosted services, monitoring
- **Hardware** — boards, HATs, cooling, boot media

## Status

k3s running on pi2, with the dashboard on it as a Deployment behind Traefik.
Agents on both boards. Live over Tailscale.

The disks already attached are browsable from the console and mountable in
Finder — neither waits on the 8TB, which is still blocked on a 12V supply and
still holds up the archive tier proper.

pi has not had the cgroup flag applied, so its `mem_limit`s are unenforced
and container memory reads blank on the dashboard.
