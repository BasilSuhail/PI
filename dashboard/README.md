# Fleet dashboard — backend

Design and data contract: [`docs/dashboard.md`](../docs/dashboard.md).

Backend, agents and deployment live here. The frontend is the operator's and builds
against `src/types/fleet.ts`.

## Layout

```
src/types/fleet.ts     the contract — start here
src/lib/tailnet.ts     node discovery via the Tailscale API
src/lib/glances.ts     Glances REST client (cpu, mem, fs, net, procs, containers)
src/lib/shim.ts        pi-metrics client (power, throttle)
src/lib/kube.ts        cluster membership — labels nodes, never discovers them
src/lib/fleet.ts       aggregation into FleetNode[]
src/app/api/…          route handlers
```

## Endpoints

| | |
|---|---|
| `GET /api/nodes` | every tailnet Linux node, online or not |
| `GET /api/nodes/:id/processes?limit=30` | sorted by CPU |
| `GET /api/nodes/:id/containers` | Docker containers, via Glances |

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `TAILSCALE_API_KEY` | yes | node discovery. Without it `/api/nodes` returns 502. |
| `TAILSCALE_TAILNET` | no | defaults to `-` (the key's own tailnet) |
| `KUBE_API_SERVER` | no | cluster role labels. Absent → every node reads `standalone`. |
| `KUBE_TOKEN` | no | as above |

Both Kubernetes variables are optional by design. A dashboard that stops
working when the cluster is down would be useless exactly when it is wanted.

## Three states a node can be in

| State | Meaning | UI |
|---|---|---|
| `online: false` | not seen on the tailnet recently | resting state, not an error |
| `online: true`, `error` set | on the tailnet, agents silent | needs attention — agent down |
| `online: true`, no error | healthy | full card |

## Not yet built

- `GET /api/apps` — the launcher, with per-service health checks
- Dockerfile and k8s manifests
- Frontend

## Note on pi1

Its container stats will read `0B` until the cgroup flag is applied there and
the board is rebooted. Same fix already applied to pi2; see the build log.
