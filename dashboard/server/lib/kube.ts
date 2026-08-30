/**
 * Cluster membership, used only to label nodes. Never to discover them —
 * standalone machines must appear on the dashboard too.
 *
 * Failure here is not fatal: if the cluster is unreachable every node simply
 * falls back to 'standalone'.
 */

import type { NodeRole } from '../../shared/fleet';

const TIMEOUT_MS = 3000;

interface KubeNodeList {
  items: Array<{
    metadata: { name: string; labels?: Record<string, string> };
  }>;
}

/** Map of node name -> role. Empty when the cluster cannot be reached. */
export const fetchClusterRoles = async (): Promise<Map<string, NodeRole>> => {
  const server = process.env.KUBE_API_SERVER;
  const token = process.env.KUBE_TOKEN;
  const roles = new Map<string, NodeRole>();

  if (!server || !token) return roles;

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
