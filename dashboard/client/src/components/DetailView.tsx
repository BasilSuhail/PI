import { useEffect, useState } from 'react';
import {
  AlertTriangle, ArrowDownToLine, ArrowLeft, ArrowUpFromLine, Box, Cpu,
  HardDrive, ListFilter, MemoryStick, Network, Power, Thermometer, Wifi,
} from 'lucide-react';
import type { ContainerRow, FleetNode, ProcessRow } from '../../../shared/fleet';
import { getContainers, getProcesses } from '../lib/api';
import { bytes, bytesPerSec, capacity, cpuTone, diskTone, pct, uptime } from '../lib/format';
import { Meter, PanelTitle, Sparkline, StatusDot } from './primitives';

type Sort = 'cpu' | 'ram';

export const DetailView = ({
  node,
  history,
  onBack,
}: {
  node: FleetNode;
  history: number[];
  onBack: () => void;
}) => {
  const [sort, setSort] = useState<Sort>('cpu');
  const [processes, setProcesses] = useState<ProcessRow[]>([]);
  const [containers, setContainers] = useState<ContainerRow[]>([]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [p, c] = await Promise.all([
        getProcesses(node.id).catch(() => []),
        getContainers(node.id).catch(() => []),
      ]);
      if (!alive) return;
      setProcesses(p);
      setContainers(c);
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [node.id]);

  const sorted = [...processes].sort((a, b) =>
    sort === 'cpu' ? b.cpuPct - a.cpuPct : b.memBytes - a.memBytes,
  );

  const mem = node.mem;
  const load = node.cpu?.loadAvg ?? [0, 0, 0];
  const throttled = node.temp?.throttled;
  const temp = node.temp?.cpuC ?? 0;

  // Glances reports used/available; cache is the gap between them and free.
  const cacheBytes = mem ? Math.max(mem.availableBytes - (mem.totalBytes - mem.usedBytes), 0) : 0;
  const freeBytes = mem ? mem.totalBytes - mem.usedBytes - cacheBytes : 0;

  return (
    <div className="page-stack">
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={15} /> Back to Fleet
      </button>

      <div className="detail-heading">
        <div>
          <p className="eyebrow">
            <span className="mini-led" /> NODE DETAIL
          </p>
          <h1>
            {node.name} <span className="title-chip">{node.role}</span>
          </h1>
          <p className="subhead">
            {node.tailscaleIp} · {node.model ?? node.os ?? 'unknown hardware'} · up {uptime(node.uptimeSec)}
          </p>
        </div>
        <StatusDot online={node.online} />
      </div>

      {throttled?.now && (
        <div className="warning-banner">
          <AlertTriangle size={18} />
          <div>
            <strong>Throttling right now</strong>
            <span>{throttled.reasons.join(', ')}</span>
          </div>
        </div>
      )}
      {!throttled?.now && throttled?.everSinceBoot && (
        <div className="warning-banner">
          <AlertTriangle size={18} />
          <div>
            <strong>Throttled at some point since boot</strong>
            <span>{throttled.reasonsSinceBoot.join(', ')} · not happening now</span>
          </div>
        </div>
      )}

      <div className="detail-grid">
        <section className="panel cpu-panel">
          <PanelTitle
            icon={<Cpu />}
            title="Processor"
            meta={`load average ${load.map((l) => l.toFixed(2)).join(' · ')}`}
          />
          <div className="core-list">
            {(node.cpu?.perCore ?? []).map((value, index) => (
              <div className="core-row" key={index}>
                <span>core {index}</span>
                <Meter value={value} tone={cpuTone(value)} />
                <strong>{pct(value)}</strong>
              </div>
            ))}
          </div>
          <div className="panel-foot">
            <span>cores</span>
            <strong>{node.cpu?.cores ?? '—'}</strong>
            <span>arch</span>
            <strong>{node.arch ?? '—'}</strong>
          </div>
        </section>

        <section className="panel temp-panel">
          <PanelTitle icon={<Thermometer />} title="Thermals" meta={`last ${history.length} samples`} />
          <div className="temp-reading">
            <strong>{Math.round(temp)}°</strong>
            <span>CPU temperature</span>
          </div>
          <Sparkline series={history} />
          <div className="sparkline-labels">
            <span>earlier</span>
            <span>now</span>
          </div>
          <div className="temp-status">
            <span className="check-mark">{temp > 80 ? '!' : '✓'}</span>
            {temp > 80 ? 'thermal zone hot' : 'thermal zone nominal'}
            <strong>limit 85°</strong>
          </div>
        </section>

        <section className="panel memory-panel">
          <PanelTitle icon={<MemoryStick />} title="Memory" meta={`${capacity(mem?.totalBytes)} installed`} />
          <div className="memory-bar">
            <span style={{ width: `${mem?.usedPct ?? 0}%` }} />
          </div>
          <div className="memory-legend">
            <span>
              <i className="dot used" /> used <strong>{bytes(mem?.usedBytes)}</strong>
            </span>
            <span>
              <i className="dot cache" /> cache <strong>{bytes(cacheBytes)}</strong>
            </span>
            <span>
              <i className="dot free" /> free <strong>{bytes(freeBytes)}</strong>
            </span>
            <span>
              <i className="dot swap" /> swap <strong>{bytes(mem?.swapUsedBytes)}</strong>
            </span>
          </div>
        </section>

        {node.power ? (
          <section className="panel power-panel">
            <PanelTitle icon={<Power />} title="Power draw" meta="Pi 5 PMIC" />
            <div className="power-number">
              <strong>{node.power.watts.toFixed(2)} W</strong>
              <span>now</span>
            </div>
            <div className="power-detail">
              <span>
                rails <b>{node.power.rails.length}</b>
              </span>
              <span>
                peak rail <b>{node.power.rails.reduce((m, r) => (r.watts > m.watts ? r : m)).name}</b>
              </span>
            </div>
          </section>
        ) : (
          <section className="panel power-panel">
            <PanelTitle icon={<Power />} title="Power draw" meta="unavailable" />
            <div className="offline-copy">
              <span>No PMIC on this hardware</span>
            </div>
          </section>
        )}
      </div>

      <section className="panel full-panel">
        <PanelTitle icon={<HardDrive />} title="Disks" meta="mount points" />
        {node.disks.map((disk) => (
          <div className="disk-row" key={disk.mount}>
            <span className="mount">{disk.mount}</span>
            <Meter value={disk.usedPct} tone={diskTone(disk.usedPct)} />
            <strong>{pct(disk.usedPct)}</strong>
            <span>
              {bytes(disk.usedBytes)} / {bytes(disk.totalBytes)}
            </span>
          </div>
        ))}
      </section>

      <div className="detail-grid lower">
        <section className="panel full-panel">
          <PanelTitle icon={<Network />} title="Network" meta="throughput" />
          {node.net.length === 0 && <div className="offline-copy"><span>No physical interfaces reported</span></div>}
          {node.net.map((n) => (
            <div className="network-row" key={n.iface}>
              <span>
                {n.iface.startsWith('wl') ? <Wifi size={15} /> : <ArrowDownToLine size={15} />} {n.iface}
              </span>
              <strong>{bytesPerSec(n.rxBps)}</strong>
              <span className="network-secondary">rx</span>
              <strong>{bytesPerSec(n.txBps)}</strong>
              <span className="network-secondary">
                tx <ArrowUpFromLine size={13} />
              </span>
            </div>
          ))}
        </section>

        <section className="panel full-panel">
          <PanelTitle icon={<Box />} title="Containers" meta={`${containers.length} running`} />
          <div className="mini-table">
            <div className="mini-table-head">
              <span>NAME</span>
              <span>STATUS</span>
              <span>CPU</span>
              <span>RAM</span>
            </div>
            {containers.length === 0 && (
              <div className="mini-table-row">
                <span>—</span>
                <span>no containers</span>
                <span />
                <span />
              </div>
            )}
            {containers.map((c) => (
              <div className="mini-table-row" key={c.name}>
                <span>{c.name}</span>
                <span>
                  <i className="health-dot" /> {c.status}
                </span>
                <span>{c.cpuPct == null ? '—' : pct(c.cpuPct)}</span>
                {/* Blank until cgroup memory accounting is enabled on the node. */}
                <span>{c.memBytes == null ? '—' : bytes(c.memBytes)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="panel full-panel process-panel">
        <PanelTitle icon={<ListFilter />} title="Processes" meta="click a column to sort" />
        <div className="process-table">
          <div className="process-head">
            <span>PID</span>
            <span>NAME</span>
            <button onClick={() => setSort('cpu')}>CPU% {sort === 'cpu' ? '↓' : ''}</button>
            <button onClick={() => setSort('ram')}>RAM {sort === 'ram' ? '↓' : ''}</button>
          </div>
          {sorted.map((p) => (
            <div className="process-row" key={p.pid}>
              <span>{p.pid}</span>
              <span>{p.name}</span>
              <span>{p.cpuPct.toFixed(1)}</span>
              <span>{bytes(p.memBytes)}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};
