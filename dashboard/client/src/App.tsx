import { useMemo, useState } from 'preact/hooks';
import type { AppTile } from '../../shared/fleet';
import { AppsView } from './components/AppsView';
import { DetailView } from './components/DetailView';
import { FilesView } from './components/FilesView';
import { FleetView, type SortKey, SORT_COLUMNS } from './components/FleetView';
import { Alert, Box, Disk, Grid, Moon, Refresh, Sun, Wifi } from './components/icons';
import { getNodes, useHistory, usePoll } from './lib/api';
import { relative } from './lib/format';

const POLL_MS = 3000;

const fetchApps = async (): Promise<AppTile[]> => {
  const res = await fetch('/api/apps', { cache: 'no-store' });
  return res.ok ? ((await res.json()) as AppTile[]) : [];
};

const isDark = () =>
  document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;

export default function App() {
  const [view, setView] = useState<'fleet' | 'detail' | 'apps' | 'files'>('fleet');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('cpuPct');
  const [spin, setSpin] = useState(false);

  const fleet = usePoll(getNodes, POLL_MS);
  const apps = usePoll(fetchApps, 15_000);
  const history = useHistory(fleet.data);

  const nodes = useMemo(() => fleet.data ?? [], [fleet.data]);
  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const online = nodes.filter((n) => n.online && !n.error).length;

  const openDetail = (id: string) => { setSelectedId(id); setView('detail'); };

  const refresh = () => {
    setSpin(true);
    setTimeout(() => setSpin(false), 520);
    fleet.refresh();
  };

  const toggleTheme = () => {
    document.documentElement.dataset.theme = isDark() ? 'light' : 'dark';
    try { localStorage.setItem('appearance', document.documentElement.dataset.theme!); } catch { /* private mode */ }
  };

  return (
    <section class="shell">
      <div class="toolbar">
        <span class="brand"><img src="/icon.svg" alt="" width="20" height="20" /><b>Pi</b></span>
        <button class={`tbtn ${view === 'fleet' || view === 'detail' ? 'on' : ''}`} onClick={() => setView('fleet')}>
          <Grid size={15} /> Fleet
        </button>
        <button class={`tbtn ${view === 'apps' ? 'on' : ''}`} onClick={() => setView('apps')}>
          <Box size={15} /> Apps
        </button>
        <button class={`tbtn ${view === 'files' ? 'on' : ''}`} onClick={() => setView('files')}>
          <Disk size={15} /> Storage
        </button>
        <span class="spacer" />
        <span class="live"><span class="dot-live" /> LIVE</span>
        <span class="tdiv" />
        <button class="ibtn" onClick={toggleTheme} title="Switch appearance" aria-label="Switch appearance">
          <span class="i-moon"><Moon size={15} /></span>
          <span class="i-sun"><Sun size={15} /></span>
        </button>
        <button class={`ibtn ${spin ? 'spin' : ''}`} id="refresh" onClick={refresh} title="Refresh" aria-label="Refresh">
          <Refresh size={15} />
        </button>
      </div>

      <div class="content">
        <div class="head">
          <div class="head-l">
            <h1>{view === 'apps' ? 'Apps' : view === 'files' ? 'Storage' : view === 'detail' ? (selected?.name ?? 'Node') : 'Fleet'}</h1>
            <p class="head-sub"><span class="mini-led" /> {fleet.error ? 'OFFLINE' : 'SCANNING'}</p>
          </div>
          {view === 'fleet' && (
            <div class="head-r">
              <span class="seg-label">SORT BY</span>
              <div class="seg">
                {SORT_COLUMNS.map((c) => (
                  <button key={c.key} class={c.key === sort ? 'on' : ''} onClick={() => setSort(c.key)}>
                    {c.tab}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {fleet.error && (
          <div class="warning-banner">
            <Alert size={18} />
            <div><strong>Cannot reach the fleet</strong><span>{fleet.error}</span></div>
          </div>
        )}

        {fleet.loading && !fleet.data && (
          <div class="discovery-banner">
            <div class="discovery-icon"><Wifi size={19} /></div>
            <div><strong>Scanning the tailnet</strong><span>Discovering nodes and probing their agents.</span></div>
          </div>
        )}

        {view === 'fleet' && fleet.data && <FleetView nodes={nodes} sort={sort} onOpen={openDetail} />}
        {view === 'apps' && <AppsView apps={apps.data ?? []} />}
        {view === 'files' && <FilesView nodes={nodes} />}
        {view === 'detail' && selected && (
          <DetailView node={selected} history={history.get(selected.id) ?? []} onBack={() => setView('fleet')} />
        )}
        {view === 'detail' && !selected && fleet.data && (
          <div class="warning-banner">
            <Alert size={18} />
            <div>
              <strong>Node is no longer on the tailnet</strong>
              <span><button class="back-link" onClick={() => setView('fleet')}>Back to Fleet</button></span>
            </div>
          </div>
        )}
      </div>

      <footer class="statusbar">
        <span><Wifi size={13} /> Tailnet adapter · live telemetry</span>
        <span>
          Last scan {fleet.updatedAt ? relative(fleet.updatedAt.toISOString()) : '—'} · {nodes.length} nodes · {online} online
        </span>
      </footer>
    </section>
  );
}
