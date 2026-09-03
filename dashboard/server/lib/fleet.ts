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
 * How often the card's process list is actually refetched.
 *
 * The fleet polls every three seconds, and a poll of jug is 111 KB of which
 * 106 KB is the process list: Glances serialising 194 processes so the card
 * can show six rows. At that rate it is 128 MB an hour from a board that is
 * already at 100% CPU, and Glances itself was burning most of a core to
 * produce it.
 *
 * The meters people watch — CPU, memory, temperature — stay on the three
 * second poll, because those are cheap and the movement is the point. The
 * process list refreshes on this interval instead, which is plenty for six
 * rows that mostly say the same thing, and cuts the traffic by roughly three
 * quarters.
 *
 * The node detail view is unaffected. It calls fetchProcesses directly and
 * still gets a fresh list every time it asks.
 */
const PROCESS_TTL_MS = 15_000;

const cardProcesses = new Map<string, { at: number; rows: ProcessRow[] }>();

/**
 * Holds a value per host for a while, so a field that barely moves is not
 * refetched three times a second.
 *
 * Every one of these is a request to Glances, and on jug1 a request is not
 * free: that board runs `llama-server` at roughly 3.5 of its 4 cores during an
 * ingest burst, and everything else — Docker, the agents, sshd — queues for
 * what is left. The cheapest CPU to give it back is the work never asked for.
 *
 * A failed fetch is not cached. The board is asked again on the next poll
 * rather than being written off for the length of the window.
 */
const held = new Map<string, { at: number; value: unknown }>();

const cached = async <T>(key: string, ttlMs: number, fetcher: () => Promise<T>, usable: (v: T) => boolean): Promise<T> => {
  const hit = held.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await fetcher();
  if (usable(value)) held.set(key, { at: Date.now(), value });
  return value;
};

/**
 * The machine's name for itself. os, arch and kernel cannot change while the
 * board is up, and uptime is only ever rendered to the minute, so asking twice
 * a minute is already more often than the answer can differ. This was two of
 * the eleven requests each poll made, every three seconds, forever.
 */
const SYSTEM_TTL_MS = 60_000;

/**
 * Disk usage, which on these boards moves in hours. The card draws it as a
 * percentage bar; nothing about it is legible at three second resolution.
 */
const DISKS_TTL_MS = 30_000;

/**
 * The process list for a card, refetched at most every PROCESS_TTL_MS.
 *
 * A failed fetch returns an empty list rather than throwing, and an empty list
 * is not cached: a board that answered nothing should be asked again on the
 * next poll rather than showing nothing for fifteen seconds.
 */
const cardProcessesFor = async (host: string, id: string): Promise<ProcessRow[]> => {
  const held = cardProcesses.get(id);
  if (held && Date.now() - held.at < PROCESS_TTL_MS) return held.rows;

  const rows = await fetchProcesses(host, 250);
  if (rows.length) cardProcesses.set(id, { at: Date.now(), rows });
  return rows;
};

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
    // Both held between polls. See SYSTEM_TTL_MS and DISKS_TTL_MS — the point
    // is the requests jug1 never has to answer.
    cached(`disks:${device.id}`, DISKS_TTL_MS, () => fetchDisks(host), (d) => d.length > 0),
    fetchNet(host),
    cached(
      `system:${device.id}`,
      SYSTEM_TTL_MS,
      () => fetchSystem(host),
      (s) => s.os != null || s.uptimeSec != null,
    ),
    fetchShim(host),
    cardProcessesFor(host, device.id),
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
    disks: withRotation(probe.disks, probe.shim),
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

/**
 * Names a disk by what it is.
 *
 * The shim reports whether each block device spins; Glances reports where each
 * filesystem is mounted. The two name devices differently — the shim says
 * "sda" (the physical disk), Glances says "/dev/sda2" (the partition) — so the
 * join has to strip both the /dev/ prefix and the partition suffix to match
 * them. Without that, every disk reads "disk" instead of "SSD" or "HDD".
 */

/** sda2→sda, mmcblk0p1→mmcblk0, nvme0n1p1→nvme0n1. */
const parentDisk = (dev: string): string => {
  const mp = dev.match(/^(mmcblk\d+|nvme\d+n\d+)p\d+$/);
  if (mp) return mp[1];
  const sd = dev.match(/^((?:sd|vd|xvd|hd)[a-z]+)\d+$/);
  if (sd) return sd[1];
  return dev;
};

const withRotation = (
  disks: DiskStatsValue[],
  shim: Awaited<ReturnType<typeof fetchShim>>,
): DiskStatsValue[] => {
  const spins = new Map((shim?.disks ?? []).map((d) => [d.device, d.rotational]));
  return disks.map((d) => ({
    ...d,
    rotational: spins.get(parentDisk(d.device.replace(/^\/dev\//, ''))) ?? null,
  }));
};

type DiskStatsValue = FleetNode['disks'][number];

type NodeRoleValue = FleetNode['role'];


const roleFor = (device: TailnetDevice, roles: Map<string, NodeRoleValue>): NodeRoleValue =>
  roles.get(device.name) ?? 'standalone';

const probeFleet = async (): Promise<FleetNode[]> => {
  const [devices, roles] = await Promise.all([fetchTailnetDevices(), fetchClusterRoles()]);
  return Promise.all(devices.map((d) => buildNode(d, roles)));
};

/**
 * Just under the client's own three second poll, so one viewer never sees the
 * same frame twice and every extra viewer is free.
 */
const FLEET_TTL_MS = 2500;

let fleetHeld: { at: number; nodes: FleetNode[] } | null = null;
let fleetInFlight: Promise<FleetNode[]> | null = null;

/**
 * One probe of the fleet, shared by everyone who asks inside the window.
 *
 * Nothing coalesced the polls before this. Each browser tab drove its own
 * /api/nodes every three seconds and each of those ran a full fresh probe, so
 * a phone and a laptop watching at once meant jug1 answered every Glances
 * request twice over, a third tab three times. The board paid per viewer for a
 * number that is identical for all of them, and it is the board with no spare
 * CPU to pay with.
 *
 * The in-flight promise matters as much as the window. A probe of a saturated
 * jug1 can take seconds, which is precisely when the next request arrives; the
 * shared promise makes that one wait for the answer already coming rather than
 * asking the board again while it is still busy with the first.
 *
 * A failed probe is not held. The error propagates and the next caller tries
 * again, so a lapsed API key still surfaces within one poll.
 */
export const fetchFleet = async (): Promise<FleetNode[]> => {
  if (fleetHeld && Date.now() - fleetHeld.at < FLEET_TTL_MS) return fleetHeld.nodes;
  if (fleetInFlight) return fleetInFlight;

  fleetInFlight = probeFleet()
    .then((nodes) => {
      fleetHeld = { at: Date.now(), nodes };
      return nodes;
    })
    .finally(() => {
      fleetInFlight = null;
    });

  return fleetInFlight;
};
