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

Everything runs from the Mac, from a checkout of `main`. `jug` is jug1, `jug2`
is jug2. Both prompt for a password — key auth is off by choice.

Tailscale must be connected first. If a command hangs or says the hostname
cannot be resolved, that is what it is:

```bash
tailscale status          # "Tailscale is stopped" means the tunnel is down
tailscale up
```

### After merging a PR

```bash
cd ~/folders/PI
git checkout main && git pull
```

Then run only the section below that matches what changed. Every script is
idempotent — re-running one costs nothing but time.

### Dashboard — `dashboard/` or `deploy/` changed

```bash
cd ~/folders/PI
rsync -a --delete --exclude node_modules --exclude dist dashboard/ jug2:~/dashboard/
scp deploy/install-dashboard.sh jug2:~/
ssh jug2 'bash ~/install-dashboard.sh'
```

It builds on the board, which takes a few minutes — the boards are arm64 and
cross-building from the Mac buys nothing.

Copy the installer every time rather than running the one already on jug2. It
carries the migrations, and an old copy is how the service ended up broken
twice. The `--exclude dist` matters too: the node builds its own, and shipping
a Mac-built one would be shipping the wrong architecture.

### Agents — `agent/` changed

```bash
cd ~/folders/PI
rsync -a agent/ jug:~/agent/  && ssh jug  'bash ~/agent/install.sh'
rsync -a agent/ jug2:~/agent/ && ssh jug2 'bash ~/agent/install.sh'
```

The whole directory, not just the script: it installs `pi-metrics.py` and
`pi-metrics.service` from alongside itself.

### Launcher tiles — `dashboard/server/apps.json` changed

This one does **not** travel with a normal deploy. The installer seeds
`apps.json` on first install and then leaves it alone, so tiles corrected on the
node are not reverted every time the dashboard is updated. That also means a
tile added here has to be pushed deliberately:

```bash
cd ~/folders/PI
scp dashboard/server/apps.json jug2:/tmp/apps.json
ssh jug2 'sudo cp /tmp/apps.json /opt/jug-console/dist/apps.json && sudo systemctl restart jug-console'
```

No rebuild — the file is read at runtime, so the restart is only to pick it up
immediately.

### Archive tree — once, on jug2

```bash
cd ~/folders/PI
scp deploy/setup-archive.sh jug2:~/
ssh jug2 'bash ~/setup-archive.sh'
```

### Exposing the dashboard — once, already done

```bash
ssh jug2 'sudo tailscale serve --bg 8080'
```

Reachable at `https://jug2.taild9f605.ts.net` — tailnet-only, real certificate,
no open ports.

### Check it worked

```bash
ssh jug2 'systemctl is-active jug-console glances pi-metrics'
ssh jug  'systemctl is-active glances pi-metrics'
curl -s -o /dev/null -w 'dashboard: %{http_code}\n' https://jug2.taild9f605.ts.net/api/nodes
```

Three `active` on jug2, two on jug, and `200` from the dashboard.

### When something is wrong

```bash
ssh jug2 'journalctl -u jug-console -n 40 --no-pager'
ssh jug  'journalctl -u glances -n 40 --no-pager'
```

`active` with nothing listening means the process started and exited without a
traceback — check the port before believing the unit:

```bash
ssh jug2 'ss -lntp | grep -E "8080|61208|9101"'
```

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
