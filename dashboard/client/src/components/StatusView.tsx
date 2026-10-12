import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ActiveUse, AppTile, ContentStatus, TorrentState } from '../../../shared/fleet';
import { getStatus, getTorrent, setTorrent, usePoll } from '../lib/api';
import { bytes } from '../lib/format';
import { openApp } from '../lib/open';

/** Older than this, "who is using what" is history, not now. */
const STALE_MS = 3 * 60_000;

const isArt = (icon: string | null | undefined): icon is string =>
  !!icon && (icon.startsWith('/') || icon.startsWith('http'));

/** "admin is uploading 4.2 Mbit/s", the first of several with a count. */
const nowLine = (uses: ActiveUse[]): string | null => {
  if (!uses.length) return null;
  const [u] = uses;
  // Jellyfin's own sessions name the film; pi-paths already starts with a verb.
  const what = u.what.startsWith('"') ? `watching ${u.what}` : u.what;
  return `${u.who} is ${what}${uses.length > 1 ? ` · +${uses.length - 1} more` : ''}`;
};

const torrentLine = (t: TorrentState | null): { text: string; on: boolean; bad?: boolean } => {
  if (!t) return { text: 'Checking…', on: false };
  if (!t.reachable) return { text: 'Cluster unreachable', on: false, bad: true };
  if (t.wanted === 0) return { text: t.ready > 0 ? 'Stopping…' : 'Off', on: false };
  if (t.ready === 0) return { text: 'Starting…', on: true };
  const v = t.vpn;
  if (!v?.publicIp) return { text: 'On · waiting for the VPN', on: true };
  const where = [v.city, v.country].filter(Boolean).join(', ');
  return { text: ['On', v.provider, where, v.publicIp].filter(Boolean).join(' · '), on: true };
};

interface RowProps {
  name: string;
  app?: AppTile;
  letter: string;
  accent: string;
  sub: string | null;
  tone?: 'busy' | 'bad' | null;
  value?: string;
  value2?: string;
  /** False holds the row shut, e.g. qBittorrent while the switch is off. */
  canOpen?: boolean;
  right?: ComponentChildren;
}

const Row = ({ name, app, letter, accent, sub, tone, value, value2, canOpen = true, right }: RowProps) => {
  const opens = !!app && canOpen && !right;
  const go = (e: MouseEvent | KeyboardEvent | null) => { if (opens && app) openApp(e, app.name, app.url); };
  return (
    <div
      class={`srow${opens ? ' opens' : ''}`}
      role={opens ? 'link' : undefined}
      tabIndex={opens ? 0 : undefined}
      title={opens ? `Open ${name} · ⌘, Ctrl or Shift-click for a browser tab` : undefined}
      onClick={(e) => go(e)}
      onAuxClick={(e) => { if (e.button === 1) go(e); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(e); } }}
    >
      <div class={`sico ${isArt(app?.icon) ? 'art' : accent}`}>
        {isArt(app?.icon) ? <img src={app!.icon!} alt="" loading="lazy" /> : <span>{letter}</span>}
      </div>
      <div class="smain">
        <span class="st">{name}</span>
        <span class={`ss${tone ? ` ${tone}` : ''}`}>{sub ?? 'No one using it'}</span>
      </div>
      {right ?? (
        <>
          {(value || value2) && (
            <span class="svv">
              {value && <span class="sv">{value}</span>}
              {value2 && <span class="sv2">{value2}</span>}
            </span>
          )}
          {opens && <span class="schev">›</span>}
        </>
      )}
    </div>
  );
};

/** One line under an app: a user and their share. Not clickable. */
const SubRow = ({ name, value }: { name: string; value: string }) => (
  <div class="srow sub">
    <div class="smain"><span class="st">{name}</span></div>
    <span class="sv">{value}</span>
  </div>
);

