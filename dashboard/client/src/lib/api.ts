/** Thin fetch layer plus the polling hook the views use. */

import { useEffect, useRef, useState } from 'react';
import type { ContainerRow, FleetNode, ProcessRow } from '../../../shared/fleet';

const json = async <T>(path: string): Promise<T> => {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${path} returned ${res.status}`);
  }
  return (await res.json()) as T;
};

export const getNodes = () => json<FleetNode[]>('/api/nodes');
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
