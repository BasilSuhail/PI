# Dashboard

Running log for the fleet dashboard. Design first, then decisions as they get made.

**What it is:** one page showing every machine on the tailnet — load, memory, temperature, power, processes, containers — plus a launcher for the self-hosted apps. Activity Monitor for the fleet, not for one box.

**Split:** frontend by Basil. Backend, agents and deployment here.

---

## The requirement that shapes everything

Machines get added. A third Pi, a mini PC, whatever comes next. The dashboard has to pick them up **without a config edit or a redeploy**.

That rules out a hardcoded node list, and it rules out asking Kubernetes for its nodes — because jug1 is not in the cluster and may never be. Asking k8s would miss the busiest machine in the house.

**Tailscale is the source of truth.** Every machine worth watching is on the tailnet, cluster member or not.

```
tailscale status --json  →  device list
                              │
                              └─ probe each for an agent
                                 answers → render its card
                                 silent  → render offline
```

Cluster membership becomes a label, not a gate: `kubectl get nodes` decides whether a node shows as `control-plane`, `worker`, or `standalone`.

---

## Three screens

### Fleet

Default view, phone-first. One card per node.

```
┌─────────────────────────┐  ┌─────────────────────────┐
│ ● jug          8GB      │  │ ● jug2        16GB      │
│   standalone            │  │   control-plane         │
│   CPU  ▓▓▓▓░░░░░░  38%  │  │   CPU  ▓░░░░░░░░░   2%  │
│   RAM  ▓▓▓▓▓▓░░░░  64%  │  │   RAM  ▓░░░░░░░░░   5%  │
│   52°C    6.1W          │  │   44°C    4.3W          │
│   up 12d                │  │   up 22m                │
└─────────────────────────┘  └─────────────────────────┘
```

Answers without tapping: up, hot, busy, throttling.

### Node detail

The simpler-htop view.

- Per-core CPU bars, load average
- Memory split: used / cache / free / swap
- Temperature with a short sparkline
- **Throttle banner** when `get_throttled` is non-zero — the Pi-specific failure that otherwise goes unnoticed
- Power draw (Pi 5 only)
- Disks per mount, network per interface
- Process table — PID, name, CPU%, RAM, sortable
- Container table — Docker on jug1, pods on jug2

### Apps

Launcher tiles with a live health dot per service.

---

## Data contract

Frontend builds against this. Backend guarantees it.

```ts
GET /api/nodes
[{
  id, name, tailscaleIp, online, lastSeen,
  role: "control-plane" | "worker" | "standalone",
  model, os, arch, kernel, uptimeSec,
  cpu:  { cores, usagePct, perCore: number[], loadAvg: [number,number,number] },
  mem:  { totalBytes, usedBytes, availableBytes, usedPct, swapTotalBytes, swapUsedBytes },
  temp: { cpuC, throttled: { now, everSinceBoot, reasons: string[] } | null },
  power: { watts, rails: { name, volts, amps }[] } | null,
  disks: [{ mount, device, totalBytes, usedBytes, usedPct }],
  net:   [{ iface, rxBps, txBps }],
  capabilities: ("power" | "throttle" | "containers")[]
}]

GET /api/nodes/:id/processes?limit=30
GET /api/nodes/:id/containers
GET /api/apps
```

Two rules the design has to respect:

1. **`capabilities` decides what renders.** A generic Linux box has no `power`. A card must look right with tiles missing, not broken.
2. **`online: false` is normal, not an error.** A board being off is an ordinary state and should not look like a failure.

---

## Where the numbers come from

| Metric | Source | Notes |
|---|---|---|
| CPU, load | `/proc/stat` | |
| Memory, swap | `/proc/meminfo` | |
| Processes | `/proc/*/stat` | |
| Disk | `/proc/diskstats`, statfs | |
| Network | `/proc/net/dev` | |
| Temperature | `/sys/class/thermal/thermal_zone0/temp` | |
| Containers | Docker socket / k8s API | **jug1 reads `0B` until the cgroup flag is applied** |
| Power (W) | `vcgencmd pmic_read_adc` | **Pi 5 only.** Per-rail volts × amps, summed. Real measurement, not an estimate. |
| Throttling | `vcgencmd get_throttled` | Pi only. Bitmask: undervoltage, freq capped, thermal. |

