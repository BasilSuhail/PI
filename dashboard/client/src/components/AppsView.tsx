import { useEffect, useState } from 'preact/hooks';
import { Chevron, Gauge, Power, Shield } from './icons';
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
          <a
            class="app-tile"
            // healthy === null means the tile asked not to be probed, which is
            // not the same as failing one. Only a tile that actually answered
            // false is held shut; an unprobed one opens like any other, since
            // nothing here knows whether it is up.
            href={shut ? undefined : app.url}
            target={isInternal(app.url) ? undefined : '_blank'}
            rel="noreferrer"
            onClick={(e) => {
              if (isInternal(app.url)) {
                e.preventDefault();
                onOpenView(app.url.slice(1));
              } else if (shut) {
                e.preventDefault();
              }
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
              <StatusDot online={sw ? sw.on && !!app.healthy : !!app.healthy} size="sm" />
              <span>
                {sw ? sw.text : app.healthy === null ? 'not checked' : app.healthy ? 'healthy' : 'unreachable'}
              </span>
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
            <Chevron size={16} class="app-arrow" />
          </a>
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
