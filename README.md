# PI

Raspberry Pi homelab — build notes, configs, and experiments.

Two boards. `pi1` runs the OSINT ingest under Docker Compose; `pi2` is the
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
| `k8s/` | manifests applied to the cluster — read-only node access for the dashboard |
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
make dashboard
```

`make agents` if `agent/` changed. `make check` to confirm. `make` lists the rest.

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

## Scope

- **Kubernetes** — k3s on ARM, and where an orchestrator is not worth it
- **Clustering** — multi-node Pi setup, networking, storage
- **Homelab** — self-hosted services, monitoring
- **Hardware** — boards, HATs, cooling, boot media

## Status

k3s running on pi2. Agents on both boards. Dashboard live over Tailscale.

The disks already attached are browsable from the console and mountable in
Finder — neither waits on the 8TB, which is still blocked on a 12V supply and
still holds up the archive tier proper.

pi1 has not had the cgroup flag applied, so its `mem_limit`s are unenforced
and container memory reads blank on the dashboard.
