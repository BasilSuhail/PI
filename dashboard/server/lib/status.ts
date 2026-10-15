/**
 * The Status tab's feed: who is using which app, and what Jellyfin and Kiwix
 * hold.
 *
 * Read from a file rather than worked out here. Who is using what comes from
 * the PC's journal and Jellyfin's sessions, which only root on the PC can
 * read; `pi-when content` does that every 30 seconds (pi-status.timer) and
 * the pod sees the directory read-only (k8s/dashboard.yaml). The Discord bot
 * asks the same code, so the two never disagree.
 */

import { readFile } from 'node:fs/promises';
import type { ContentStatus } from '../../shared/fleet';

const FILE = process.env.STATUS_FILE ?? '/run/pi-status/status.json';

/** Null when the timer has not run yet, or this console is not on the PC. */
export const fetchContentStatus = async (): Promise<ContentStatus | null> => {
  try {
    return JSON.parse(await readFile(FILE, 'utf8')) as ContentStatus;
  } catch {
    return null;
  }
};
