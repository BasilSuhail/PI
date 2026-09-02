/**
 * Node discovery.
 *
 * The dashboard asks Tailscale which machines exist, not Kubernetes. jug1 is
 * on the tailnet but not in the cluster, and asking k8s would miss it entirely.
 * Cluster membership is a label applied afterwards, not a filter.
 *
 * A machine joining the tailnet appears here with no config change.
 */

const API_BASE = 'https://api.tailscale.com/api/v2';
const TIMEOUT_MS = 5000;

export interface TailnetDevice {
  id: string;
  name: string;
  hostname: string;
  addresses: string[];
  online: boolean;
  lastSeen: string;
  os: string;
}

interface RawDevice {
  id: string;
  name: string;
  hostname: string;
  addresses: string[];
  lastSeen: string;
  os: string;
}

/** Tailscale reports lastSeen but not a live flag for every device type. */
const ONLINE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Falls back to the local tailscaled when no API key is set.
 *
 * Works anywhere the tailscale CLI is present and the daemon is running — a
 * developer machine, or the dashboard running directly on a node rather than
 * inside a pod. In a container without the socket, the API key path is the
 * only one available.
 */
const fetchViaLocalCli = async (): Promise<TailnetDevice[] | null> => {
  let execFile: typeof import('node:child_process').execFile;
  try {
    ({ execFile } = await import('node:child_process'));
  } catch {
    return null;
  }

  const raw = await new Promise<string | null>((resolve) => {
    const child = execFile('tailscale', ['status', '--json'], { timeout: TIMEOUT_MS }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
    child.on('error', () => resolve(null));
  });
  if (!raw) return null;

  interface LocalPeer {
    ID: string;
    HostName: string;
    DNSName: string;
    TailscaleIPs: string[];
    Online: boolean;
    LastSeen: string;
    OS: string;
  }

  try {
    const status = JSON.parse(raw) as { Peer?: Record<string, LocalPeer>; Self?: LocalPeer };
    const peers = [...Object.values(status.Peer ?? {}), ...(status.Self ? [status.Self] : [])];

    return peers
      .filter((p) => p.OS === 'linux')
      .map((p) => ({
        id: p.ID,
        name: p.HostName || p.DNSName.split('.')[0],
        hostname: p.HostName,
        addresses: p.TailscaleIPs ?? [],
        online: p.Online,
        lastSeen: p.LastSeen,
        os: p.OS,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return null;
  }
};

/**
 * Tailnet short name -> IPv4, refreshed on every discovery pass.
 *
 * MagicDNS names resolve on a board, where tailscaled is the resolver. They do
 * not resolve inside a pod: DNS there goes to CoreDNS, which has never heard of
 * the tailnet. Public names are unaffected, which is why node discovery kept
 * working after the move to k3s while the launcher's health checks did not.
 *
 * Reconfiguring the pod's DNS would trade a red tile for the risk of no DNS at
 * all. The addresses are already in hand here, so anything that needs to reach
 * a tailnet name by name can ask for one instead.
 */
const tailnetIps = new Map<string, string>();

/**
 * The address behind a MagicDNS name, or null to let ordinary DNS handle it.
 *
 * Null until the first discovery pass has run. The fleet polls far more often
 * than the launcher does, so in practice the map is filled before anything
 * asks.
 */
export const tailnetIpFor = (hostname: string): string | null => {
  // Only MagicDNS names are answered here. Everything else is someone else's
  // to resolve, and hijacking it would be a surprise.
  if (!hostname.toLowerCase().endsWith('.ts.net')) return null;
  return tailnetIps.get(hostname.toLowerCase().split('.')[0]) ?? null;
};

export const fetchTailnetDevices = async (): Promise<TailnetDevice[]> => {
  const devices = await discoverDevices();
  for (const device of devices) {
    const ip = ipv4Of(device);
    if (ip) tailnetIps.set(device.name.toLowerCase(), ip);
  }
  return devices;
};

const discoverDevices = async (): Promise<TailnetDevice[]> => {
  const key = process.env.TAILSCALE_API_KEY;
  const tailnet = process.env.TAILSCALE_TAILNET ?? '-';

  if (!key) {
    const local = await fetchViaLocalCli();
    if (local) return local;
    throw new Error(
      'no TAILSCALE_API_KEY, and the local tailscale CLI is unavailable — cannot discover nodes',
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${API_BASE}/tailnet/${tailnet}/devices`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!res.ok) {
      throw new Error(`Tailscale API returned ${res.status}`);
    }

    const { devices } = (await res.json()) as { devices: RawDevice[] };
    const now = Date.now();

    return devices
      // Only Linux nodes run the agents. Phones and laptops are viewers.
      .filter((d) => d.os === 'linux')
      .map((d) => ({
        id: d.id,
        name: d.hostname || d.name.split('.')[0],
        hostname: d.hostname,
        addresses: d.addresses,
        online: now - new Date(d.lastSeen).getTime() < ONLINE_WINDOW_MS,
        lastSeen: d.lastSeen,
        os: d.os,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    clearTimeout(timer);
  }
};

/** Tailscale hands out both v4 and v6; the agents listen on v4. */
export const ipv4Of = (device: TailnetDevice): string | null =>
  device.addresses.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? null;
