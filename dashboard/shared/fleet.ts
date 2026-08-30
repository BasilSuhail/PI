/**
 * The contract between backend and frontend. Documented in docs/dashboard.md.
 *
 * Two rules the UI must respect:
 *   - `capabilities` decides what renders. A non-Pi node has no power reading.
 *   - `online: false` is a normal state, not an error. Boards get turned off.
 */

export type NodeRole = 'control-plane' | 'worker' | 'standalone';

export type Capability = 'power' | 'throttle' | 'containers';

export interface CpuStats {
  cores: number;
  usagePct: number;
  perCore: number[];
  loadAvg: [number, number, number];
}

export interface MemStats {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPct: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
}

export interface ThrottleState {
  raw: string;
  /** Throttling right now. Worth shouting about. */
  now: boolean;
  /** Happened at some point since boot. Worth mentioning, not alarming. */
  everSinceBoot: boolean;
  reasons: string[];
  reasonsSinceBoot: string[];
}

export interface TempStats {
  cpuC: number | null;
  throttled: ThrottleState | null;
}

export interface PowerRail {
  name: string;
  volts: number;
  amps: number;
  watts: number;
}

/** Pi 5 only — measured from the PMIC, not estimated. */
export interface PowerStats {
  watts: number;
  rails: PowerRail[];
}

export interface DiskStats {
  mount: string;
  device: string;
  totalBytes: number;
  usedBytes: number;
  usedPct: number;
}

export interface NetStats {
  iface: string;
  rxBps: number;
  txBps: number;
}

export interface FleetNode {
  id: string;
  name: string;
  tailscaleIp: string;
  online: boolean;
  /** ISO timestamp. Meaningful mainly when offline. */
  lastSeen: string;
  role: NodeRole;

  model: string | null;
  os: string | null;
  arch: string | null;
  kernel: string | null;
  uptimeSec: number | null;

  cpu: CpuStats | null;
  mem: MemStats | null;
  temp: TempStats | null;
  power: PowerStats | null;
  disks: DiskStats[];
  net: NetStats[];

  capabilities: Capability[];
  /** Busiest few, for the card's table. Full list stays on the detail route. */
  topProcesses: ProcessRow[];
  /** Set when the node is on the tailnet but its agents did not answer. */
  error?: string;
}

export interface ProcessRow {
  pid: number;
  name: string;
  cmdline: string | null;
  user: string | null;
  cpuPct: number;
  memBytes: number;
  memPct: number;
  threads: number;
  /** Cumulative bytes read since the process started. */
  diskReadBytes: number;
}

export interface ContainerRow {
  name: string;
  image: string | null;
  status: string;
  cpuPct: number | null;
  memBytes: number | null;
  /** 'docker' on standalone nodes, 'kubernetes' on cluster members. */
  source: 'docker' | 'kubernetes';
}

export interface AppTile {
  name: string;
  url: string;
  nodeId: string | null;
  icon: string | null;
  healthy: boolean | null;
}
