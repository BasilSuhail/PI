/**
 * Aggregation. Turns tailnet devices plus agent responses into the FleetNode
 * contract the frontend consumes.
 */

import type { Capability, FleetNode, ProcessRow } from '../../shared/fleet';
import { fetchClusterRoles } from './kube';
import { fetchCpu, fetchDisks, fetchMem, fetchNet, fetchProcesses, fetchSystem } from './glances';
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
  temp: null,
  power: null,
  disks: [],
  net: [],
  capabilities: [],
  topProcesses: [],
});

const buildNode = async (
  device: TailnetDevice,
  roles: Map<string, NodeRoleValue>,
): Promise<FleetNode> => {
  const ip = ipv4Of(device);
  if (!ip || !device.online) return { ...offlineNode(device, ip), role: roleFor(device, roles) };

  const [cpu, mem, disks, net, system, shim, topProcesses] = await Promise.all([
    fetchCpu(ip),
    fetchMem(ip),
    fetchDisks(ip),
    fetchNet(ip),
    fetchSystem(ip),
    fetchShim(ip),
    fetchProcesses(ip, 250),
  ]);

  // On the tailnet but nothing answered — agents are missing or down. That is
  // distinct from the machine being off, so it carries an error rather than
  // silently reading as offline.
  if (!cpu && !mem && !shim) {
    return {
      ...offlineNode(device, ip),
      online: true,
      role: roleFor(device, roles),
      error: 'no agent responded',
    };
  }

  const capabilities: Capability[] = [];
  if (shim?.power) capabilities.push('power');
  if (shim?.throttled) capabilities.push('throttle');

  return {
    id: device.id,
    name: device.name,
    tailscaleIp: ip,
    online: true,
    lastSeen: device.lastSeen,
    role: roleFor(device, roles),
    model: shim?.model ?? null,
    os: system.os,
    arch: system.arch,
    kernel: system.kernel,
    uptimeSec: system.uptimeSec,
    cpu,
    mem,
    temp: { cpuC: shim?.tempC ?? null, throttled: shim?.throttled ?? null },
    power: shim?.power ?? null,
    disks,
    net,
    capabilities,
    topProcesses: topBySortableMetric(topProcesses),
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
    (p) => p.cpuPct,
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
