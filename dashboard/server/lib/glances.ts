/**
 * Glances REST API client (API v4).
 *
 * Targeted plugin fetches rather than /api/4/all — the process list is large
 * and only wanted on the node detail screen, not on every fleet poll.
 */

import type { CpuStats, DiskStats, MemStats, NetStats, ProcessRow } from '../../shared/fleet';

export const GLANCES_PORT = 61208;

// A saturated node answers its first request in ~1.2s; later ones in ~250ms.
// 3s was not enough headroom when a dozen sub-requests land at once.
const TIMEOUT_MS = 6000;

const get = async <T>(host: string, plugin: string): Promise<T | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`http://${host}:${GLANCES_PORT}/api/4/${plugin}`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/** Glances reports percentages; per-core values live under cpucore/percpu. */
export const fetchCpu = async (host: string): Promise<CpuStats | null> => {
  const [cpu, percpu, load] = await Promise.all([
    get<CpuSample>(host, 'cpu'),
    get<Array<{ total?: number }>>(host, 'percpu'),
    get<{ min1?: number; min5?: number; min15?: number }>(host, 'load'),
  ]);
  if (!cpu) return null;

  const perCore = Array.isArray(percpu) ? percpu.map((c) => round(c.total ?? 0)) : [];

  const stats: CpuStats = {
    cores: cpu.cpucore ?? perCore.length,
    usagePct: round(cpu.total ?? 0),
    perCore,
    loadAvg: [round(load?.min1 ?? 0), round(load?.min5 ?? 0), round(load?.min15 ?? 0)],
  };

  // Glances computes CPU as a delta since the previous request rather than
  // from its own refresh timer, so two requests close together produce a
  // near-zero window and a sample where total and idle are both 0 — impossible
  // on a running system. Retrying does not help; the retry is itself a short
  // window. Serve the last good reading instead, and only briefly: a node that
  // keeps returning stale samples should show 0 rather than a frozen number.
  if (isStale(cpu)) {
    const previous = lastGoodCpu.get(host);
    if (previous && Date.now() - previous.at < STALE_FALLBACK_MS) {
      return { ...previous.stats, loadAvg: stats.loadAvg };
    }
    return stats;
  }

  lastGoodCpu.set(host, { stats, at: Date.now() });
  return stats;
};

interface CpuSample {
  total?: number;
  idle?: number;
  cpucore?: number;
}

const isStale = (c: CpuSample) => (c.total ?? 0) === 0 && (c.idle ?? 0) === 0;

/** Beyond this, a stale reading stops being worth showing. */
const STALE_FALLBACK_MS = 30_000;

const lastGoodCpu = new Map<string, { stats: CpuStats; at: number }>();

export const fetchMem = async (host: string): Promise<MemStats | null> => {
  const [mem, swap] = await Promise.all([
    get<{ total?: number; used?: number; available?: number; percent?: number }>(host, 'mem'),
    get<{ total?: number; used?: number }>(host, 'memswap'),
  ]);
  if (!mem?.total) return null;

  return {
    totalBytes: mem.total,
    usedBytes: mem.used ?? 0,
    availableBytes: mem.available ?? 0,
    usedPct: round(mem.percent ?? 0),
    swapTotalBytes: swap?.total ?? 0,
    swapUsedBytes: swap?.used ?? 0,
  };
};

export const fetchDisks = async (host: string): Promise<DiskStats[]> => {
  const fs = await get<Array<{
    mnt_point?: string;
    device_name?: string;
    size?: number;
    used?: number;
    percent?: number;
  }>>(host, 'fs');
  if (!Array.isArray(fs)) return [];

  // One row per physical device. A bind mount is the same filesystem seen at a
  // second path, and Glances reports it as a second entry with identical size
  // and usage — /srv/browse/archive alongside /. Summing those double-counted
  // every board's capacity, so pi read 937GB when it holds 468.
  //
  // The shallowest mount point wins, which is the real one rather than the
  // bind: / beats /srv/browse/archive.
  const byDevice = new Map<string, (typeof fs)[number]>();
  for (const d of fs) {
    const device = d.device_name ?? '?';
    const seen = byDevice.get(device);
    const depth = (d.mnt_point ?? '').split('/').length;
    if (!seen || depth < (seen.mnt_point ?? '').split('/').length) byDevice.set(device, d);
  }

  return [...byDevice.values()].map((d) => ({
    mount: d.mnt_point ?? '?',
    device: d.device_name ?? '?',
    totalBytes: d.size ?? 0,
    usedBytes: d.used ?? 0,
    usedPct: round(d.percent ?? 0),
  }));
};

export const fetchNet = async (host: string): Promise<NetStats[]> => {
  const net = await get<Array<{
    interface_name?: string;
    bytes_recv_rate_per_sec?: number;
    bytes_sent_rate_per_sec?: number;
  }>>(host, 'network');
  if (!Array.isArray(net)) return [];

  return net
    .filter((n) => n.interface_name && isRealInterface(n.interface_name))
    .map((n) => ({
      iface: n.interface_name as string,
      rxBps: Math.round(n.bytes_recv_rate_per_sec ?? 0),
      txBps: Math.round(n.bytes_sent_rate_per_sec ?? 0),
    }));
};

/**
 * Glances returns uptime as a human string, not a number:
 *   "0:44:03"  or  "3 days, 2:15:09"
 */
export const parseUptime = (raw: unknown): number | null => {
  if (typeof raw !== 'string') return null;

  const m = raw.match(/^(?:(\d+)\s+days?,\s*)?(\d+):(\d{2}):(\d{2})$/);
  if (!m) return null;

  const [, days, hours, mins, secs] = m;
  return (
    Number(days ?? 0) * 86400 +
    Number(hours) * 3600 +
    Number(mins) * 60 +
    Number(secs)
  );
};

