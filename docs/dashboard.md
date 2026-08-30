# Dashboard

Running log for the fleet dashboard. Design first, then decisions as they get made.

**What it is:** one page showing every machine on the tailnet — load, memory, temperature, power, processes, containers — plus a launcher for the self-hosted apps. Activity Monitor for the fleet, not for one box.

**Split:** frontend by the operator. Backend, agents and deployment here.

---

## The requirement that shapes everything

Machines get added. A third Pi, a mini PC, whatever comes next. The dashboard has to pick them up **without a config edit or a redeploy**.

That rules out a hardcoded node list, and it rules out asking Kubernetes for its nodes — because pi1 is not in the cluster and may never be. Asking k8s would miss the busiest machine in the house.

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
│ ● pi          8GB      │  │ ● pi2        16GB      │
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
- Container table — Docker on pi1, pods on pi2

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
| Containers | Docker socket / k8s API | **pi1 reads `0B` until the cgroup flag is applied** |
| Power (W) | `vcgencmd pmic_read_adc` | **Pi 5 only.** Per-rail volts × amps, summed. Real measurement, not an estimate. |
| Throttling | `vcgencmd get_throttled` | Pi only. Bitmask: undervoltage, freq capped, thermal. |

Rows 1–7 come free from **Glances** in server mode (`glances -w --disable-webui`, ~70MB) as JSON at `/api/4/all`. Glances knows nothing about `vcgencmd`, so the two Pi-specific rows need a small shim (~15MB) on its own endpoint.

Non-Pi machines run Glances alone. The dashboard omits their power tile via `capabilities`. Degrades cleanly.

### Why Glances rather than a custom agent

A hand-written agent would be ~15MB against Glances' ~70. The 55MB buys per-process and per-container detail that would otherwise be hand-maintained across every machine added, forever. pi1 has roughly 2GB free; it can afford the difference.

Revisit if a node ever turns up where 70MB genuinely matters.

---

## Deployment

Dashboard runs **in k3s on pi2** rather than as a plain container. pi2 has ~14GB free, and it makes the dashboard a real workload to practise Deployment, Service and Ingress on instead of `nginx`.

Reachable at `https://pi2.<tailnet>.ts.net` via `tailscale serve` — real certificate, tailnet-only, no open ports, works on a phone with no VPN client beyond Tailscale itself.

---

## Order

- [ ] Glances on both boards, confirm JSON
- [ ] cgroup flag on pi1 — needed regardless, and container stats read `0B` without it
- [ ] Pi-metrics shim: power + throttle
- [ ] Backend: tailnet discovery, node aggregation, the contract above
- [ ] Frontend (the operator)
- [ ] Deploy to k3s, `tailscale serve`, verify on phone
- [ ] Health checks behind the apps launcher

## Open questions

- Retention. Live-only is simplest and costs nothing. Sparklines need a short buffer — in memory is fine for minutes, a real store only if history past a reboot ever matters.
- Poll interval. 2s feels live; 5s is kinder to pi1. Probably configurable per client.
- Auth. Tailnet-only access may be sufficient. Anyone on the tailnet is already trusted with more than this.
