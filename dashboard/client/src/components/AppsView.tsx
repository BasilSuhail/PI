import { useEffect, useState } from 'preact/hooks';
import { Gauge, Power, Shield } from './icons';
import type { AppTile, TorrentState } from '../../../shared/fleet';
import { getTorrent, setTorrent } from '../lib/api';
import { StatusDot } from './primitives';

/** Tile colours cycle so a newly added app gets one without being configured. */
const ACCENTS = ['purple', 'blue', 'orange', 'green', 'pink'] as const;

/**
 * An icon is either a path to artwork or a character to letter the tile with.
 * A leading slash or scheme is the whole test — anything else stays a letter,
 * so tiles configured before this existed are untouched.
 */
const isArt = (icon: string | null): icon is string =>
  !!icon && (icon.startsWith('/') || icon.startsWith('http'));

/** A tile that opens a view here rather than navigating away. */
const isInternal = (url: string) => url.startsWith('#');

/**
 * Open a service the way you would open an application: its own window, with
 * no tab strip, no address bar and no bookmarks.
 *
 * This is as close as a web page can get. A page cannot hand a link to an
 * installed PWA — there is no API for it, and whether one exists is a property
 * of the machine you happen to be holding, not of this console. What it can do
 * is ask for a window with no browser furniture, which on every platform that
 * matters here looks and behaves like the app.
 *
 * The window is named after the app, so opening the same tile twice raises the
 * window that is already there instead of stacking a second one on top of it.
 */
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
  // Blocked by a pop-up setting, and the click would otherwise do nothing at
  // all. Say so by returning false; the caller falls back to a plain tab,
  // which is worse than what was asked for and much better than silence.
  if (!handle) return false;
  handle.focus();
  return true;
};

/**
 * A switchable tile has four states, and they are not the same thing:
 * off on purpose, coming up, running, and going down. "unreachable" would be
 * wrong for three of them.
 */
const switchLabel = (t: TorrentState | null): { text: string; action: string; on: boolean } => {
  if (!t || !t.reachable) return { text: 'cluster unreachable', action: '', on: false };
  if (t.wanted === 0 && t.ready > 0) return { text: 'stopping', action: '', on: true };
  if (t.wanted === 0) return { text: 'stopped', action: 'Start', on: false };
  if (t.ready === 0) return { text: 'starting', action: '', on: true };
  return { text: 'running', action: 'Stop', on: true };
};

