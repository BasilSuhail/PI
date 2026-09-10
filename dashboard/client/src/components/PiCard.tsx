/**
 * One Pi board as a card — the whole stack, top to bottom:
 *
 *   identity (name — purpose)
 *   cpu                    one line: name · value/total · % full, then the bar
 *   cores | temp | watts   narrow bars, a gridded graph each (watts in red)
 *   ram | swap             long | short
 *   storage | cache        long | short, both yellow
 *   network                narrow, subtle rx/tx graph, whole row
 *   ── view more ──        expands into the process monitor
 *
 * Every meter reads the same way — one steady line above the bar — and
 * every graph carries its own grid so high/medium/low is readable without
 * a scale hunt. Red marks wattage, yellow marks storage, rest is neutral.
 */

import type { FleetNode } from '../../../shared/fleet';
import { bytes, bytesPerSec, celsius, pct, uptime, watts } from '../lib/format';
import { ProcessMonitor } from './ProcessMonitor';
import { Server } from './icons';

export interface RailNode extends FleetNode {
  /** The board's job — "OSINT", "LAB" — from the console's own map. */
  label: string;
}

const throttleState = (node: FleetNode): { cls: string; text: string } => {
  const t = node.temp?.throttled;
  if (!t) return { cls: 'muted', text: 'no sensor' };
  if (t.now) return { cls: 'crit', text: 'throttled' };
  if (t.everSinceBoot) return { cls: 'warn', text: 'since boot' };
  return { cls: 'ok', text: 'ok' };
};

/** The meter — one single line: NAME: [bar] value / total - N%. Label
 *  left, the bar flexing between, values right. Every meter reads the
 *  same way, top to bottom of the card. */
const Meter = ({
  name, value, pctVal, cls, title,
}: {
  name: string;
  value: string;
  pctVal: number;
  cls?: string;
  title?: string;
}) => (
  <div class="meter" title={title}>
    <span class="m-name">{name}</span>
    <div class="track">
      <i class={cls} style={{ width: `${Math.max(pctVal > 0 ? 1 : 0, Math.min(100, pctVal))}%` }} />
    </div>
    <span class="m-val">{value}</span>
  </div>
);

/**
 * A proper little chart: grid lines beneath, a line with a soft area over
 * them, and the scale written at the top and bottom edges so high and low
 * are values, not guesses.
 */
const Graph = ({
  series, color, min, max, labelMax, labelMin,
}: {
  series: number[];
  color: string;
  min?: number;
  max?: number;
  labelMax?: string;
  labelMin?: string;
}) => {
  const W = 100, H = 34;
  const lo = min ?? 30, hi = max ?? 85;
  const span = hi - lo || 1;
  const y = (v: number) => H - ((Math.max(lo, Math.min(hi, v)) - lo) / span) * (H - 2) - 1;
  const pts = series.length >= 2
    ? series.map((v, i) => `${((i / (series.length - 1)) * W).toFixed(2)},${y(v).toFixed(2)}`)
    : [`0,${H - 2}`, `${W},${H - 2}`];
  const area = `0,${H} ${pts.join(' ')} ${W},${H}`;
  return (
    <div class="graph-wrap">
      <svg class="graph" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        {[0.25, 0.5, 0.75].map((f) => (
          <line class="gl" key={f} x1="0" x2={W} y1={(H * f).toFixed(1)} y2={(H * f).toFixed(1)} vector-effect="non-scaling-stroke" />
        ))}
        <polygon points={area} fill={color} opacity=".12" />
        <polyline
          points={pts.join(' ')}
          fill="none"
          stroke={color}
          stroke-width="1.5"
          stroke-linejoin="round"
          stroke-linecap="round"
          vector-effect="non-scaling-stroke"
        />
      </svg>
      {labelMax && <span class="g-lab g-max">{labelMax}</span>}
      {labelMin && <span class="g-lab g-min">{labelMin}</span>}
    </div>
  );
};

