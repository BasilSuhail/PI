# PI

Raspberry Pi homelab — build notes, configs, and experiments.

Two boards. `jug1` runs the OSINT ingest under Docker Compose; `jug2` is the
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
| `Makefile` | the deploy commands — `make` on its own lists them |

Issues carry the planning: [#1](../../issues/1) what fits on one board,
[#2](../../issues/2) what a single big box would take,
[#5](../../issues/5) running the two boards as one cluster.

## Deploying

On the Mac. Not on the Pi.

```bash
cd ~/folders/PI
git checkout main && git pull
make bootstrap NODE=jug2    # first time on a board only
make dashboard
```

`make agents` if `agent/` changed. `make check` to confirm. `make` lists the rest.

Details and troubleshooting: [`docs/deploy.md`](docs/deploy.md).

<details>
<summary><strong>Storage — one-time setup</strong></summary>

On the Mac. Every command, in order.

```bash
cd ~/folders/PI
```

```bash
make bootstrap NODE=jug
```

```bash
make agents
```

```bash
make browse
```

```bash
ssh jug 'sudo apt-get install -y libvips-tools'
```

```bash
ssh jug2 'sudo apt-get install -y libvips-tools'
```

Check it worked:

```bash
curl -s http://jug.taild9f605.ts.net:9101/files
```

Optional, for Finder:

```bash
make samba NODE=jug
```

```bash
make samba NODE=jug2
```

After adding a disk, only this:

```bash
make browse
```

What each does: [`docs/storage.md`](docs/storage.md).

</details>

## Scope

- **Kubernetes** — k3s on ARM, and where an orchestrator is not worth it
- **Clustering** — multi-node Pi setup, networking, storage
- **Homelab** — self-hosted services, monitoring
- **Hardware** — boards, HATs, cooling, boot media

## Status

k3s running on jug2. Agents on both boards. Dashboard live over Tailscale.

The disks already attached are browsable from the console and mountable in
Finder — neither waits on the 8TB, which is still blocked on a 12V supply and
still holds up the archive tier proper.

jug1 has not had the cgroup flag applied, so its `mem_limit`s are unenforced
and container memory reads blank on the dashboard.
