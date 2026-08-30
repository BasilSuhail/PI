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

  return fs.map((d) => ({
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

export const fetchProcesses = async (host: string, limit = 30): Promise<ProcessRow[]> => {
  const procs = await get<Array<{
    pid?: number;
    name?: string;
    cmdline?: string[];
    username?: string;
    cpu_percent?: number;
    memory_percent?: number;
    memory_info?: { rss?: number };
  }>>(host, 'processlist');
  if (!Array.isArray(procs)) return [];

  return procs
    .map((p) => ({
      pid: p.pid ?? 0,
      name: p.name ?? '?',
      cmdline: p.cmdline?.length ? p.cmdline.join(' ') : null,
      user: p.username ?? null,
      cpuPct: round(p.cpu_percent ?? 0),
      memBytes: p.memory_info?.rss ?? 0,
      memPct: round(p.memory_percent ?? 0),
    }))
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
    engine?: string;
  }>>(host, 'containers');
  if (!Array.isArray(raw)) return [];

  return raw.map((c) => ({
    name: c.name ?? '?',
    image: Array.isArray(c.image) ? c.image[0] : (c.image ?? null),
    status: c.status ?? 'unknown',
    cpuPct: c.cpu?.total != null ? round(c.cpu.total) : null,
    memBytes: c.memory?.usage ?? null,
    source: (c.engine === 'podman' ? 'docker' : 'docker') as 'docker' | 'kubernetes',
  }));
};
