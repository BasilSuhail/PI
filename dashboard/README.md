# Pi

Fleet dashboard for the boards. Design and rationale: [`docs/dashboard.md`](../docs/dashboard.md).

Activity Monitor for the fleet — every machine on the tailnet, whether or not it
is in the cluster — plus a launcher for the self-hosted services.

## Layout

```
shared/fleet.ts        the contract, used by both halves
server/
  index.ts             node:http — static files + four API routes
  apps.ts              launcher config and health probes
  apps.json            editable without a rebuild (or set APPS_CONFIG)
  lib/tailnet.ts       discovery: Tailscale API, or the local CLI
  lib/glances.ts       cpu, mem, fs, net, processes, containers
  lib/shim.ts          power and throttle from pi-metrics
  lib/kube.ts          cluster membership — labels nodes, never discovers them
  lib/fleet.ts         aggregation
client/
  src/App.tsx          window chrome, view switching, polling
  src/components/      FleetView, DetailView, AppsView, primitives
  src/lib/format.ts    raw numbers to human strings
  src/lib/api.ts       fetch layer, polling hook, temperature history
  src/index.css        the design
```

## Running

```bash
pnpm install
pnpm build
pnpm start          # :8080
```

Development runs the two halves separately — Vite proxies `/api` to the server:

```bash
pnpm dev:server     # :8080
pnpm dev            # :5173
```

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | no | default 8080 |
| `TAILSCALE_API_KEY` | see below | node discovery |
| `TAILSCALE_TAILNET` | no | defaults to `-`, the key's own tailnet |
| `KUBE_API_SERVER`, `KUBE_TOKEN` | no | cluster role labels |
| `APPS_CONFIG` | no | path to the launcher config |

**Discovery needs one of two things.** With `TAILSCALE_API_KEY` set it queries
the Tailscale API, which works anywhere including inside a pod. Without it, it
shells out to the local `tailscale` CLI — which works when the dashboard runs
directly on a node, and needs no key at all.

Kubernetes access is optional on purpose. A dashboard that stops working when
the cluster is down is useless exactly when it is wanted; without it, every node
simply reads `standalone`.

## Icons

`client/public/icon.svg` is the artwork. Everything else is rendered from it or
from a variant in `client/icons-src/`, and must be regenerated when it changes:

```bash
cd client
rsvg-convert -w 192 -h 192 public/icon.svg        -o public/icon-192.png
rsvg-convert -w 512 -h 512 public/icon.svg        -o public/icon-512.png
rsvg-convert -w 180 -h 180 icons-src/apple-touch.svg -o public/apple-touch-icon.png
rsvg-convert -w 512 -h 512 icons-src/maskable.svg    -o public/icon-maskable-512.png
```

Two of them are not resized copies, which is why the variants exist.
`apple-touch.svg` is square and full-bleed: iOS applies its own rounded mask, and
shipping our corners inside it leaves white slivers at the edges. `maskable.svg`
draws the same art smaller, because Android crops maskable icons to a circle
inscribed in the middle 80% of the square.

`icons-src/` sits outside `public/`, so the sources are versioned without being
served.

## Node states

| State | Meaning | UI |
|---|---|---|
| `online: false` | not seen on the tailnet recently | resting, not an error |
| `online: true` + `error` | on the tailnet, agents silent | needs attention |
| `online: true`, no error | healthy | full card |

## Things learned from live agents

Each of these was a bug found by pointing the client at a real node.

- **`uptime` is a string**, `"0:44:03"` or `"3 days, 2:15:09"` — not a number.
- **`os_version` is the kernel**; `hr_name` is a full description string.
- **`platform` is bitness** (`"64bit"`), not machine architecture.
- **Virtual interfaces dominate.** A box running six containers reports nine
  interfaces. Their traffic is already counted on the physical one.
- **CPU samples can arrive uninitialised.** Glances computes CPU as a delta
  since the previous request, so requests close together produce a window near
  zero and a sample where `total` and `idle` are both `0`. Retrying makes it
  worse. A short last-known-good cache covers it.
- **Container memory reads `0B`** on a node without `cgroup_enable=memory`.
  Names, status and CPU still work.

## Origin

The design came from a Manus scaffold. The stylesheet, layout and view structure
were kept as authored; the scaffold around them — tRPC, Drizzle, MySQL, OAuth,
S3, LLM and voice endpoints, Google Maps, 52 unused shadcn components, Tailwind,
wouter, react-query — was removed, along with the sample data the views rendered.
Roughly ninety dependencies became ten.
