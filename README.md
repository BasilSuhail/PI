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
| `agent/` | node agents — Glances plus a Pi-specific shim for power draw and throttle state |
| `dashboard/` | the dashboard itself: `node:http` server, static client, no framework |
| `deploy/` | installs the dashboard as a service on a node |
| `Makefile` | the deploy commands — `make` on its own lists them |

Issues carry the planning: [#1](../../issues/1) what fits on one board,
[#2](../../issues/2) what a single big box would take,
[#5](../../issues/5) running the two boards as one cluster.

## Deploying

**Every command here runs on the Mac**, from `~/folders/PI`. You never SSH into
a board yourself — `make` opens the connection, and the script it starts runs
on the board and builds there. Tailscale has to be up on the Mac; a hang or an
unresolvable hostname is always that:

```bash
tailscale status          # "Tailscale is stopped" means the tunnel is down
tailscale up
```

Each command asks for the board's password once — key auth is off by choice.

### Once per board, ever

```bash
cd ~/folders/PI
make bootstrap NODE=jug2
make bootstrap NODE=jug
```

This gives the board a read-only deploy key and its own checkout of this repo
at `~/PI`, so a deploy becomes the board pulling from GitHub instead of the Mac
pushing files at it. Re-running is safe; it verifies rather than replaces.

### Every time a PR is merged

```bash
cd ~/folders/PI
make dashboard   # dashboard/ or deploy/ changed — launcher tiles included
make agents      # agent/ changed — both boards
make deploy      # both of the above
make check       # services up, dashboard answering
```

`make` on its own lists them. Each target takes the board to exactly
`origin/main`, then builds and installs there, printing the commit it landed on
before the build starts. Nothing is copied from the Mac, so what runs on the
board is what is on `main` — the Mac's own checkout does not even have to be up
to date. Pull on the Mac to get new `make` targets, not new code. Every script
is idempotent; re-running one costs nothing but time.

One-time setup, the fallback for when a board cannot reach GitHub, and what to
do when a deploy does not take: [`docs/deploy.md`](docs/deploy.md).

## Scope

- **Kubernetes** — k3s on ARM, and where an orchestrator is not worth it
- **Clustering** — multi-node Pi setup, networking, storage
- **Homelab** — self-hosted services, monitoring
- **Hardware** — boards, HATs, cooling, boot media

## Status

k3s running on jug2. Agents on both boards. Dashboard live over Tailscale.

The 8TB is still blocked on a 12V supply, which holds up the whole archive
tier. jug1 has not had the cgroup flag applied, so its `mem_limit`s are
unenforced and container memory reads blank on the dashboard.
