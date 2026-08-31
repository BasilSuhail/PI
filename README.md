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

## Deploying

From the Mac, from a checkout of `main`. Tailscale has to be up — a hang or an
unresolvable hostname is always that (`tailscale status`, then `tailscale up`).
Both boards prompt for a password; key auth is off by choice. Every script is
idempotent, so re-running one costs nothing but time.

After merging a PR:

```bash
cd ~/folders/PI
git checkout main && git pull
```

Then run whichever matches what changed.

**Dashboard** — anything under `dashboard/` or `deploy/`, launcher tiles
included. Takes a few minutes; it builds on the board.

```bash
rsync -a --delete --exclude node_modules --exclude dist dashboard/ jug2:~/dashboard/
scp deploy/install-dashboard.sh jug2:~/
ssh jug2 'bash ~/install-dashboard.sh'
```

**Agents** — anything under `agent/`.

```bash
rsync -a agent/ jug:~/agent/  && ssh jug  'bash ~/agent/install.sh'
rsync -a agent/ jug2:~/agent/ && ssh jug2 'bash ~/agent/install.sh'
```

**Then check it worked.**

```bash
ssh jug2 'systemctl is-active jug-console glances pi-metrics'
ssh jug  'systemctl is-active glances pi-metrics'
curl -s -o /dev/null -w 'dashboard: %{http_code}\n' https://jug2.taild9f605.ts.net/api/nodes
```

Three `active` on jug2, two on jug, `200` from the dashboard.

One-time setup, why these commands are shaped this way, and what to do when a
deploy goes wrong: [`docs/deploy.md`](docs/deploy.md).

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