/** Network: narrow and subtle — two thin lines over a grid, peak labelled. */
const NetGraph = ({ series }: { series: Array<[number, number]> }) => {
  const W = 100, H = 20;
  const peak = Math.max(1024, ...series.map(([rx, tx]) => Math.max(rx, tx)));
  const y = (v: number) => H - (v / peak) * (H - 2) - 1;
  const line = (pick: (p: [number, number]) => number) =>
    series.length >= 2
      ? series.map((p, i) => `${((i / (series.length - 1)) * W).toFixed(2)},${y(pick(p)).toFixed(2)}`).join(' ')
      : `0,${H - 2} ${W},${H - 2}`;
  return (
    <div class="graph-wrap">
      <svg class="graph net" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        {[0.25, 0.5, 0.75].map((f) => (
          <line class="gl" key={f} x1="0" x2={W} y1={(H * f).toFixed(1)} y2={(H * f).toFixed(1)} vector-effect="non-scaling-stroke" />
        ))}
        <polyline points={line((p) => p[0])} fill="none" stroke="var(--violet)" stroke-width="1.2" stroke-opacity=".85" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
        <polyline points={line((p) => p[1])} fill="none" stroke="var(--soft)" stroke-width="1" stroke-opacity=".55" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
      </svg>
      <span class="g-lab g-max">{bytesPerSec(peak)}</span>
      <span class="g-lab g-min">0</span>
    </div>
  );
};

const powerRange = (series: number[]): { min: number; max: number } => {
  if (!series.length) return { min: 0, max: 1 };
  const min = Math.min(...series), max = Math.max(...series);
  const pad = (max - min || 0.5) * 0.2;
  return { min: min - pad, max: max + pad };
};

