/**
 * The contract between backend and frontend. Documented in docs/dashboard.md.
 *
 * Two rules the UI must respect:
 *   - `capabilities` decides what renders. A non-Pi node has no power reading.
 *   - `online: false` is a normal state, not an error. Boards get turned off.
 */

export type NodeRole = 'control-plane' | 'worker' | 'standalone';

export type Capability = 'power' | 'throttle';

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
  /** The thumbnail cache on this board's disk. Null when the agent is old. */
  cache: ThumbCache | null;
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
  /** Null until a second reading exists to average over. See glances.ts. */
  cpuPct: number | null;
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
}

export interface AppTile {
  name: string;
  url: string;
  nodeId: string | null;
  icon: string | null;
  healthy: boolean | null;
}

/**
 * One entry in a directory, as the shim's scanner reports it.
 *
 * `bytes` on a directory is its whole subtree, which is the number that makes
 * a size-sorted listing useful. Hidden entries are included — a dotfile is
 * usually what is eating the disk, and dropping them would make the totals
 * disagree with the parent.
 */
export interface DirEntry {
  name: string;
  dir: boolean;
  link: boolean;
  bytes: number;
  /** Unix seconds. */
  mtime: number;
  hidden: boolean;
  /**
   * Set only on the synthetic columns — the fleet and a board's roots — where
   * a child's key cannot be made by joining a name onto its parent.
   */
  path?: string;
  /** Total size of the board's disks. Column zero only. */
  capacity?: number;
  /** A root that refuses every write. Shown before you try, not after. */
  locked?: boolean;
  /** A named shortcut sitting above the disk's own contents. */
  pinned?: boolean;
  /**
   * Finder tag names, read from the same extended attribute Finder writes, so
   * the two cannot disagree. Colour names only — Red, Blue, and the rest.
   */
  tags?: string[];
}

export interface DirListing {
  path: string;
  /** Null at a root: there is nowhere further up that may be read. */
  parent: string | null;
  total: number;
  count: number;
  /** Entries beyond the cap, which are the smallest ones. */
  truncated: number;
  /** False when the sizing hit its deadline. The numbers are then floors. */
  complete: boolean;
  entries: DirEntry[];
  /** Set when the directory could not be read at all. */
  error?: string;
  /** False for anything outside the writable roots — the system, in practice. */
  writable?: boolean;
}

export interface DirRoots {
  /** `writable` is the agent's answer, not the UI's guess: a read-only root
   *  refuses a write whatever the interface offers. */
  roots: Array<{ path: string; name: string; writable: boolean }>;
}

/** What the cache holds, and whether the board can make thumbnails at all. */
export interface ThumbCache {
  bytes: number;
  count: number;
  capBytes: number;
  /** False when vipsthumbnail is not installed — only Exif thumbs are possible. */
  tool: boolean;
}

/**
 * A credential the dashboard holds and cannot renew for itself.
 *
 * Empty under systemd, where node discovery uses the local tailscaled socket
 * and there is nothing to expire. See server/lib/expiry.ts.
 */
export interface CredentialStatus {
  name: string;
  /** ISO date the credential dies. Null when nobody recorded one. */
  expiresAt: string | null;
  /** Whole days from today, negative once it has lapsed. Null if unrecorded. */
  daysLeft: number | null;
  state: 'ok' | 'soon' | 'expired' | 'unknown';
}
