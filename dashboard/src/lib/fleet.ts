/**
 * Aggregation. Turns tailnet devices plus agent responses into the FleetNode
 * contract the frontend consumes.
 */

import type { Capability, FleetNode } from '@/types/fleet';
import { fetchClusterRoles } from './kube';
import { fetchCpu, fetchDisks, fetchMem, fetchNet, fetchSystem } from './glances';
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
});

const buildNode = async (
  device: TailnetDevice,
  roles: Map<string, NodeRoleValue>,
): Promise<FleetNode> => {
  const ip = ipv4Of(device);
  if (!ip || !device.online) return { ...offlineNode(device, ip), role: roleFor(device, roles) };

  const [cpu, mem, disks, net, system, shim] = await Promise.all([
    fetchCpu(ip),
    fetchMem(ip),
    fetchDisks(ip),
    fetchNet(ip),
    fetchSystem(ip),
    fetchShim(ip),
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
  if (roles.has(device.name)) capabilities.push('containers');

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
  };
};

type NodeRoleValue = FleetNode['role'];

const roleFor = (device: TailnetDevice, roles: Map<string, NodeRoleValue>): NodeRoleValue =>
  roles.get(device.name) ?? 'standalone';

export const fetchFleet = async (): Promise<FleetNode[]> => {
  const [devices, roles] = await Promise.all([fetchTailnetDevices(), fetchClusterRoles()]);
  return Promise.all(devices.map((d) => buildNode(d, roles)));
};