/**
 * Docker creates a veth pair per container and a bridge per network, so a box
 * running six containers reports eight interfaces. Their traffic is already
 * counted on the physical interface it leaves by, so showing them both adds
 * noise and double-counts.
 *
 * Excluded: loopback, tailscale, docker bridges, veth pairs, k8s CNI
 * interfaces, and bridges.
 */
const VIRTUAL_IFACE = /^(lo|tailscale|docker|veth|br-|cni|flannel|cali|kube|virbr|vnet)/;

export const isRealInterface = (name: string) => !VIRTUAL_IFACE.test(name);

export const fetchSystem = async (host: string) => {
  const [sys, uptime] = await Promise.all([
    get<{
      os_name?: string;
      platform?: string;
      linux_distro?: string;
      os_version?: string;
    }>(host, 'system'),
    get<unknown>(host, 'uptime'),
  ]);
  return {
    os: sys?.linux_distro ?? sys?.os_name ?? null,
    // Glances reports bitness here ("64bit"), not the machine architecture.
    arch: sys?.platform ?? null,
    kernel: sys?.os_version ?? null,
    uptimeSec: parseUptime(uptime),
  };
};

interface RawProcess {
  pid?: number;
  name?: string;
  cmdline?: string[];
  username?: string;
  cpu_percent?: number;
  cpu_times?: { user?: number; system?: number };
  memory_percent?: number;
  memory_info?: { rss?: number };
  num_threads?: number;
  io_counters?: number[];
}

/**
 * Per-process CPU, averaged over the gap between polls.
 *
 * Glances' own `cpu_percent` is a spot sample taken over however long it has
 * been since that process was last looked at, which makes it unusable here.
 * Worst affected is Glances itself: it samples its own process immediately
 * after doing the work of building the process list, so it measures its own
 * measurement burst over a very short window. Observed at 98% and 210% of a
 * core on two idle boards whose true cost, taken from cumulative CPU time over
 * two minutes, was 0.54% and 0.07%.
 *
 * `cpu_times` is cumulative and does not have this problem. The difference
 * between two readings, over the real elapsed time, is the honest average.
 */
const cpuHistory = new Map<string, Map<number, { cpuSec: number; at: number; pct: number }>>();

/** Below this the divisor is small enough to inflate the result — the exact
 *  failure being fixed. Two clients polling at once produce such a gap. */
const MIN_WINDOW_MS = 1000;

const cpuPctOf = (host: string, p: RawProcess, now: number): number => {
  const pid = p.pid ?? 0;
  const times = p.cpu_times;
  // Without cumulative time there is nothing better than the spot sample.
  if (!times) return round(p.cpu_percent ?? 0);

  let seen = cpuHistory.get(host);
  if (!seen) cpuHistory.set(host, (seen = new Map()));

  const cpuSec = (times.user ?? 0) + (times.system ?? 0);
  const prev = seen.get(pid);

  // First sighting, or a pid reused by a younger process: the spot sample is
  // all there is. One poll later there is a real window to divide by.
  if (!prev || cpuSec < prev.cpuSec) {
    const pct = round(p.cpu_percent ?? 0);
    seen.set(pid, { cpuSec, at: now, pct });
    return pct;
  }

  const elapsed = now - prev.at;
  if (elapsed < MIN_WINDOW_MS) return prev.pct;

  const pct = round(Math.max(0, (100 * (cpuSec - prev.cpuSec)) / (elapsed / 1000)));
  seen.set(pid, { cpuSec, at: now, pct });
  return pct;
};

export const fetchProcesses = async (host: string, limit = 30): Promise<ProcessRow[]> => {
  const procs = await get<RawProcess[]>(host, 'processlist');
  if (!Array.isArray(procs)) return [];

  const now = Date.now();
  const rows = procs.map((p) => ({
    pid: p.pid ?? 0,
    name: p.name ?? '?',
    cmdline: p.cmdline?.length ? p.cmdline.join(' ') : null,
    user: p.username ?? null,
    cpuPct: cpuPctOf(host, p, now),
    memBytes: p.memory_info?.rss ?? 0,
    memPct: round(p.memory_percent ?? 0),
    threads: p.num_threads ?? 0,
    // Glances returns [read_bytes, write_bytes, ...]; index 0 is what we show.
    diskReadBytes: p.io_counters?.[0] ?? 0,
  }));

  // Processes that have exited would otherwise accumulate for the life of the
  // server. The full list is walked above, so what is missing here has gone.
  const live = new Set(rows.map((r) => r.pid));
  const seen = cpuHistory.get(host);
  if (seen) for (const pid of seen.keys()) if (!live.has(pid)) seen.delete(pid);

  return rows
    .sort((a, b) => b.cpuPct - a.cpuPct || b.memBytes - a.memBytes)
    .slice(0, limit);
};

export const isReachable = async (host: string): Promise<boolean> =>
  (await get<unknown>(host, 'now')) !== null;

const round = (n: number) => Math.round(n * 10) / 10;

/** Glances reads the Docker socket itself, so container stats need no extra agent. */
export const fetchContainers = async (host: string) => {
  const raw = await get<Array<{
    name?: string;
    image?: string[] | string;
    status?: string;
    cpu?: { total?: number };
    memory?: { usage?: number };
  }>>(host, 'containers');
  if (!Array.isArray(raw)) return [];

  return raw.map((c) => ({
    name: c.name ?? '?',
    image: Array.isArray(c.image) ? c.image[0] : (c.image ?? null),
    status: c.status ?? 'unknown',
    cpuPct: c.cpu?.total != null ? round(c.cpu.total) : null,
    memBytes: c.memory?.usage ?? null,
  }));
};