export const PiCard = ({
  node, expanded, onToggle, history, powerHistory, netHistory,
}: {
  node: RailNode;
  expanded: boolean;
  onToggle: () => void;
  history: number[];
  powerHistory: number[];
  netHistory: Array<[number, number]>;
}) => {
  const n = node;
  const mem = n.mem;
  const swapPct = mem && mem.swapTotalBytes ? (mem.swapUsedBytes / mem.swapTotalBytes) * 100 : 0;
  const th = throttleState(n);
  const pw = powerRange(powerHistory);
  const cache = n.cache;
  const cachePct = cache && cache.capBytes ? (cache.bytes / cache.capBytes) * 100 : null;
  const rx = n.net.reduce((a, i) => a + i.rxBps, 0);
  const tx = n.net.reduce((a, i) => a + i.txBps, 0);

  // SSD1, HDD1… — a board's drives, named the way the header line shows them.
  let ssd = 0, hdd = 0;
  const diskNames = n.disks.map((d) => (d.rotational ? `hdd${++hdd}` : `ssd${++ssd}`));
  // The cache lives on the SSD; its meter is shown right after the SSD's.
  const cacheAfter = n.disks.findIndex((d) => !d.rotational);

  return (
    <section class={`pi-card ${expanded ? 'open' : ''}`}>
      <div class="pi-head">
        <span class="pi-glyph"><Server size={15} /></span>
        <div class="pi-copy">
          <b>
            {n.name}
            {n.label && <em class="purpose">{n.label}</em>}
          </b>
          <small>{n.online ? `${uptime(n.uptimeSec)} up` : 'offline'} · {n.tailscaleIp}</small>
        </div>
        <span class={`dot ${n.online ? '' : 'down'}`} />
        {n.stale && <span class="chip warn">stale</span>}
      </div>

      <div class="pi-grid">
        {/* CPU — percentage is the only honest unit for it. */}
        <div class="cell wide">
          <Meter
            name="cpu:"
            value={n.cpu ? `${pct(n.cpu.usagePct)} · load ${n.cpu.loadAvg.map((v) => v.toFixed(2)).join(' ')}` : '—'}
            pctVal={n.cpu?.usagePct ?? 0}
            title={`${n.cpu?.cores ?? '—'} cores`}
          />
        </div>

        {/* The sensor row: narrow core bars, temp, watts — a graph each. */}
        <div class="cell wide sensors">
          {n.cpu && (
            <div class="s-cores">
              {n.cpu.perCore.map((v, i) => (
                <div class="core" key={i} title={`core ${i + 1}: ${v.toFixed(1)}%`}>
                  <div class="core-track">
                    <i style={{ height: `${Math.max(3, Math.min(100, v))}%` }} />
                  </div>
                  <small>{i + 1}</small>
                </div>
              ))}
            </div>
          )}
          <div class="s-sensor">
            <div class="s-head">
              <span class="label">temperature</span>
              <b>{celsius(n.temp?.cpuC)}</b>
              <em class={`chip ${th.cls}`}>{th.text}</em>
            </div>
            <Graph series={history} color="var(--violet)" min={30} max={85} labelMax="85°" labelMin="30°" />
          </div>
          <div class="s-sensor">
            <div class="s-head">
              <span class="label">power</span>
              <b class="t-red">{watts(n.power?.watts)}</b>
            </div>
            <Graph
              series={powerHistory}
              color="var(--red)"
              min={pw.min}
              max={pw.max}
              labelMax={`${pw.max.toFixed(1)}W`}
              labelMin={`${pw.min.toFixed(1)}W`}
            />
          </div>
        </div>

        {/* RAM (big) + Swap (small) — paired on one line. */}
        <div class="cell wide meter-pair">
          <div class="mp-big">
            <Meter
              name="ram:"
              value={mem ? `${bytes(mem.usedBytes)} / ${bytes(mem.totalBytes)}` : '—'}
              pctVal={mem?.usedPct ?? 0}
            />
          </div>
          <div class="mp-sm">
            <Meter
              name="swap:"
              value={mem ? `${bytes(mem.swapUsedBytes)} / ${bytes(mem.swapTotalBytes)}` : '—'}
              pctVal={swapPct}
            />
          </div>
        </div>

        {/* Storage (big) + Cache (small) — paired; extra drives get their own row. */}
        {n.disks.map((d, i) => {
          const hasCacheHere = cache && i === cacheAfter;
          return hasCacheHere ? (
            <div class="cell wide meter-pair" key={d.mount}>
              <div class="mp-big">
                <Meter
                  name={`${diskNames[i]}:`}
                  value={`${bytes(d.usedBytes)} / ${bytes(d.totalBytes)}`}
                  pctVal={d.usedPct}
                  cls="yellow"
                  title={`${d.mount} · ${d.device}${d.rotational ? ' · rotational' : ''}`}
                />
              </div>
              <div class="mp-sm">
                <Meter
                  name="cache:"
                  value={`${bytes(cache.bytes)} / ${bytes(cache.capBytes)}`}
                  pctVal={cachePct ?? 0}
                  cls="yellow"
                  title={`thumbnail cache · ${cache.count.toLocaleString()} thumbs`}
                />
              </div>
            </div>
          ) : (
            <div class="cell wide" key={d.mount}>
              <Meter
                name={`${diskNames[i]}:`}
                value={`${bytes(d.usedBytes)} / ${bytes(d.totalBytes)}`}
                pctVal={d.usedPct}
                cls="yellow"
                title={`${d.mount} · ${d.device}${d.rotational ? ' · rotational' : ''}`}
              />
            </div>
          );
        })}

        {/* Network — one single line: label, the graph, the rates. */}
        <div class="cell wide">
          <div class="meter net-meter">
            <span class="m-name">network:</span>
            <div class="net-wrap">
              <NetGraph series={netHistory} />
            </div>
            <span class="m-val">↓ {bytesPerSec(rx)} · ↑ {bytesPerSec(tx)}</span>
          </div>
        </div>
      </div>

      <button class="more-btn" onClick={onToggle} aria-expanded={expanded}>
        {expanded ? 'view less' : 'view more'}
      </button>

      {expanded && (
        <div class="pi-more">
          <ProcessMonitor node={n} />
          <div class="sys-meta">
            {n.model ?? 'Raspberry Pi'} · {n.os ?? '—'} · {n.kernel ?? '—'} · {n.arch ?? '—'} · {n.tailscaleIp}
          </div>
        </div>
      )}
    </section>
  );
};
