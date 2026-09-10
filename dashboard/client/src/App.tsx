import { useMemo, useState } from 'preact/hooks';
import { AppsView } from './components/AppsView';
import { DetailView } from './components/DetailView';
import { FilesView } from './components/FilesView';
import { FleetView } from './components/FleetView';
import { Alert, Box, Grid, Key, Moon, Power, Refresh, Sun, Thermo, Wifi } from './components/icons';
import { getApps, getCredentials, getNodes, useHistory, useNetHistory, usePoll, usePowerHistory } from './lib/api';
import { celsius, watts } from './lib/format';

const POLL_MS = 3000;

type View = 'fleet' | 'detail' | 'apps' | 'files';

/**
 * A tile's `#name` is config, so it is checked against the views that exist
 * rather than cast. A typo in apps.json used to switch to a view nothing
 * renders, leaving the page blank with no way back but the toolbar.
 */
const VIEWS: View[] = ['fleet', 'detail', 'apps', 'files'];
const asView = (name: string): View | null =>
  (VIEWS as string[]).includes(name) ? (name as View) : null;

const isDark = () =>
  document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;

export default function App() {
  const [view, setView] = useState<View>('fleet');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [spin, setSpin] = useState(false);

  const fleet = usePoll(getNodes, POLL_MS);
  const apps = usePoll(getApps, 15_000);
  const creds = usePoll(getCredentials, 300_000);
  const history = useHistory(fleet.data);
  const powerHistory = usePowerHistory(fleet.data);
  const netHistory = useNetHistory(fleet.data);

  const nodes = useMemo(() => fleet.data ?? [], [fleet.data]);
  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const liveNodes = nodes.filter((n) => n.online && !n.error);
  const powered = liveNodes.filter((n) => n.power);
  const totalW = powered.reduce((s, n) => s + (n.power?.watts ?? 0), 0);
  const hot = liveNodes.reduce<typeof nodes[0] | null>((a, n) => ((n.temp?.cpuC ?? -1) > (a?.temp?.cpuC ?? -1) ? n : a), null);
  const tsKey = (creds.data ?? []).find((c) => /tailscale/i.test(c.name));
  const allOnline = nodes.length > 0 && nodes.every((n) => n.online && !n.error);

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
        <div class="tb-left">
          <span class="tb-stat" title="fleet draw">
            <Power size={12} /><b>{watts(totalW)}</b>
          </span>
          <span class="tb-stat" title="hottest board">
            <Thermo size={12} /><b>{hot?.temp?.cpuC != null ? celsius(hot.temp.cpuC) : '—'}</b>
          </span>
          <span class={`tb-stat ${tsKey?.state === 'expired' ? 'crit' : tsKey?.state === 'soon' ? 'warn' : ''}`} title="Tailscale key expiry">
            <Key size={12} /><b>{tsKey?.daysLeft != null ? `${tsKey.daysLeft}d` : '—'}</b>
          </span>
          <span class="tb-stat" title={allOnline ? 'all nodes reachable' : 'some nodes offline'}>
            <span class={`dot-live ${allOnline ? '' : 'off'}`} /><span class="tb-label">VPN</span>
          </span>
        </div>

        <div class="tb-center">
          <button class={`tbtn ${view === 'fleet' || view === 'detail' ? 'on' : ''}`} onClick={() => setView('fleet')}>
            <Grid size={15} /> Fleet
          </button>
          <button class={`tbtn ${view === 'apps' ? 'on' : ''}`} onClick={() => setView('apps')}>
            <Box size={15} /> Apps
          </button>
        </div>

        <div class="tb-right">
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
      </div>

      <div class="content">
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

        {view === 'fleet' && fleet.data && (
          <FleetView
            nodes={nodes}
            onOpen={openDetail}
            tempHistory={history}
            powerHistory={powerHistory}
            netHistory={netHistory}
          />
        )}
        {view === 'apps' && (
          <AppsView
            apps={apps.data ?? []}
            onOpenView={(next) => {
              const target = asView(next);
              if (target) setView(target);
            }}
          />
        )}
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

    </section>
  );
}
