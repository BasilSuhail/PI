/**
 * Client for the shim's directory scanner.
 *
 * The scan walks a whole subtree to size it, so the timeout here is far longer
 * than any other call in this server. The shim gives up on its own at 20s and
 * answers with what it has and `complete: false`, which is the case this has
 * to stay connected long enough to receive.
 */

import type { DirListing, DirRoots } from '../../shared/fleet';
import { SHIM_PORT } from './shim';

const TIMEOUT_MS = 25_000;

const get = async <T>(host: string, query: string): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`http://${host}:${SHIM_PORT}/files${query}`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      // 403 and 404 are the shim refusing a path, and the reason it gives is
      // worth showing rather than flattening into "something went wrong".
      throw new Error(`${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
};

/** The tops of the browsable tree, when the client has no path yet. */
export const fetchRoots = (host: string) => get<DirRoots>(host, '');

export const fetchListing = (host: string, path: string) =>
  get<DirListing>(host, `?path=${encodeURIComponent(path)}`);
