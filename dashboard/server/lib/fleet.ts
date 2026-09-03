/**
 * Aggregation. Turns tailnet devices plus agent responses into the FleetNode
 * contract the frontend consumes.
 */

import type { Capability, FleetNode, ProcessRow } from '../../shared/fleet';
import { fetchClusterRoles } from './kube';
import { fetchCpu, fetchDisks, fetchMem, fetchNet, fetchProcesses, fetchSystem } from './glances';
import { fetchCache } from './files';
import { dialHost } from './dial';
import { fetchShim } from './shim';
import { fetchTailnetDevices, ipv4Of, type TailnetDevice } from './tailnet';

const offlineNode = (device: TailnetDevice, ip: string | null): FleetNode => ({
  id: device.id,
  name: device.name,
  tailscaleIp: ip ?? '',
  online: false,
  lastSeen: device.lastSeen,
  role: 'standalone',
  model: null,
  os: null,
  arch: null,
  kernel: null,
  uptimeSec: null,
  cpu: null,
  mem: null,
  cache: null,
  temp: null,
  power: null,
  disks: [],
  net: [],
  capabilities: [],
  topProcesses: [],
});

/**
 * The last answer a board gave, so one missed poll does not blank its card.
 *
 * jug runs a model that holds its cores flat out, and Glances gets starved
 * enough that a fetch occasionally passes the six second timeout. Every fetch
 * that misses returns nothing, so the card rendered empty for a poll and came
 * back on the next one. The board was up throughout; the console simply had
 * nothing to say that second and said it loudly.
 *
 * Only a poll that got both CPU and memory is remembered, and a remembered
 * answer is served for at most this long. A board that is genuinely gone
 * therefore empties its card after half a minute rather than showing a
 * comfortable number forever.
 */
const RETAIN_MS = 30_000;

interface Probe {
  cpu: Awaited<ReturnType<typeof fetchCpu>>;
  mem: Awaited<ReturnType<typeof fetchMem>>;
  shim: Awaited<ReturnType<typeof fetchShim>>;
  system: Awaited<ReturnType<typeof fetchSystem>>;
  disks: Awaited<ReturnType<typeof fetchDisks>>;
  net: Awaited<ReturnType<typeof fetchNet>>;
  topProcesses: Awaited<ReturnType<typeof fetchProcesses>>;
}

const lastGood = new Map<string, { at: number; probe: Probe }>();

/**
 * Fills gaps in this poll from the last good one, and says whether it had to.
 *
 * An empty list means the fetch failed rather than that the board has no disks
 * or no processes, so those fall back too.
 */
const withLastGood = (id: string, fresh: Probe, now: number): { probe: Probe; stale: boolean } => {
  // CPU and memory are the signals the card is built around. A poll that got
  // both is a real reading worth remembering; anything less is a gap to fill.
  if (fresh.cpu && fresh.mem) {
    lastGood.set(id, { at: now, probe: fresh });
    return { probe: fresh, stale: false };
  }

  const held = lastGood.get(id);
  if (!held || now - held.at >= RETAIN_MS) return { probe: fresh, stale: false };

  const prev = held.probe;
  const probe: Probe = {
    cpu: fresh.cpu ?? prev.cpu,
    mem: fresh.mem ?? prev.mem,
    shim: fresh.shim ?? prev.shim,
    system: fresh.system.uptimeSec == null && fresh.system.os == null ? prev.system : fresh.system,
    disks: fresh.disks.length ? fresh.disks : prev.disks,
    net: fresh.net.length ? fresh.net : prev.net,
    topProcesses: fresh.topProcesses.length ? fresh.topProcesses : prev.topProcesses,
  };
  return { probe, stale: true };
};

const buildNode = async (
  device: TailnetDevice,
  roles: Map<string, NodeRoleValue>,
): Promise<FleetNode> => {
  const ip = ipv4Of(device);
  if (!ip || !device.online) return { ...offlineNode(device, ip), role: roleFor(device, roles) };

  // The address to report is the tailnet one; the address to dial may not be.
  // See dial.ts — a board cannot always reach its own tailnet address.
  const host = dialHost(ip);

  const [cpu, mem, disks, net, system, shim, topProcesses, cache] = await Promise.all([
    fetchCpu(host),
    fetchMem(host),
    fetchDisks(host),
    fetchNet(host),
    fetchSystem(host),
    fetchShim(host),
    fetchProcesses(host, 250),
    // Null on a board running an older agent, which is an ordinary state:
    // the card simply leaves that half of the row out.
    fetchCache(host).catch(() => null),
  ]);

  // A saturated board answers some of that and not the rest. Fill the gaps
  // from the last poll that worked, rather than rendering a card of blanks
  // about a machine that is plainly up.
  const { probe, stale } = withLastGood(
    device.id,
    { cpu, mem, shim, system, disks, net, topProcesses },
    Date.now(),
  );

  // On the tailnet but nothing answered — agents are missing or down. That is
  // distinct from the machine being off, so it carries an error rather than
  // silently reading as offline.
  if (!probe.cpu && !probe.mem && !probe.shim) {
    return {
      ...offlineNode(device, ip),
      online: true,
      role: roleFor(device, roles),
      error: 'no agent responded',
    };
  }

  const capabilities: Capability[] = [];
  if (probe.shim?.power) capabilities.push('power');
  if (probe.shim?.throttled) capabilities.push('throttle');

  return {
    id: device.id,
    name: device.name,
    tailscaleIp: ip,
    online: true,
    stale,
    lastSeen: device.lastSeen,
    role: roleFor(device, roles),
    model: probe.shim?.model ?? null,
    os: probe.system.os,
    arch: probe.system.arch,
    kernel: probe.system.kernel,
    uptimeSec: probe.system.uptimeSec,
    cpu: probe.cpu,
    mem: probe.mem,
    temp: { cpuC: probe.shim?.tempC ?? null, throttled: probe.shim?.throttled ?? null },
    power: probe.shim?.power ?? null,
    disks: probe.disks,
    cache,
    net: probe.net,
    capabilities,
    topProcesses: topBySortableMetric(probe.topProcesses),
  };
};

/**
 * The card sorts by CPU, memory, disk or threads. Taking the top rows by CPU
 * alone would hide a process that is idle but holds a lot of memory, so the
 * union of the leaders in every sortable column is sent instead.
 */
const CARD_ROWS = 6;

const topBySortableMetric = (procs: ProcessRow[]): ProcessRow[] => {
  const keep = new Map<number, ProcessRow>();
  const metrics: Array<(p: ProcessRow) => number> = [
    (p) => p.cpuPct ?? -1,
    (p) => p.memBytes,
    (p) => p.diskReadBytes,
    (p) => p.threads,
  ];
  for (const by of metrics) {
    for (const p of [...procs].sort((a, b) => by(b) - by(a)).slice(0, CARD_ROWS)) {
      keep.set(p.pid, p);
    }
  }
  return [...keep.values()];
};

type NodeRoleValue = FleetNode['role'];

const roleFor = (device: TailnetDevice, roles: Map<string, NodeRoleValue>): NodeRoleValue =>
  roles.get(device.name) ?? 'standalone';

export const fetchFleet = async (): Promise<FleetNode[]> => {
  const [devices, roles] = await Promise.all([fetchTailnetDevices(), fetchClusterRoles()]);
  return Promise.all(devices.map((d) => buildNode(d, roles)));
};
