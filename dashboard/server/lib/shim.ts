/** Client for the pi-metrics shim — power and throttle state. */

import type { PowerStats, ThrottleState } from '../../shared/fleet';

export const SHIM_PORT = 9101;

const TIMEOUT_MS = 3000;

interface ShimResponse {
  ts: number;
  model: string | null;
  tempC: number | null;
  power: PowerStats | null;
  throttled: ThrottleState | null;
  capabilities: string[];
}

/**
 * Returns null when the shim is absent. That is an ordinary outcome — a
 * non-Pi node has nothing to report here and simply renders fewer tiles.
 */
export const fetchShim = async (host: string): Promise<ShimResponse | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`http://${host}:${SHIM_PORT}/metrics`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    return res.ok ? ((await res.json()) as ShimResponse) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};
