/**
 * Cluster membership, used only to label nodes. Never to discover them —
 * standalone machines must appear on the dashboard too.
 *
 * Failure here is not fatal: if the cluster is unreachable every node simply
 * falls back to 'standalone'.
 */

import { readFile } from 'node:fs/promises';

import type { NodeRole } from '../../shared/fleet';

const TIMEOUT_MS = 3000;

/** Projected into every pod by kubelet, alongside KUBERNETES_SERVICE_HOST. */
const IN_CLUSTER_TOKEN = '/var/run/secrets/kubernetes.io/serviceaccount/token';

/**
 * Where to find the cluster, and what to authenticate with.
 *
 * Under systemd both come from the environment, written by the installer from
 * a ServiceAccount that can list nodes and nothing else. In a pod neither is
 * configured: kubelet sets the service host and projects a token for the
 * ServiceAccount the pod runs as, which is the same identity by another route.
 *
 * The projected token is re-read every poll rather than cached, because
 * kubelet rotates it and a cached copy would expire mid-run.
 */
const credentials = async (): Promise<{ server: string; token: string } | null> => {
  const server = process.env.KUBE_API_SERVER;
  const token = process.env.KUBE_TOKEN;
  if (server && token) return { server, token };

  const host = process.env.KUBERNETES_SERVICE_HOST;
  if (!host) return null;
  const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';

  try {
    return { server: `https://${host}:${port}`, token: (await readFile(IN_CLUSTER_TOKEN, 'utf8')).trim() };
  } catch {
    return null;
  }
};

interface KubeNodeList {
  items: Array<{
    metadata: { name: string; labels?: Record<string, string> };
  }>;
}

/** Map of node name -> role. Empty when the cluster cannot be reached. */
export const fetchClusterRoles = async (): Promise<Map<string, NodeRole>> => {
  const roles = new Map<string, NodeRole>();

  const creds = await credentials();
  if (!creds) return roles;
  const { server, token } = creds;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${server}/api/v1/nodes`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) return roles;

    const { items } = (await res.json()) as KubeNodeList;
    for (const node of items) {
      const labels = node.metadata.labels ?? {};
      const isControlPlane =
        'node-role.kubernetes.io/control-plane' in labels ||
        'node-role.kubernetes.io/master' in labels;
      roles.set(node.metadata.name, isControlPlane ? 'control-plane' : 'worker');
    }
    return roles;
  } catch {
    return roles;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The one workload the console can switch on and off: qBittorrent, which runs
 * behind a VPN and is meant to be off unless something is downloading.
 *
 * Scale rather than delete. Zero replicas means nothing running and no RAM
 * held, while the deployment, its secret and its tailnet name stay exactly as
 * configured — so starting it again is one integer and not a redeploy.
 *
 * The ServiceAccount is allowed `get` and `patch` on this deployment's scale
 * subresource and nothing else in the cluster (k8s/qbittorrent.yaml). A bug
 * here cannot reach another workload even if it tried.
 */
const TORRENT = { ns: 'jug', name: 'qbittorrent' };

const scaleUrl = (server: string) =>
  `${server}/apis/apps/v1/namespaces/${TORRENT.ns}/deployments/${TORRENT.name}/scale`;

export interface TorrentState {
  /** Replicas asked for: what the button last set. */
  wanted: number;
  /** Replicas actually up. Between the two is "starting" or "stopping". */
  ready: number;
  /** Null when the cluster cannot be reached, which is not the same as off. */
  reachable: boolean;
}

export const fetchTorrentState = async (): Promise<TorrentState> => {
  const creds = await credentials();
  if (!creds) return { wanted: 0, ready: 0, reachable: false };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(scaleUrl(creds.server), {
      headers: { Authorization: `Bearer ${creds.token}` },
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) return { wanted: 0, ready: 0, reachable: false };
    const body = (await res.json()) as { spec?: { replicas?: number }; status?: { replicas?: number } };
    return {
      wanted: body.spec?.replicas ?? 0,
      // status.replicas counts pods that exist; a pod that exists but is not
      // ready still reads as starting, which is what the button should say.
      ready: body.status?.replicas ?? 0,
      reachable: true,
    };
  } catch {
    return { wanted: 0, ready: 0, reachable: false };
  } finally {
    clearTimeout(timer);
  }
};

/** Start or stop it. Returns the state the cluster accepted, or null. */
export const setTorrentRunning = async (running: boolean): Promise<TorrentState | null> => {
  const creds = await credentials();
  if (!creds) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(scaleUrl(creds.server), {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${creds.token}`,
        // Merge patch rather than strategic: scale is a subresource with one
        // field worth setting, and a merge patch says exactly that.
        'Content-Type': 'application/merge-patch+json',
      },
      body: JSON.stringify({ spec: { replicas: running ? 1 : 0 } }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { spec?: { replicas?: number }; status?: { replicas?: number } };
    return { wanted: body.spec?.replicas ?? 0, ready: body.status?.replicas ?? 0, reachable: true };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};
