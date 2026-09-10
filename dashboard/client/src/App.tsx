/**
 * The console: a narrow macOS-style menu bar on top (brand, live, theme,
 * refresh, clock), the boards centered in the remaining space, launcher
 * rail beside them. Polling is unchanged: the fleet every few seconds,
 * the app probes on a slower cadence.
 */

import { useMemo, useState } from 'preact/hooks';
import { PiCard, type RailNode } from './components/PiCard';
import { ServicesPane } from './components/ServicesPane';
import { Grid, Key, Moon, Power, Refresh, Server, Sun, Thermo } from './components/icons';
import { getApps, getCredentials, getNodes, useHistory, usePoll, usePowerHistory, useNetHistory } from './lib/api';
import { celsius, watts } from './lib/format';

type View = 'fleet' | 'apps';

const POLL_MS = 3000;

const isDark = () =>
  document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : !matchMedia('(prefers-color-scheme: light)').matches;

/** The boards, not every machine on the tailnet. */
const isBoard = (model: string | null) => !!model && model.startsWith('Raspberry Pi');

/** Each board's job — shown beside its name at the top of the card. */
const PURPOSE: Record<string, string> = { jug: 'OSINT', jug2: 'LAB' };


export default function App() {
  const [view, setView] = useState<View>('fleet');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [spin, setSpin] = useState(false);

  const fleet = usePoll(getNodes, POLL_MS);
  const apps = usePoll(getApps, 15_000);
  const creds = usePoll(getCredentials, 300_000);
  const history = useHistory(fleet.data);
  const powerHistory = usePowerHistory(fleet.data);
  const netHistory = useNetHistory(fleet.data);

  const boards = useMemo<RailNode[]>(
    () => (fleet.data ?? []).filter((n) => isBoard(n.model)).map((n) => ({ ...n, label: PURPOSE[n.name] ?? '' })),
    [fleet.data],
  );

  const temps = boards.map((b) => b.temp?.cpuC).filter((t): t is number => t != null);
  const topTemp = temps.length ? Math.max(...temps) : null;
  const totalWatts = boards.reduce((a, b) => a + (b.power?.watts ?? 0), 0);
  const tsKey = (creds.data ?? []).find((c) => /tailscale/i.test(c.name));
  const allOnline = boards.length > 0 && boards.every((n) => n.online && !n.error);

  const refresh = () => {
    setSpin(true);
    setTimeout(() => setSpin(false), 520);
    fleet.refresh();
    apps.refresh();
  };

  const toggleTheme = () => {
    document.documentElement.dataset.theme = isDark() ? 'light' : 'dark';
    try { localStorage.setItem('appearance', document.documentElement.dataset.theme!); } catch { /* private mode */ }
  };

  return (
    <div class="console">
      <header class="menubar">
        <div class="mb-left">
          <span class="mb-stat" title="fleet draw">
            <Power size={12} /><b>{watts(totalWatts)}</b>
          </span>
          <span class="mb-stat" title="hottest board">
            <Thermo size={12} /><b>{topTemp != null ? celsius(topTemp) : '—'}</b>
          </span>
          <span class={`mb-stat ${tsKey?.state === 'expired' ? 't-red' : tsKey?.state === 'soon' ? 't-yellow' : ''}`} title="Tailscale key expiry">
            <Key size={12} /><b>{tsKey?.daysLeft != null ? `${tsKey.daysLeft}d` : '—'}</b>
          </span>
          <span class="mb-stat" title={allOnline ? 'all nodes reachable' : 'some nodes offline'}>
            <span class={`dot-live ${allOnline ? '' : 'off'}`} /><span class="mb-vpn">VPN</span>
          </span>
        </div>

        <nav class="mb-center">
          <button class={`nav-btn ${view === 'fleet' ? 'on' : ''}`} onClick={() => setView('fleet')}>
            <Server size={13} /> Fleet
          </button>
          <button class={`nav-btn ${view === 'apps' ? 'on' : ''}`} onClick={() => setView('apps')}>
            <Grid size={13} /> Apps
          </button>
        </nav>

        <div class="mb-right">
          <span class={`live ${fleet.error ? 'down' : ''}`}>
            <i />{fleet.error ? 'OFFLINE' : 'LIVE'}
          </span>
          <button class="icon-btn" onClick={toggleTheme} title="Switch appearance" aria-label="Switch appearance">
            <span class="i-moon"><Moon size={14} /></span>
            <span class="i-sun"><Sun size={14} /></span>
          </button>
          <button class={`icon-btn ${spin ? 'spin' : ''}`} onClick={refresh} title="Refresh" aria-label="Refresh">
            <Refresh size={14} />
          </button>
        </div>
      </header>

      <main class={`layout ${view}`}>
        {view === 'fleet' ? (
          <div class="pis">
            {boards.map((board) => (
              <PiCard
                key={board.id}
                node={board}
                expanded={expandedId === board.id}
                onToggle={() => setExpandedId(expandedId === board.id ? null : board.id)}
                history={history.get(board.id) ?? []}
                powerHistory={powerHistory.get(board.id) ?? []}
                netHistory={netHistory.get(board.id) ?? []}
              />
            ))}
            {!boards.length && (
              <div class="pis-empty">
                {fleet.loading ? 'Scanning the tailnet…' : 'No Pi boards on the tailnet.'}
              </div>
            )}
          </div>
        ) : (
          <ServicesPane apps={apps.data ?? []} error={apps.error} />
        )}
      </main>
    </div>
  );
}
