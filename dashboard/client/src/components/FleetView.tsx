import { useState } from 'preact/hooks';
import type { FleetNode, ProcessRow } from '../../../shared/fleet';
import { bytes, bytesPerSec, capacity, celsius, cpuTone, diskTone, memTone, pct, relative, uptime, watts, swapTone } from '../lib/format';
import { Chevron } from './icons';
import { Meter, StatusDot } from './primitives';

type SortKey = 'cpuPct' | 'memBytes' | 'energy' | 'diskReadBytes' | 'network';

const TABS: Array<{ key: SortKey; label: string }> = [
  { key: 'cpuPct',        label: 'CPU' },
  { key: 'memBytes',      label: 'Memory' },
  { key: 'energy',        label: 'Energy' },
  { key: 'diskReadBytes', label: 'Disk' },
  { key: 'network',       label: 'Network' },
];

const COL_FMT: Record<SortKey, { head: string; fmt: (p: ProcessRow) => string }> = {
  cpuPct:        { head: 'CPU %',   fmt: (p) => (p.cpuPct == null ? '—' : p.cpuPct.toFixed(1)) },
  memBytes:      { head: 'MEMORY',  fmt: (p) => bytes(p.memBytes) },
  energy:        { head: 'ENERGY',  fmt: (p) => (p.cpuPct == null ? '—' : ((p.cpuPct * 0.05).toFixed(1))) },
  diskReadBytes: { head: 'READ',    fmt: (p) => (p.diskReadBytes ? bytes(p.diskReadBytes) : '—') },
  network:       { head: 'NET',     fmt: () => '—' },
};

const sortMetric = (p: ProcessRow, key: SortKey): number => {
  if (key === 'energy') return p.cpuPct ?? -1;
  if (key === 'network') return 0;
  return (p[key] as number) ?? -1;
};

const ROWS = 5;

/**
 * Short names for a board's drives: SSD1, HDD1, SD1.
 *
 * Numbered per kind rather than across the set, so the first SSD is SSD1 even
 * on a board that also has a spinning disk — the number answers "which of
 * these" and there is no useful ordering between an SSD and an HDD to encode.
 *
 * Deliberately shorter than the names the Files view uses. There the question
 * is which drive you are opening, and "SSD 1TB" answers it; here the name sits
 * in a 46px column beside a meter, and the capacity is already on the row.
 */
