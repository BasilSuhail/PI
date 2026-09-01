/**
 * Service launcher entries, plus a reachability probe.
 *
 * Config lives in apps.json next to this file so tiles can be added without a
 * rebuild. Absent or malformed, the launcher simply shows nothing.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppTile } from '../shared/fleet';

const CONFIG =
  process.env.APPS_CONFIG ?? join(dirname(fileURLToPath(import.meta.url)), 'apps.json');
const PROBE_TIMEOUT_MS = 2000;

interface AppConfig {
  name: string;
  url: string;
  nodeId?: string;
  /** A path to artwork under client/public, or a single character to letter the tile. */
  icon?: string;
  /** Skip the probe for services that are not HTTP, e.g. Samba on 445. */
  check?: boolean;
}

const probe = async (url: string): Promise<boolean> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // Any HTTP response means something is listening — a 401 or 404 still
    // proves the service is up, so status is deliberately not checked.
    await fetch(url, { signal: controller.signal, redirect: 'manual' });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

export const fetchApps = async (): Promise<AppTile[]> => {
  let config: AppConfig[];
  try {
    config = JSON.parse(await readFile(CONFIG, 'utf8')) as AppConfig[];
  } catch {
    return [];
  }
  if (!Array.isArray(config)) return [];

  return Promise.all(
    config.map(async (app) => ({
      name: app.name,
      url: app.url,
      nodeId: app.nodeId ?? null,
      icon: app.icon ?? null,
      // A url beginning with # names a view inside the console rather than an
      // address to leave for. There is nothing to probe: if the tile is on
      // screen, the thing it opens is already running.
      healthy: app.url.startsWith('#') ? true : app.check === false ? null : await probe(app.url),
    })),
  );
};
