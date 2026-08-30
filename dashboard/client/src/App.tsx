import { useMemo, useState } from 'react';
import { AlertTriangle, Box, LayoutGrid, RefreshCw, Server, Wifi } from 'lucide-react';
import type { AppTile } from '../../shared/fleet';
import { AppsView } from './components/AppsView';
import { DetailView } from './components/DetailView';
import { FleetView } from './components/FleetView';
import { getNodes, useHistory, usePoll } from './lib/api';
import { relative } from './lib/format';

const POLL_MS = 3000;

const fetchApps = async (): Promise<AppTile[]> => {
  const res = await fetch('/api/apps', { cache: 'no-store' });
  return res.ok ? ((await res.json()) as AppTile[]) : [];
};

export default function App() {
  const [view, setView] = useState<'fleet' | 'detail' | 'apps'>('fleet');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const fleet = usePoll(getNodes, POLL_MS);
  const apps = usePoll(fetchApps, 15_000);
  const history = useHistory(fleet.data);

  const nodes = useMemo(() => fleet.data ?? [], [fleet.data]);
  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const online = nodes.filter((n) => n.online && !n.error).length;

  const openDetail = (id: string) => {
    setSelectedId(id);
    setView('detail');
  };

  return (
    <main className="mac-desktop">
      <section className="window-shell">
        <header className="window-titlebar">
          <div className="traffic-lights">
            <button className="traffic red" aria-label="Close" />
            <button className="traffic yellow" aria-label="Minimize" />
            <button className="traffic green" aria-label="Maximize" />
          </div>
          <div className="window-title">
            <Server size={14} /> Tailnet Console
          </div>
          <div className="window-actions">
            <button onClick={fleet.refresh} title="Refresh telemetry">
              <RefreshCw size={15} />
            </button>
          </div>
        </header>

        <div className="toolbar">
          <button
            className={`toolbar-button ${view === 'fleet' ? 'active' : ''}`}
            onClick={() => setView('fleet')}
          >
            <LayoutGrid size={16} /> Fleet
          </button>
          <button
            className={`toolbar-button ${view === 'apps' ? 'active' : ''}`}
            onClick={() => setView('apps')}
          >
            <Box size={16} /> Apps
          </button>
          <div className="toolbar-divider" />
          <span className="toolbar-caption">
            {view === 'fleet' ? 'All nodes' : view === 'apps' ? 'Service launcher' : (selected?.name ?? '')}
          </span>
          <div className="toolbar-spacer" />
          <div className="live-pill">
            <span className="live-dot" /> LIVE
          </div>
        </div>

        <div className="content-wrap">
          {fleet.error && (
            <div className="warning-banner">
              <AlertTriangle size={18} />
              <div>
                <strong>Cannot reach the fleet</strong>
                <span>{fleet.error}</span>
              </div>
            </div>
          )}

          {fleet.loading && !fleet.data && (
            <div className="discovery-banner">
              <div className="discovery-icon">
                <Wifi size={19} />
              </div>
              <div>
                <strong>Scanning the tailnet</strong>
                <span>Discovering nodes and probing their agents.</span>
              </div>
            </div>
          )}

          {view === 'fleet' && fleet.data && <FleetView nodes={nodes} onOpen={openDetail} />}
          {view === 'apps' && <AppsView apps={apps.data ?? []} />}
          {view === 'detail' && selected && (
            <DetailView
              node={selected}
              history={history.get(selected.id) ?? []}
              onBack={() => setView('fleet')}
            />
          )}
          {/* A node can vanish mid-session if it drops off the tailnet. */}
          {view === 'detail' && !selected && fleet.data && (
            <div className="warning-banner">
              <AlertTriangle size={18} />
              <div>
                <strong>Node is no longer on the tailnet</strong>
                <span>
                  <button className="back-link" onClick={() => setView('fleet')}>
                    Back to Fleet
                  </button>
                </span>
              </div>
            </div>
          )}
        </div>

        <footer className="statusbar">
          <span>
            <Wifi size={13} /> Tailnet adapter · live telemetry
          </span>
          <span>
            Last scan {fleet.updatedAt ? relative(fleet.updatedAt.toISOString()) : '—'} · {nodes.length}{' '}
            nodes · {online} online
          </span>
        </footer>
      </section>
    </main>
  );
}