export const AppsView = ({ apps, onOpenView }: { apps: AppTile[]; onOpenView: (view: string) => void }) => {
  const [torrent, setTorrentState] = useState<TorrentState | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const hasSwitch = apps.some((a) => a.switchable);

  // Polled only while a switchable tile is on screen, and only every few
  // seconds: this changes when somebody presses the button, not on its own.
  // Faster while something is mid-transition, so "starting" does not sit there
  // after the pod is up.
  useEffect(() => {
    if (!hasSwitch) return;
    let live = true;
    const read = () => { void getTorrent().then((t) => live && setTorrentState(t)).catch(() => {}); };
    read();
    const moving = torrent && torrent.reachable && (torrent.wanted ? torrent.ready === 0 : torrent.ready > 0);
    const timer = setInterval(read, moving ? 3000 : 15000);
    return () => { live = false; clearInterval(timer); };
  }, [hasSwitch, torrent?.wanted, torrent?.ready, torrent?.reachable]);

  /** What pressing a tile does. Shared by the click and the keyboard. */
  const open = (app: AppTile) => {
    if (isInternal(app.url)) return onOpenView(app.url.slice(1));
    if (app.healthy === false) return;
    if (app.switchable && !(torrent && torrent.wanted > 0 && torrent.ready > 0)) return;
    if (!openAsApp(app.name, app.url)) window.open(app.url, '_blank', 'noreferrer');
  };

  const flip = (running: boolean) => {
    setBusy(true);
    setProblem(null);
    void setTorrent(running)
      .then(setTorrentState)
      .catch((err: Error) => setProblem(err.message))
      .finally(() => setBusy(false));
  };

  const checked = apps.filter((a) => a.healthy !== null);
  const passing = apps.filter((a) => a.healthy).length;

  return (
    <div class="page-stack">
      <div class="page-heading">
        <div>
          <p class="eyebrow">
            APPLICATIONS <span class="mini-led" />
          </p>
          <h1>Your service shelf.</h1>
          <p class="subhead">Everything worth opening, one click away.</p>
        </div>
        <div class="app-summary">
          <strong>
            {passing} / {checked.length || apps.length}
          </strong>
          <span>health checks passing</span>
        </div>
      </div>

      {apps.length === 0 && (
        <div class="app-note">
          <Gauge size={18} />
          <div>
            <strong>No apps configured yet</strong>
            <span>Add entries to dashboard/server/apps.json and they appear here.</span>
          </div>
        </div>
      )}

      <div class="apps-grid">
        {apps.map((app, i) => {
          const sw = app.switchable ? switchLabel(torrent) : null;
          // A stopped workload is not a broken one, and its tile should not
          // offer to open a page that is not being served.
          const shut = app.healthy === false || (sw ? !sw.on : false);
          return (
          <div class="app-slot" key={app.name}>
          {/* A div, not an anchor. The browser link has to sit inside the tile:
              floated over a corner it collides with whatever the last row
              happens to be — on the torrent tile that is the VPN line — and
              reserving space for it truncates the status word beside it. In
              normal flow it does neither. A link inside a link is invalid, so
              the tile gives up being one. What that costs is cmd-click on the
              tile body, which was opening a pop-up window rather than a tab
              anyway; the browser link inside is a real anchor and keeps every
              gesture that mattered. */}
          <div
            class="app-tile"
            role="link"
            // healthy === null means the tile asked not to be probed, which is
            // not the same as failing one. Only a tile that actually answered
            // false is held shut; an unprobed one opens like any other, since
            // nothing here knows whether it is up.
            tabIndex={shut ? -1 : 0}
            aria-disabled={shut}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              open(app);
            }}
            onClick={(e) => {
              // The browser link is inside this tile. A click that started
              // there is not a click on the tile.
              if ((e.target as HTMLElement).closest('.app-browser')) return;
              open(app);
            }}
          >
            <div class={`app-icon ${isArt(app.icon) ? 'art' : ACCENTS[i % ACCENTS.length]}`}>
              {isArt(app.icon) ? (
                <img src={app.icon} alt="" loading="lazy" />
              ) : (
                <span>{app.icon ?? app.name[0]}</span>
              )}
            </div>
            <div class="app-info">
              <strong>{app.name}</strong>
              <span>{app.nodeId ?? 'fleet'}</span>
              <small>{isInternal(app.url) ? 'in this console' : new URL(app.url).port ? `:${new URL(app.url).port}` : ''}</small>
            </div>
            <div class="app-health">
              {/* A switchable tile is not probed — a stopped workload would
                  fail a health check by design, and reporting that as
                  "unreachable" would be describing the intent as a fault. Its
                  light follows the cluster instead: green only once the pod is
                  actually up, not merely asked for. */}
              <StatusDot online={sw ? sw.text === 'running' : !!app.healthy} size="sm" />
              <span>
                {sw ? sw.text : app.healthy === null ? 'not checked' : app.healthy ? 'healthy' : 'unreachable'}
              </span>
              {/* The other half of the choice: the tile gives you the app, this
                  gives you a browser tab. On the status row rather than in a
                  corner, so it takes no height of its own and cannot land on
                  top of anything. */}
              {!isInternal(app.url) && !shut && (
                <a
                  class="app-browser"
                  href={app.url}
                  target="_blank"
                  rel="noreferrer"
                  title={`Open ${app.name} in a browser tab instead of its own window`}
                >
                  ( Open in Browser )
                </a>
              )}
            </div>
            {/* Read from gluetun, not inferred from the pod being up. Running
                and protected are different claims, and this is the one worth
                seeing before a download starts — from a phone, with no
                terminal anywhere near it. */}
            {sw && torrent?.vpn && (
              <div class={`app-vpn ${torrent.vpn.publicIp ? 'up' : ''}`}>
                <Shield size={11} />
                <span>
                  {torrent.vpn.publicIp
                    ? `via ${torrent.vpn.publicIp}${torrent.vpn.country ? ` · ${torrent.vpn.country}` : ''}`
                    : torrent.vpn.status === 'running'
                      ? 'tunnel up, address pending'
                      : 'tunnel not up yet'}
                </span>
              </div>
            )}
          </div>
          {sw && sw.action && (
            <button
              class={`app-power ${sw.on ? 'on' : ''}`}
              disabled={busy}
              onClick={() => flip(!sw.on)}
              title={
                sw.on
                  ? 'Stop the client and drop the VPN with it'
                  : 'Bring the VPN up, then the client. Nothing sends until the tunnel is ready.'
              }
            >
              <Power size={12} />{busy ? '…' : sw.action}
            </button>
          )}
          </div>
        );})}
      </div>

      {problem && (
        <div class="app-note bad">
          <Gauge size={18} />
          <div><strong>That did not work</strong><span>{problem}</span></div>
        </div>
      )}

      {apps.length > 0 && (
        <div class="app-note">
          <Gauge size={18} />
          <div>
            <strong>Health checks run on every poll</strong>
            <span>A tile is reachable when its URL answers within two seconds.</span>
          </div>
        </div>
      )}
    </div>
  );
};