Rows 1–7 come free from **Glances** in server mode (`glances -w --disable-webui`, ~70MB) as JSON at `/api/4/all`. Glances knows nothing about `vcgencmd`, so the two Pi-specific rows need a small shim (~15MB) on its own endpoint.

Non-Pi machines run Glances alone. The dashboard omits their power tile via `capabilities`. Degrades cleanly.

### Why Glances rather than a custom agent

A hand-written agent would be ~15MB against Glances' ~70. The 55MB buys per-process and per-container detail that would otherwise be hand-maintained across every machine added, forever. jug1 has roughly 2GB free; it can afford the difference.

Revisit if a node ever turns up where 70MB genuinely matters.

---

## Deployment

Dashboard runs **in k3s on jug2** rather than as a plain container. jug2 has ~14GB free, and it makes the dashboard a real workload to practise Deployment, Service and Ingress on instead of `nginx`.

`make dashboard-k8s`, from the Mac. Six objects in `k8s/dashboard.yaml`: Namespace, ServiceAccount, ClusterRoleBinding, Deployment, Service, Ingress. `MemoryMax=256M` from the systemd unit becomes `resources.limits.memory`, which jug2 actually enforces because its cgroups are on.

Three things about it are not obvious:

- **No registry, and nothing to push to.** jug2 builds its own image with buildkit, run with `--oci-worker=false --containerd-worker=true` so its worker is k3s' own containerd. The image is written directly into the `k8s.io` namespace the kubelet reads — no tar, no copy, no second container runtime on the board, and no other machine involved in a deploy. `buildkitd` and `buildctl` are 102MB installed and the daemon is **not** enabled at boot: it runs for the length of a build and is stopped afterwards, because RAM is the scarce thing here and disk is not. The tag is the commit: reusing a tag under `imagePullPolicy: IfNotPresent` leaves the old image in place and reports success.
- **Node discovery changes hands.** Under systemd the server shells out to the local `tailscale` CLI. A pod has no tailscaled socket, so it uses the Tailscale API and needs `TAILSCALE_API_KEY` in a Secret. **API keys expire — 90 days at most.** When one does, `/api/nodes` returns 502 and the page says so rather than quietly emptying.
- **Cluster credentials get simpler, not harder.** The systemd install writes a token into `/etc/jug-console.env`. A pod needs neither: kubelet sets `KUBERNETES_SERVICE_HOST` and projects a token for the ServiceAccount, and `kube.ts` reads that when the environment carries nothing.

`dial.ts` needed no change. It rewrites a machine's own tailnet address to loopback, which was the fix for #84, and a pod's interfaces never match a tailnet address so the rewrite simply stops applying. Measured from a pod on jug2: jug1 over the tailnet, jug2 over its LAN address, and jug2's own tailnet address all answered, the last in 0.06s.

Reachable at `https://jug2.<tailnet>.ts.net` via `tailscale serve` — real certificate, tailnet-only, no open ports, works on a phone with no VPN client beyond Tailscale itself.

---

## Order

- [x] Glances on both boards, confirm JSON
- [ ] cgroup flag on jug1 — needed regardless, and container stats read `0B` without it
- [x] Pi-metrics shim: power + throttle
- [x] Backend: tailnet discovery, node aggregation, the contract above
- [x] Frontend (Basil)
- [x] Deploy, `tailscale serve`, verify on phone
- [x] Health checks behind the apps launcher
- [ ] Point `server/apps.json` at the real services — two placeholders today
- [x] Move it into k3s — the exercise, not a fix. `make dashboard-k8s`; `make dashboard` still installs the systemd unit.

## As built

| | |
|---|---|
| Client | 218KB, 68KB gzipped |
| Server | 14KB, `node:http`, no runtime dependencies |
| Dependencies | 10, down from ~90 in the scaffold |
| Reachable at | `https://jug2.<tailnet>.ts.net`, tailnet-only, real certificate |
| Runs as | systemd unit on jug2, capped `MemoryMax=256M` |

Discovery falls back to the local `tailscale` CLI when no API key is set, which is the path in use — running on a node, no key needed. The API key path exists for when this moves into a pod, which has no daemon socket.

## Open questions, resolved

- **Retention.** Live only. Sparklines keep a short in-memory buffer per node, lost on reload. History past a reboot would need a store on the server and has not been worth it.
- **Poll interval.** 3s for the fleet, 5s for the process and container tables, 15s for app health. Not configurable yet.
- **Auth.** Tailnet-only is the whole of it. Anyone on the tailnet is already trusted with more than this.
