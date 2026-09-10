/**
 * The launcher rail: apps as square tiles in a two-column grid — icon on
 * top, name beneath, status tucked into the corner. The controls it used
 * to hold (live, theme, refresh) moved to the menu bar.
 *
 * Tiles open as app windows (no browser furniture) when the browser
 * allows it and fall back to a plain tab when it does not. A `#` URL is
 * a view this console renders itself rather than a service — clicking it
 * is a no-op until that view is wired into this layout.
 */

import { useMemo, useState } from 'preact/hooks';
import type { AppTile } from '../../../shared/fleet';
import { Check, Search, Warn, X } from './icons';

const isArt = (icon: string | null): icon is string =>
  !!icon && (icon.startsWith('/') || icon.startsWith('http'));

const isInternal = (url: string) => url.startsWith('#');

/** The checked-in apps.json redacts tailnet hostnames; those cannot be probed. */
const probeable = (url: string) => !url.includes('<');

const openAsApp = (name: string, url: string): boolean => {
  const w = Math.min(1440, Math.round(screen.availWidth * 0.92));
  const h = Math.min(940, Math.round(screen.availHeight * 0.92));
  const left = Math.round((screen.availWidth - w) / 2);
  const top = Math.round((screen.availHeight - h) / 2);
  const handle = window.open(
    url,
    `pi-${name.replace(/[^a-z0-9]+/gi, '-')}`,
    `popup=yes,width=${w},height=${h},left=${left},top=${top}`,
  );
  if (!handle) return false;
  handle.focus();
  return true;
};

type TileState = 'online' | 'offline' | 'unprobed' | 'internal';

const stateOf = (app: AppTile): TileState => {
  if (isInternal(app.url)) return 'internal';
  if (app.healthy === true) return 'online';
  if (app.healthy === false) return probeable(app.url) ? 'offline' : 'unprobed';
  return 'unprobed';
};

const SUB: Record<TileState, string> = {
  online: 'online',
  offline: 'offline',
  unprobed: 'no probe',
  internal: 'in console',
};

export const ServicesPane = ({
  apps, error,
}: {
  apps: AppTile[];
  error: string | null;
}) => {
  const [query, setQuery] = useState('');
  const filtered = useMemo(
    () => apps.filter((a) => a.name.toLowerCase().includes(query.toLowerCase())),
    [apps, query],
  );
  const online = apps.filter((a) => stateOf(a) === 'online').length;

  return (
    <aside class="pane">
      <div class="pane-head">
        <span class="label">apps</span>
        <span class="pane-count">{online} of {apps.length} up</span>
      </div>

      <label class="search">
        <Search size={14} />
        <input
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          placeholder="Search apps"
          aria-label="Search apps"
        />
        {query && (
          <button onClick={() => setQuery('')} aria-label="Clear search">
            <X size={12} />
          </button>
        )}
      </label>

      {error && (
        <div class="pane-error">
          <Warn size={13} />
          <span>Probes failed — {error}</span>
        </div>
      )}

      <div class="apps">
        {filtered.map((app) => {
          const state = stateOf(app);
          return (
            <button
              key={app.name}
              class={`tile ${state === 'internal' ? 'internal' : ''}`}
              onClick={() => { if (!isInternal(app.url)) openAsApp(app.name, app.url); }}
            >
              <span class="tile-icon">
                {isArt(app.icon)
                  ? <img src={app.icon} alt="" width="26" height="26" loading="lazy" />
                  : app.name.slice(0, 1)}
              </span>
              <span class="tile-copy">
                <b>{app.name}</b>
                <small class={`st-${state}`}>{SUB[state]}</small>
              </span>
              {state === 'online' && <span class="tile-status on"><Check size={10} /></span>}
              {state === 'offline' && <span class="tile-status off"><Warn size={11} /></span>}
            </button>
          );
        })}
        {!filtered.length && <div class="empty">Nothing matches “{query}”.</div>}
      </div>

    </aside>
  );
};