const count = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? '' : 's'}`;

export const StatusView = ({ apps }: { apps: AppTile[] }) => {
  const feed = usePoll(getStatus, 30_000);
  const [torrent, setTorrentState] = useState<TorrentState | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // As on the Apps tab: slow while nothing is changing, quick mid-transition.
  useEffect(() => {
    let live = true;
    const read = () => { void getTorrent().then((t) => live && setTorrentState(t)).catch(() => {}); };
    read();
    const moving = torrent && torrent.reachable && (torrent.wanted ? torrent.ready === 0 : torrent.ready > 0);
    const timer = setInterval(read, moving ? 3000 : 15000);
    return () => { live = false; clearInterval(timer); };
  }, [torrent?.wanted, torrent?.ready, torrent?.reachable]);

  const flip = (running: boolean) => {
    setBusy(true);
    setProblem(null);
    void setTorrent(running)
      .then(setTorrentState)
      .catch((err: Error) => setProblem(err.message))
      .finally(() => setBusy(false));
  };

  const status: ContentStatus | null = feed.data ?? null;
  const fresh = !!status && Date.now() - status.ts * 1000 < STALE_MS;
  const app = (name: string) => apps.find((a) => a.name === name);
  const uses = (name: string) => (fresh ? status!.active.filter((a) => a.app === name) : []);

  /** The line under an app's name: who is on it, unless it is not answering. */
  const sub = (tile: AppTile | undefined, appName: string): Pick<RowProps, 'sub' | 'tone'> => {
    if (tile?.healthy === false) return { sub: 'Not answering', tone: 'bad' };
    const line = nowLine(uses(appName));
    return line ? { sub: line, tone: 'busy' } : { sub: null };
  };
  const upDown = (tile: AppTile | undefined) =>
    tile?.healthy === true ? 'Up' : tile?.healthy === false ? 'Down' : '';

  const jf = status?.jellyfin ?? null;
  const kx = status?.kiwix ?? null;
  const im = status?.immich ?? null;
  const tl = torrentLine(torrent);
  const qb = app('qBittorrent');
  const osint = (name: string) => {
    const tile = app(name);
    return tile?.healthy
      ? { sub: null, value: 'Up' }
      : { sub: 'Not on the PC yet', value: 'not live' };
  };

  return (
    <div class="page-stack">
      <div class="page-heading">
        <div>
          <p class="eyebrow">STATUS <span class="mini-led" /></p>
          <h1>Your content, at a glance.</h1>
          <p class="subhead">Each app, who is using it and what they are doing. Click to open; ⌘-click for a browser tab.</p>
        </div>
      </div>

      <div class="sgroups">
        <div class="sstack">
          <div class="sgrp">
            <h3>Media</h3>
            <div class="slist">
              <Row name="Jellyfin" app={app('Jellyfin')} letter="J" accent="purple" {...sub(app('Jellyfin'), 'Jellyfin')}
                value={jf ? `${jf.films} films · ${jf.series} series` : undefined}
                value2={jf?.bytes != null ? bytes(jf.bytes, 0) : undefined} />
              <Row name="Kiwix" app={app('Kiwix')} letter="K" accent="green" {...sub(app('Kiwix'), 'Kiwix')}
                value={kx ? `${kx.books} ${kx.books === 1 ? 'book' : 'books'} · ${bytes(kx.bytes, 0)}` : undefined} />
              <Row name="Torrent" letter="T" accent="orange" sub={tl.text} tone={tl.bad ? 'bad' : tl.on ? 'busy' : null}
                right={
                  <button
                    class={`stog${tl.on ? ' on' : ''}`}
                    disabled={busy || !torrent?.reachable || (torrent.wanted === 0 ? torrent.ready > 0 : torrent.ready === 0)}
                    aria-label="Torrent"
                    aria-pressed={tl.on}
                    title={tl.on ? 'Stop the client and drop the VPN with it' : 'Bring the VPN up, then the client'}
                    onClick={() => flip(!tl.on)}
                  />
                } />
              <Row name="qBittorrent" app={qb} letter="q" accent="blue"
                canOpen={!!torrent && torrent.wanted > 0 && torrent.ready > 0}
                sub={tl.on ? nowLine(uses('Torrent')) ?? 'Open it to see what is downloading' : 'Off · switch Torrent on to use it'}
                tone={tl.on && uses('Torrent').length ? 'busy' : null} />
            </div>
          </div>

          <div class="sgrp">
            <h3>OSINT</h3>
            <div class="slist">
              <Row name="OSINT" app={app('OSINT')} letter="O" accent="blue" canOpen={!!app('OSINT')?.healthy} {...osint('OSINT')} />
              <Row name="OSINT News" app={app('OSINT News')} letter="N" accent="blue" canOpen={!!app('OSINT News')?.healthy} {...osint('OSINT News')} />
            </div>
          </div>

          <div class="sgrp">
            <h3>Watching over it</h3>
            <div class="slist">
              <Row name="Uptime Kuma" app={app('Uptime')} letter="U" accent="green"
                sub={app('Uptime')?.healthy === false ? 'Not answering' : 'Monitor counts come with a Kuma key'}
                tone={app('Uptime')?.healthy === false ? 'bad' : null} value={upDown(app('Uptime'))} />
            </div>
          </div>
        </div>

        <div class="sgrp">
          <h3>Cloud</h3>
          <div class="slist">
            <Row name="Nextcloud" app={app('Nextcloud')} letter="N" accent="blue" {...sub(app('Nextcloud'), 'Nextcloud')} value={upDown(app('Nextcloud'))} />
            <Row name="Immich" app={app('Photos')} letter="I" accent="orange" {...sub(app('Photos'), 'Immich')}
              value={im ? `${bytes(im.bytes, 1)} · ${count(im.photos, 'photo')}` : upDown(app('Photos'))}
              value2={im ? count(im.videos, 'video') : undefined} />
            {im?.users.map((u) => (
              <SubRow key={u.name} name={u.name}
                value={`${bytes(u.bytes, 1)} · ${count(u.photos, 'photo')} · ${count(u.videos, 'video')}`} />
            ))}
            <Row name="Vaultwarden" app={app('Vault')} letter="V" accent="purple" {...sub(app('Vault'), 'Vaultwarden')} value={upDown(app('Vault'))} />
            <Row name="ArchiveBox" app={app('ArchiveBox')} letter="A" accent="pink" {...sub(app('ArchiveBox'), 'ArchiveBox')} value={upDown(app('ArchiveBox'))} />
          </div>
          <p class="sfoot">
            Space used and each user's share for Nextcloud{im ? '' : ', Immich'} and ArchiveBox, Kuma's monitors and
            qBittorrent's downloads arrive as each app's key goes in.
          </p>
        </div>
      </div>

      {!status && !feed.loading && (
        <p class="sfoot">Who is using what appears once the PC writes it (pi-status.timer, every 30 s).</p>
      )}
      {status && !fresh && (
        <p class="sfoot">
          Who is using what was last written {Math.round((Date.now() - status.ts * 1000) / 60_000)} min ago, so it is
          not shown: sudo systemctl status pi-status.timer
        </p>
      )}
      {problem && <p class="sfoot bad">The switch did not work: {problem}</p>}
    </div>
  );
};
