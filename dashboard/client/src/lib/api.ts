/** Thin fetch layer plus the polling hook the views use. */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppTile, TorrentState, ContainerRow, CredentialStatus, DirListing, DirRoots, FleetNode, ProcessRow } from '../../../shared/fleet';

const json = async <T>(path: string): Promise<T> => {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${path} returned ${res.status}`);
  }
  return (await res.json()) as T;
};

export const getNodes = () => json<FleetNode[]>('/api/nodes');
export const getApps = () => json<AppTile[]>('/api/apps');
export const getCredentials = () => json<CredentialStatus[]>('/api/credentials');
export const getProcesses = (id: string, limit = 30) =>
  json<ProcessRow[]>(`/api/nodes/${encodeURIComponent(id)}/processes?limit=${limit}`);
export const getContainers = (id: string) =>
  json<ContainerRow[]>(`/api/nodes/${encodeURIComponent(id)}/containers`);

interface Poll<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  updatedAt: Date | null;
  refresh: () => void;
}

/**
 * Polls on an interval and keeps the previous value visible while refetching,
 * so the whole page does not blank out every few seconds.
 */
export const usePoll = <T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  deps: unknown[] = [],
): Poll<T> => {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;

    const run = async () => {
      try {
        const next = await fetcher();
        if (!alive.current) return;
        setData(next);
        setError(null);
        setUpdatedAt(new Date());
      } catch (err) {
        if (!alive.current) return;
        setError(err instanceof Error ? err.message : 'request failed');
      } finally {
        if (alive.current) {
          setLoading(false);
          timer = setTimeout(run, intervalMs);
        }
      }
    };

    void run();
    return () => {
      alive.current = false;
      clearTimeout(timer);
    };
    // `fetcher` is deliberately not a dependency: callers pass an inline arrow
    // that would be a new function every render and restart the poll on each
    // one. `deps` is how a caller says which of its own values the fetcher
    // closes over.
  }, [intervalMs, tick, ...deps]);

  return { data, error, loading, updatedAt, refresh: () => setTick((t) => t + 1) };
};

/**
 * Keeps a short in-memory history per node so the thermal sparkline shows
 * something real. Lost on reload — history past a page refresh would need a
 * store on the server, which is not worth it for a ten-minute window.
 */
export const useHistory = (nodes: FleetNode[] | null, cap = 40) => {
  const store = useRef(new Map<string, number[]>());
  useEffect(() => {
    if (!nodes) return;
    for (const node of nodes) {
      const temp = node.temp?.cpuC;
      if (temp == null) continue;
      const series = store.current.get(node.id) ?? [];
      series.push(temp);
      if (series.length > cap) series.shift();
      store.current.set(node.id, series);
    }
  }, [nodes, cap]);
  return store.current;
};

export const usePowerHistory = (nodes: FleetNode[] | null, cap = 40) => {
  const store = useRef(new Map<string, number[]>());
  useEffect(() => {
    if (!nodes) return;
    for (const node of nodes) {
      const w = node.power?.watts;
      if (w == null) continue;
      const series = store.current.get(node.id) ?? [];
      series.push(w);
      if (series.length > cap) series.shift();
      store.current.set(node.id, series);
    }
  }, [nodes, cap]);
  return store.current;
};

export const useNetHistory = (nodes: FleetNode[] | null, cap = 60) => {
  const store = useRef(new Map<string, Array<[number, number]>>());
  useEffect(() => {
    if (!nodes) return;
    for (const node of nodes) {
      if (!node.online) continue;
      const rx = node.net.reduce((a, i) => a + i.rxBps, 0);
      const tx = node.net.reduce((a, i) => a + i.txBps, 0);
      const series = store.current.get(node.id) ?? [];
      series.push([rx, tx]);
      if (series.length > cap) series.shift();
      store.current.set(node.id, series);
    }
  }, [nodes, cap]);
  return store.current;
};

export const getRoots = (id: string) =>
  json<DirRoots>(`/api/nodes/${encodeURIComponent(id)}/files`);
export const getListing = (id: string, path: string) =>
  json<DirListing>(`/api/nodes/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`);

/** A URL rather than a fetch: <img> does the request, so the browser decides
 *  when — which is what makes lazy loading actually lazy. */
export const thumbUrl = (id: string, path: string) =>
  `/api/nodes/${encodeURIComponent(id)}/thumb?path=${encodeURIComponent(path)}`;

/**
 * One endpoint for every change. The agent's refusal is passed straight back,
 * so what a person reads is the reason the board gave rather than this layer's
 * guess at it.
 */
export const write = async (id: string, body: Record<string, unknown>): Promise<void> => {
  const res = await fetch(`/api/nodes/${encodeURIComponent(id)}/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? `that was refused (${res.status})`);
  }
};

export const upload = async (id: string, path: string, file: File): Promise<void> => {
  const res = await fetch(
    `/api/nodes/${encodeURIComponent(id)}/upload?path=${encodeURIComponent(path)}&name=${encodeURIComponent(file.name)}`,
    { method: 'POST', body: file },
  );
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? `upload refused (${res.status})`);
  }
};

/**
 * The download stack's power switch.
 *
 * Separate from the apps poll on purpose: the shelf refreshes on a timer and
 * this changes only when somebody presses the button, so folding it into that
 * poll would mean a cluster call every few seconds to learn nothing.
 */
export const getTorrent = () => json<TorrentState>('/api/torrent');

export const setTorrent = async (running: boolean): Promise<TorrentState> => {
  const res = await fetch('/api/torrent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ running }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as TorrentState;
};
