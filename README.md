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

Issues carry the planning: [#1](../../issues/1) what fits on one board,
[#2](../../issues/2) what a single big box would take,
[#5](../../issues/5) running the two boards as one cluster.

## Running

Node agents, on each board:

```bash
bash agent/install.sh
```

Dashboard, on the board that should host it:

```bash
bash deploy/install-dashboard.sh
sudo tailscale serve --bg 8080
```

Reachable at `https://<node>.<tailnet>.ts.net` — tailnet-only, real
certificate, no open ports.

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
