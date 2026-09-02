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