const diskLabels = (disks: FleetNode['disks']): string[] => {
  const seen = new Map<string, number>();
  return disks.map((d) => {
    const dev = d.device.replace(/^\/dev\//, '');
    const kind =
      d.rotational === true ? 'HDD'
      : d.rotational === false ? 'SSD'
      : /^mmcblk/.test(dev) ? 'SD'
      : 'DISK';
    const n = (seen.get(kind) ?? 0) + 1;
    seen.set(kind, n);
    return `${kind}${n}`;
  });
};

const MiniGraph = ({ series, color, min, max, labelMax, labelMin }: {
  series: number[]; color: string; min?: number; max?: number; labelMax?: string; labelMin?: string;
}) => {
  const W = 100, H = 34;
  const lo = min ?? Math.min(...series), hi = max ?? Math.max(...series);
  const span = hi - lo || 1;
  const y = (v: number) => H - ((Math.max(lo, Math.min(hi, v)) - lo) / span) * (H - 2) - 1;
  const pts = series.length >= 2
    ? series.map((v, i) => `${((i / (series.length - 1)) * W).toFixed(2)},${y(v).toFixed(2)}`)
    : [`0,${H - 2}`, `${W},${H - 2}`];
  const area = `0,${H} ${pts.join(' ')} ${W},${H}`;
  return (
    <div class="mgraph-wrap">
      <svg class="mgraph" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        {[0.25, 0.5, 0.75].map((f) => (
          <line class="mgl" key={f} x1="0" x2={W} y1={(H * f).toFixed(1)} y2={(H * f).toFixed(1)} vector-effect="non-scaling-stroke" />
        ))}
        <polygon points={area} fill={color} opacity=".12" />
        <polyline points={pts.join(' ')} fill="none" stroke={color} stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
      </svg>
      {labelMax && <span class="mg-lab mg-max">{labelMax}</span>}
      {labelMin && <span class="mg-lab mg-min">{labelMin}</span>}
    </div>
  );
};

const NetGraph = ({ series }: { series: Array<[number, number]> }) => {
  const W = 100, H = 16;
  const peak = Math.max(1024, ...series.map(([rx, tx]) => Math.max(rx, tx)));
  const y = (v: number) => H - (v / peak) * (H - 2) - 1;
  const line = (pick: (p: [number, number]) => number) =>
    series.length >= 2
      ? series.map((p, i) => `${((i / (series.length - 1)) * W).toFixed(2)},${y(pick(p)).toFixed(2)}`).join(' ')
      : `0,${H - 2} ${W},${H - 2}`;
  return (
    <div class="mgraph-wrap net-graph-wrap">
      <svg class="mgraph net-graph" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        {[0.5].map((f) => (
          <line class="mgl" key={f} x1="0" x2={W} y1={(H * f).toFixed(1)} y2={(H * f).toFixed(1)} vector-effect="non-scaling-stroke" />
        ))}
        <polyline points={line((p) => p[0])} fill="none" stroke="var(--aqua-2)" stroke-width="1.2" stroke-opacity=".85" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
        <polyline points={line((p) => p[1])} fill="none" stroke="var(--muted)" stroke-width="1" stroke-opacity=".55" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
      </svg>
    </div>
  );
};

const throttleState = (node: FleetNode): { cls: string; text: string } => {
  const t = node.temp?.throttled;
  if (!t) return { cls: 'muted', text: 'no sensor' };
  if (t.now) return { cls: 'warn', text: 'throttled' };
  if (t.everSinceBoot) return { cls: 'warn', text: 'since boot' };
  return { cls: 'ok', text: 'ok' };
};

const powerRange = (series: number[]): { min: number; max: number } => {
  if (!series.length) return { min: 0, max: 1 };
  const mn = Math.min(...series), mx = Math.max(...series);
  const pad = (mx - mn || 0.5) * 0.2;
  return { min: mn - pad, max: mx + pad };
};

const NodeCard = ({ node, onOpen, tempHistory, powerHistory, netHistory }: {
  node: FleetNode; onOpen: (id: string) => void;
  tempHistory: number[]; powerHistory: number[]; netHistory: Array<[number, number]>;
}) => {
  const [sort, setSort] = useState<SortKey>('cpuPct');
  const unreachable = node.online && !!node.error;

  if (!node.online || unreachable) {
    return (
      <div class="card offline-card">
        <div class="c-head">
          <div class="c-id">
            <StatusDot online={false} />
            <span class="c-name">{node.name}</span>
            <span class="c-ip">{node.tailscaleIp}</span>
          </div>
        </div>
        <p class="c-role">
          {unreachable ? `${node.role} · agent not responding` : `offline · ${relative(node.lastSeen)}`}
        </p>
        <div class="offline-copy">
          <span>{unreachable ? 'Node is up but reporting nothing' : 'Waiting for node to return'}</span>
        </div>
      </div>
    );
  }

  const cpu = node.cpu?.usagePct ?? 0;
  const mem = node.mem?.usedPct ?? 0;
  // Every drive gets a bar, not just the one the system boots from. A 6TB that
  // fills up is exactly as interesting as a boot disk that does, and a board
  // whose second drive is invisible cannot tell you it has gone.
  //
  // The boot disk leads, then the rest by mount point, so the order is stable
  // between polls rather than following whatever the fleet poll happened to
  // return first.
  const disks = [...node.disks].sort((a, b) =>
    (a.mount === '/' ? 0 : 1) - (b.mount === '/' ? 0 : 1) || a.mount.localeCompare(b.mount),
  );
  const labels = diskLabels(disks);
  // Swap and the thumbnail cache are files on the boot disk, not drives. They
  // are labelled with the disk they sit on so the card says where those bytes
  // actually are, rather than leaving them floating.
  const bootLabel = labels[disks.findIndex((d) => d.mount === '/')] ?? labels[0];
  // A board with swap configured but untouched still gets the row: nothing
  // there is the answer, and an absent row would read as unknown instead.
  const swap =
    node.mem && node.mem.swapTotalBytes > 0
      ? {
          used: node.mem.swapUsedBytes,
          total: node.mem.swapTotalBytes,
          pct: (node.mem.swapUsedBytes / node.mem.swapTotalBytes) * 100,
        }
      : null;
  // cpuPct is null until a second reading exists to average over; unmeasured
  // rows sort below a measured zero rather than to the top.
  const rows = [...node.topProcesses].sort((a, b) => sortMetric(b, sort) - sortMetric(a, sort)).slice(0, ROWS);

  return (
    <article class="card">
      <div class="c-head">
        <div class="c-id">
          <StatusDot online />
          <span class="c-name">{node.name}</span>
          <span class="c-ip">{node.tailscaleIp}</span>
        </div>
        <span class="c-ram">{capacity(node.mem?.totalBytes)}</span>
      </div>
      <p class="c-role">
        {node.role}
        {node.cpu ? ` · ${node.cpu.cores} cores · load ${node.cpu.loadAvg.map((l) => l.toFixed(2)).join(' ')}` : ''}
        {node.uptimeSec != null ? ` · up ${uptime(node.uptimeSec)}` : ''}
        {node.stale ? ' · holding last reading' : ''}
      </p>

      <div class="mrow">
        <span class="lbl">CPU</span><Meter value={cpu} tone={cpuTone(cpu)} />
        <strong class="fig">{pct(cpu)} · load {node.cpu?.loadAvg.map((l) => l.toFixed(2)).join(' ') ?? '—'}</strong>
      </div>

      {/* Cores + temp graph + power graph — side by side like Image 10 */}
      <div class="sensor-row">
        {node.cpu && (
          <div class="s-cores">
            {node.cpu.perCore.map((v, i) => (
              <div class="s-core" key={i} title={`core ${i + 1}: ${v.toFixed(1)}%`}>
                <div class="s-core-track">
                  <i style={{ height: `${Math.max(3, Math.min(100, v))}%` }} />
                </div>
                <small>{i + 1}</small>
              </div>
            ))}
          </div>
        )}
        <div class="s-graph-cell">
          <div class="s-head">
            <span class="s-label">temperature</span>
            <b>{celsius(node.temp?.cpuC)}</b>
            {(() => { const th = throttleState(node); return <em class={`chip ${th.cls}`}>{th.text}</em>; })()}
          </div>
          <MiniGraph series={tempHistory} color="var(--aqua-2)" min={30} max={85} labelMax="85°" labelMin="30°" />
        </div>
        <div class="s-graph-cell">
          <div class="s-head">
            <span class="s-label">power</span>
            <b class="t-crit">{watts(node.power?.watts)}</b>
          </div>
          {(() => { const pw = powerRange(powerHistory); return (
            <MiniGraph series={powerHistory} color="var(--crit)" min={pw.min} max={pw.max} labelMax={`${pw.max.toFixed(1)}W`} labelMin={`${pw.min.toFixed(1)}W`} />
          ); })()}
        </div>
      </div>

      <div class="mrow">
        <span class="lbl">RAM</span><Meter value={mem} tone={memTone(mem)} />
        <strong class="fig">{pct(mem)}</strong>
      </div>
      {disks.map((d, i) => (
        <div class="mrow" key={d.device} title={`${d.device} on ${d.mount} — ${pct(d.usedPct)} used`}>
          <span class="lbl">{labels[i]}</span>
          <Meter value={d.usedPct} tone={diskTone(d.usedPct)} />
          {/* Used and total rather than a percentage: "29.34 GB / 984.37 GB"
              answers both "how full" and "how big", and the meter still
              carries the proportion on its own. Full precision: this row is
              how a download is watched, and rounding to whole gigabytes hid
              the first twenty minutes of every one of them. */}
          <strong class="fig">{bytes(d.usedBytes)} / {bytes(d.totalBytes)}</strong>
        </div>
      ))}

      {/* One line carrying two, because neither is a drive and neither earns a
          row of its own. The figure is the amount, not the proportion: 5% of a
          swap nobody has looked at says nothing, and 102 MB is the thing worth
          knowing. The meter still carries the proportion, the total is in the
          tooltip, and the tag says which disk the bytes are on. */}
      {(swap || node.cache) && (
        <div class="mrow duo">
          {swap && (
            <span class="half" title={`${bytes(swap.used)} of ${bytes(swap.total)} swap in use, on ${bootLabel}`}>
              <span class="lbl dim">SWAP</span>
              <Meter value={swap.pct} tone={swapTone(swap.pct)} />
              <strong class="fig">{bytes(swap.used)}</strong>
              <span class="on-disk">{bootLabel}</span>
            </span>
          )}
          {node.cache && (
            <span
              class="half"
              title={`${node.cache.count} thumbnails, ${bytes(node.cache.bytes)} of a ${bytes(node.cache.capBytes)} cap, on ${bootLabel}`}
            >
              <span class="lbl dim">CACHE</span>
              <Meter value={(node.cache.bytes / node.cache.capBytes) * 100} tone="aqua" />
              <strong class="fig">{bytes(node.cache.bytes)}</strong>
              <span class="on-disk">{bootLabel}</span>
            </span>
          )}
        </div>
      )}

      {/* Network — full-width graph + rates */}
      {node.online && (
        <div class="net-strip">
          <span class="lbl dim">NET</span>
          <NetGraph series={netHistory} />
          <span class="net-rates">
            ↓ {bytesPerSec(node.net.reduce((a, i) => a + i.rxBps, 0))} · ↑ {bytesPerSec(node.net.reduce((a, i) => a + i.txBps, 0))}
          </span>
        </div>
      )}

      {/* Spacer pushes the process table to the card floor so both cards align */}
      <div class="c-spacer" />

      <div class="ptable"><div class="pscroll">
        <div class="prow phead">
          <span>PROCESS</span>
          {TABS.map((t) => (
            <button key={t.key} class={sort === t.key ? 'sorted' : ''} onClick={() => setSort(t.key)}>
              {COL_FMT[t.key].head}{sort === t.key ? ' ▾' : ''}
            </button>
          ))}
        </div>
        {rows.length === 0 && (
          <div class="prow body"><span class="pname">—</span>{TABS.map((t) => <span key={t.key} class="pval">—</span>)}</div>
        )}
        {rows.map((p) => (
          <div class="prow body" key={p.pid}>
            <span class="pname">{p.name}</span>
            {TABS.map((t) => (
              <span key={t.key} class={`pval ${t.key === 'cpuPct' && (p.cpuPct ?? 0) > 100 ? 'hot' : t.key === sort ? 'lead' : ''}`}>
                {COL_FMT[t.key].fmt(p)}
              </span>
            ))}
          </div>
        ))}
      </div></div>

      <div class="c-foot">
        <span>top {rows.length} by {COL_FMT[sort].head.toLowerCase()}</span>
        <button class="inspect" onClick={() => onOpen(node.id)}>inspect<Chevron size={13} /></button>
      </div>
    </article>
  );
};


export const FleetView = ({ nodes, onOpen, tempHistory, powerHistory, netHistory }: {
  nodes: FleetNode[]; onOpen: (id: string) => void;
  tempHistory: Map<string, number[]>; powerHistory: Map<string, number[]>;
  netHistory: Map<string, Array<[number, number]>>;
}) => {
  return (
    <div class="grid">
      {nodes.map((n) => (
        <NodeCard
          key={n.id}
          node={n}
          onOpen={onOpen}
          tempHistory={tempHistory.get(n.id) ?? []}
          powerHistory={powerHistory.get(n.id) ?? []}
          netHistory={netHistory.get(n.id) ?? []}
        />
      ))}
    </div>
  );
};
