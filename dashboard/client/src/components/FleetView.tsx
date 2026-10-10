import { useState } from 'preact/hooks';
import type { FleetNode, ProcessRow } from '../../../shared/fleet';
import { bytes, bytesPerSec, capacity, celsius, cpuTone, diskTone, memTone, pct, relative, uptime, watts, swapTone } from '../lib/format';
import { nodeWatts } from '../lib/api';
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

const ROWS = 8;

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

/**
 * A sparkline with an optional second series drawn dashed on the same scale:
 * the GPU beside the CPU, so the two can be compared without a second graph.
 */
/**
 * A drive's place among its kind, from the number its mount point ends in:
 * /srv/hdd2 is the second, and /srv/storage, with no number, the first. That
 * is the convention the mounts were named by (and the pool's /srv/hdd3 after
 * it), so HDD1 stays the disk that has always held the media. By plain name,
 * /srv/hdd2 sorted ahead of /srv/storage and took its label.
 */
const mountRank = (mount: string): number => {
  const n = mount.match(/(\d+)$/);
  return n ? Number(n[1]) : 1;
};

const MiniGraph = ({ series, series2, color, color2 = 'var(--gpu-2)', min, max, labelMax, labelMin }: {
  series: number[]; series2?: number[]; color: string; color2?: string;
  min?: number; max?: number; labelMax?: string; labelMin?: string;
}) => {
  const W = 100, H = 40;
  const all = [...series, ...(series2 ?? [])];
  const lo = min ?? Math.min(...all), hi = max ?? Math.max(...all);
  const span = hi - lo || 1;
  const y = (v: number) => H - ((Math.max(lo, Math.min(hi, v)) - lo) / span) * (H - 2) - 1;
  const line = (s: number[]) => s.length >= 2
    ? s.map((v, i) => `${((i / (s.length - 1)) * W).toFixed(2)},${y(v).toFixed(2)}`)
    : [`0,${H - 2}`, `${W},${H - 2}`];
  const pts = line(series);
  const area = `0,${H} ${pts.join(' ')} ${W},${H}`;
  return (
    <div class="mgraph-wrap">
      <svg class="mgraph" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        {[0.25, 0.5, 0.75].map((f) => (
          <line class="mgl" key={f} x1="0" x2={W} y1={(H * f).toFixed(1)} y2={(H * f).toFixed(1)} vector-effect="non-scaling-stroke" />
        ))}
        <polygon points={area} fill={color} opacity=".12" />
        <polyline points={pts.join(' ')} fill="none" stroke={color} stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
        {series2 && series2.length >= 2 && (
          <polyline points={line(series2).join(' ')} fill="none" stroke={color2} stroke-width="1.2" stroke-dasharray="3 3" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
        )}
      </svg>
      {labelMax && <span class="mg-lab mg-max">{labelMax}</span>}
      {labelMin && <span class="mg-lab mg-min">{labelMin}</span>}
    </div>
  );
};

/**
 * The network strip's graph, drawn like the temperature one at the strip's own
 * height: download solid over its shaded area, upload dashed, three guide
 * lines, and the peak the scale reaches labelled in the corner.
 */
const NetGraph = ({ series }: { series: Array<[number, number]> }) => {
  const W = 100, H = 24;
  const peak = Math.max(1024, ...series.map(([rx, tx]) => Math.max(rx, tx)));
  const y = (v: number) => H - (v / peak) * (H - 2) - 1;
  const line = (pick: (p: [number, number]) => number) =>
    series.length >= 2
      ? series.map((p, i) => `${((i / (series.length - 1)) * W).toFixed(2)},${y(pick(p)).toFixed(2)}`).join(' ')
      : `0,${H - 2} ${W},${H - 2}`;
  return (
    <div class="mgraph-wrap net-graph-wrap">
      <svg class="mgraph net-graph" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        {[0.25, 0.5, 0.75].map((f) => (
          <line class="mgl" key={f} x1="0" x2={W} y1={(H * f).toFixed(1)} y2={(H * f).toFixed(1)} vector-effect="non-scaling-stroke" />
        ))}
        <polygon points={`0,${H} ${line((p) => p[0])} ${W},${H}`} fill="var(--aqua-2)" opacity=".12" />
        <polyline points={line((p) => p[0])} fill="none" stroke="var(--aqua-2)" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
        <polyline points={line((p) => p[1])} fill="none" stroke="var(--muted)" stroke-width="1.2" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
      </svg>
      <span class="mg-lab mg-max net-peak">{bytesPerSec(peak)}</span>
    </div>
  );
};

/**
 * Temperature and power in one graph, for the narrow card: each line on its
 * own scale, temperature's labels on the right and power's on the left.
 */
const DualGraph = ({ temp, power }: { temp: number[]; power: number[] }) => {
  const W = 100, H = 40;
  const tr = (() => {
    if (!temp.length) return { min: 30, max: 60 };
    const lo = Math.floor(Math.min(...temp) - 2), hi = Math.ceil(Math.max(...temp) + 2);
    return { min: lo, max: Math.max(hi, lo + 10) };
  })();
  const pr = powerRange(power);
  const line = (s: number[], lo: number, hi: number) => s.length >= 2
    ? s.map((v, i) => `${((i / (s.length - 1)) * W).toFixed(2)},${(H - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo || 1)) * (H - 2) - 1).toFixed(2)}`).join(' ')
    : `0,${H - 2} ${W},${H - 2}`;
  const t = line(temp, tr.min, tr.max);
  return (
    <div class="mgraph-wrap">
      <svg class="mgraph dual" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        {[0.25, 0.5, 0.75].map((f) => (
          <line class="mgl" key={f} x1="0" x2={W} y1={(H * f).toFixed(1)} y2={(H * f).toFixed(1)} vector-effect="non-scaling-stroke" />
        ))}
        <polygon points={`0,${H} ${t} ${W},${H}`} fill="var(--aqua-2)" opacity=".12" />
        <polyline points={t} fill="none" stroke="var(--aqua-2)" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
        {power.length >= 2 && (
          <polyline points={line(power, pr.min, pr.max)} fill="none" stroke="var(--crit)" stroke-width="1.3" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
        )}
      </svg>
      <span class="mg-lab mg-max">{tr.max}°</span><span class="mg-lab mg-min">{tr.min}°</span>
      {power.length >= 2 && <><span class="mg-lab mg-max mg-left">{pr.max}W</span><span class="mg-lab mg-min mg-left">{pr.min}W</span></>}
    </div>
  );
};

/**
 * A Pi reports throttling, which is the thing worth a chip. A desktop does not,
 * so its chip says what the temperature itself says instead of "no sensor".
 */
const throttleState = (node: FleetNode): { cls: string; text: string } => {
  const t = node.temp?.throttled;
  if (t?.now) return { cls: 'warn', text: 'throttled' };
  if (t?.everSinceBoot) return { cls: 'warn', text: 'since boot' };
  const c = node.temp?.cpuC;
  if (c == null) return { cls: 'muted', text: 'no sensor' };
  return c >= 80 ? { cls: 'warn', text: 'hot' } : { cls: 'ok', text: 'ok' };
};

/**
 * Whole watts at least two apart. A steady 13.2 W padded by a fraction gave a
 * 13.1–13.3 scale whose two labels both rounded to the same number.
 */
const powerRange = (series: number[]): { min: number; max: number } => {
  if (!series.length) return { min: 0, max: 1 };
  const mn = Math.min(...series), mx = Math.max(...series);
  const min = Math.max(0, Math.floor(mn - 1));
  return { min, max: Math.max(Math.ceil(mx + 1), min + 2) };
};

/** "NVIDIA GeForce GTX 1050 Ti" is a lot of words for "GTX 1050 Ti". */
const gpuShort = (name: string) => name.replace(/^NVIDIA\s+(GeForce\s+)?/i, '');

/** A section heading inside the card: a label, a note, and a rule to the edge. */
const Sec = ({ title, note }: { title: string; note?: string | null }) => (
  <div class="sec">{title}{note && <small>{note}</small>}</div>
);

const NodeCard = ({ node, onOpen, tempHistory, powerHistory, netHistory, gpuTempHistory, gpuPowerHistory, compact = false }: {
  node: FleetNode; onOpen: (id: string) => void;
  tempHistory: number[]; powerHistory: number[]; netHistory: Array<[number, number]>;
  gpuTempHistory: number[]; gpuPowerHistory: number[];
  /** The narrow card beside the server: one column, no cores, one graph, a two-column table. */
  compact?: boolean;
}) => {
  const [sort, setSort] = useState<SortKey>('cpuPct');
  const unreachable = node.online && !!node.error;

  if (!node.online || unreachable) {
    return (
      <div class="card offline-card">
        <div class="c-line">
          <StatusDot online={false} size="sm" />
          <p>
            <b>{node.name}</b> · {node.tailscaleIp} ·{' '}
            {unreachable ? `${node.role} · agent not responding` : `offline · ${relative(node.lastSeen)}`}
          </p>
        </div>
        <div class="offline-copy">
          <span>{unreachable ? 'Node is up but reporting nothing' : 'Waiting for node to return'}</span>
        </div>
      </div>
    );
  }

  const cpu = node.cpu?.usagePct ?? 0;
  const mem = node.mem?.usedPct ?? 0;
  const hw = node.hw;
  const gpu = hw?.gpu ?? null;
  // Every drive gets a bar, not just the one the system boots from. A 6TB that
  // fills up is exactly as interesting as a boot disk that does, and a board
  // whose second drive is invisible cannot tell you it has gone.
  //
  // The boot disk leads, then the rest by mount point, so the order is stable
  // between polls and between boots. Not by device: on a PC the sdX letters
  // are handed out in whatever order the SATA ports answer, and they changed
  // across one reboot, which would swap HDD1 and HDD2. Mount points come from
  // fstab by UUID and do not move.
  const disks = [...node.disks].sort((a, b) =>
    (a.mount === '/' ? 0 : 1) - (b.mount === '/' ? 0 : 1)
    || mountRank(a.mount) - mountRank(b.mount)
    || a.mount.localeCompare(b.mount),
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

  const drawW = nodeWatts(node);
  const tabs = compact ? TABS.filter((t) => t.key === 'cpuPct' || t.key === 'memBytes') : TABS;
  const threads = node.cpu?.perCore ?? [];
  // Name, address and specs on one line in one size, so the card starts at
  // once and the rows below it get the room.
  const specs = [
    node.role,
    // "Raspberry Pi 5 Model B Rev 1.0" is a lot of words for "Raspberry Pi 5".
    compact ? node.model?.replace(/ Model .*$/, '') : node.model,
    threads.length ? `${threads.length} threads` : null,
    gpu ? gpuShort(gpu.name) : null,
    node.mem ? capacity(node.mem.totalBytes) : null,
    node.uptimeSec != null ? `up ${uptime(node.uptimeSec)}` : null,
    node.stale ? 'holding last reading' : null,
  ].filter(Boolean);
  // A header with nothing plugged into it reads 0 rpm and is left out by the
  // agent; the GPU's own fan joins the board's when the driver is in. The
  // agent also reports the labelled supply rails; they are not drawn, because
  // nobody watches a 3.3 V rail on a home server.
  const boardCells = [
    // A managed fan at 0 rpm was switched off by the controller, not lost.
    ...(hw?.fans ?? []).map((f) => (f.rpm > 0
      ? { k: f.label.toUpperCase(), v: f.rpm.toLocaleString(), u: 'rpm', spin: true }
      : { k: f.label.toUpperCase(), v: 'off', u: '', spin: false })),
    ...(gpu?.fanPct != null ? [{ k: 'GPU FAN', v: String(Math.round(gpu.fanPct)), u: '%', spin: false }] : []),
  ];
  const wifi = hw?.wifi ?? [];
  const wired = node.net.length > 0 && node.net.every((n) => !n.iface.startsWith('wl'));

  return (
    <article class={`card ${compact ? 'compact' : ''}`}>
      <div class="c-line">
        <StatusDot online size="sm" />
        <p><b>{node.name}</b>{compact ? '' : ` · ${node.tailscaleIp}`}{specs.length ? ` · ${specs.join(' · ')}` : ''}</p>
      </div>

      <div class="c-body">
        <div class="col">
          <Sec title="PROCESSOR" note={node.cpu ? `load ${node.cpu.loadAvg.map((l) => l.toFixed(2)).join(' ')}` : null} />
          <div class="mrow">
            <span class="lbl">CPU</span><Meter value={cpu} tone={cpuTone(cpu)} />
            <strong class="fig">{pct(cpu)}</strong>
          </div>

          {/* Threads get a row of their own: twelve of them beside two graphs
              left neither enough room to read. */}
          {!compact && threads.length > 0 && (
            <div class="cores">
              <div class="cores-scale"><span>100</span><span>50</span><span>0</span></div>
              <div class={`cores-grid ${threads.length > 6 ? 'many' : ''}`} style={{ '--n': threads.length }}>
                {threads.map((v, i) => (
                  <div class="core" key={i} title={`thread ${i + 1}: ${v.toFixed(1)}%`}>
                    <b>{Math.round(v)}</b>
                    <div class="core-track">
                      <i class={cpuTone(v) === 'aqua' ? '' : 'warm'} style={{ height: `${Math.max(4, Math.min(100, v))}%` }} />
                    </div>
                    <small>{i + 1}</small>
                  </div>
                ))}
              </div>
            </div>
          )}

          {compact && (
            <div class="sense one">
              <div class="s-cell">
                <div class="s-head">
                  <span class="s-label">temperature</span>
                  <b>{celsius(node.temp?.cpuC)}</b>
                  {(() => { const th = throttleState(node); return <em class={`chip ${th.cls}`}>{th.text}</em>; })()}
                  {drawW != null && <><span class="s-label s-gap">power</span><b class="t-crit">{watts(drawW)}</b></>}
                </div>
                <DualGraph temp={tempHistory} power={drawW != null ? powerHistory : []} />
                <div class="legend">
                  <span><i />temperature <em>{celsius(node.temp?.cpuC)}</em></span>
                  {drawW != null && <span><i class="crit" />power <em>{watts(drawW)}</em></span>}
                </div>
              </div>
            </div>
          )}

          {/* Temperature and power together, the CPU solid and the GPU dashed
              on the same scale. */}
          {!compact && <div class="sense">
            <div class="s-cell">
              <div class="s-head">
                <span class="s-label">temperature</span>
                <b>{celsius(node.temp?.cpuC)}</b>
                {(() => { const th = throttleState(node); return <em class={`chip ${th.cls}`}>{th.text}</em>; })()}
              </div>
              <MiniGraph series={tempHistory} series2={gpu ? gpuTempHistory : undefined} color="var(--aqua-2)" min={15} max={90} labelMax="90°" labelMin="15°" />
              {gpu && (
                <div class="legend">
                  <span><i />cpu <em>{celsius(node.temp?.cpuC)}</em></span>
                  <span><i class="dash" />gpu <em>{celsius(gpu.tempC)}</em></span>
                </div>
              )}
            </div>
            <div class="s-cell">
              <div class="s-head">
                <span class="s-label">power</span>
                <b class="t-crit">{watts(drawW)}</b>
              </div>
              {drawW == null ? (
                <p class="s-none">No power reading on this machine</p>
              ) : (
                (() => { const pw = powerRange([...powerHistory, ...gpuPowerHistory]); return (
                  <MiniGraph series={powerHistory} series2={gpu?.powerW != null ? gpuPowerHistory : undefined} color="var(--crit)" min={pw.min} max={pw.max} labelMax={`${pw.max.toFixed(0)}W`} labelMin={`${pw.min.toFixed(0)}W`} />
                ); })()
              )}
              {/* A card that reports no watts leaves the CPU package as the whole
                  reading, and the legend says so rather than calling it total. */}
              {gpu?.powerW == null && hw?.cpuWatts != null && (
                <div class="legend"><span><i class="crit" />cpu package <em>{watts(hw.cpuWatts)}</em></span></div>
              )}
              {gpu?.powerW != null && (
                <div class="legend">
                  <span><i class="crit" />total <em>{watts(drawW)}</em></span>
                  <span><i class="dash" />gpu <em>{watts(gpu.powerW)}</em></span>
                </div>
              )}
            </div>
          </div>}

          {gpu && (
            <>
              <Sec title="GRAPHICS" note={gpuShort(gpu.name)} />
              <div class="mrow">
                <span class="lbl">GPU</span><Meter value={gpu.utilPct ?? 0} tone="gpu" />
                <strong class="fig">{pct(gpu.utilPct)}</strong>
              </div>
              {gpu.memTotalBytes != null && (
                <div class="mrow">
                  <span class="lbl">VRAM</span>
                  <Meter value={((gpu.memUsedBytes ?? 0) / gpu.memTotalBytes) * 100} tone="gpu" />
                  <strong class="fig">{bytes(gpu.memUsedBytes)} / {bytes(gpu.memTotalBytes)}</strong>
                </div>
              )}
              {(gpu.encoderPct != null || gpu.decoderPct != null) && (
                <div class="mrow duo">
                  <span class="half" title="NVENC: video being encoded, which is what a Jellyfin transcode uses">
                    <span class="lbl dim">ENCODE</span><Meter value={gpu.encoderPct ?? 0} tone="gpu" />
                    <strong class="fig">{gpu.encoderPct ? pct(gpu.encoderPct) : 'idle'}</strong>
                  </span>
                  <span class="half" title="NVDEC: video being decoded">
                    <span class="lbl dim">DECODE</span><Meter value={gpu.decoderPct ?? 0} tone="gpu" />
                    <strong class="fig">{gpu.decoderPct ? pct(gpu.decoderPct) : 'idle'}</strong>
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        <div class="col">
          <Sec title="MEMORY" note={node.mem ? capacity(node.mem.totalBytes) : null} />
          <div class="mrow">
            <span class="lbl">RAM</span><Meter value={mem} tone={memTone(mem)} />
            {/* The amount, not the proportion: the meter already shows how full. */}
            <strong class="fig">{bytes(node.mem?.usedBytes)} / {bytes(node.mem?.totalBytes)}</strong>
          </div>
          {/* One line carrying two, because neither is a drive and neither earns
              a row of its own. The figure is the amount, not the proportion. */}
          {compact && swap && (
            <div class="mrow" title={`${bytes(swap.used)} of ${bytes(swap.total)} swap in use, on ${bootLabel}`}>
              <span class="lbl">SWAP</span><Meter value={swap.pct} tone={swapTone(swap.pct)} />
              <strong class="fig">{bytes(swap.used)}</strong>
              <span class="on-disk">{bootLabel}</span>
            </div>
          )}
          {!compact && (swap || node.cache) && (
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

          <Sec title="DRIVES" note={`${disks.length} connected`} />
          {disks.map((d, i) => (
            <div class="mrow drow" key={d.device} title={`${d.device} on ${d.mount} — ${pct(d.usedPct)} used`}>
              <span class="lbl">{labels[i]}</span>
              <Meter value={d.usedPct} tone={diskTone(d.usedPct)} />
              {/* Used and total rather than a percentage: "29.34 GB / 984.37 GB"
                  answers both "how full" and "how big". Full precision: this row
                  is how a download is watched. */}
              <strong class="fig">{bytes(d.usedBytes)} / {bytes(d.totalBytes)}</strong>
              <span class="on-disk">{d.mount}</span>
              {/* Red above 35°: hard drives last longest under about 40°, and the
                  bottom front fan only starts at 40°, so this is the early warning. */}
              {d.tempC != null && (
                <span class={`on-disk temp${Math.round(d.tempC) > 35 ? ' hot' : ''}`}>{Math.round(d.tempC)}°</span>
              )}
            </div>
          ))}

          {compact && hw?.fans[0] && (() => {
            const f = hw.fans[0];
            // A Pi's one fan is its Active Cooler; hwmon calls it fan1.
            const name = /raspberry/i.test(node.model ?? '') || /^fan\d*$/i.test(f.label) ? 'ACTIVE COOLER' : f.label.toUpperCase();
            return (
              <div class="mrow fan-row">
                <span class="lbl">{name}</span>
                <div class="fan-box">
                  <span class="fan-val">{f.rpm > 0 ? <><span class="spin" />{f.rpm.toLocaleString()}<small> rpm</small></> : 'off'}</span>
                </div>
              </div>
            );
          })()}

          {!compact && boardCells.length > 0 && (
            <>
              <Sec title="FANS" note={`${boardCells.filter((c) => c.v !== 'off').length} turning${hw?.fans.some((f) => f.managed) ? ' · by temperature' : ''}`} />
              <div class="board">
                {boardCells.map((c) => (
                  <div class="bcell" key={c.k}>
                    <em>{c.k}</em>
                    <b>{c.spin && <span class="spin" />}{c.v}<small>{c.u}</small></b>
                  </div>
                ))}
              </div>
            </>
          )}

          <div class="net-strip">
            <span class="lbl dim">{wired || wifi.length === 0 ? 'NET' : 'WI-FI'}</span>
            <NetGraph series={netHistory} />
            <span class="net-rates">
              ↓ {bytesPerSec(node.net.reduce((a, i) => a + i.rxBps, 0))} · ↑ {bytesPerSec(node.net.reduce((a, i) => a + i.txBps, 0))}
            </span>
            {wifi[0] && <span class="on-disk" title={wifi[0].iface}>{wifi[0].signalDbm} dBm</span>}
          </div>
        </div>
      </div>

      <div class="ptable"><div class="pscroll">
        <div class="prow phead">
          <span>PROCESS</span>
          {tabs.map((t) => (
            <button key={t.key} class={sort === t.key ? 'sorted' : ''} onClick={() => setSort(t.key)}>
              {COL_FMT[t.key].head}{sort === t.key ? ' ▾' : ''}
            </button>
          ))}
        </div>
        {rows.length === 0 && (
          <div class="prow body"><span class="pname">—</span>{tabs.map((t) => <span key={t.key} class="pval">—</span>)}</div>
        )}
        {rows.map((p) => (
          <div class="prow body" key={p.pid}>
            <span class="pname">{p.name}</span>
            {tabs.map((t) => (
              <span key={t.key} class={`pval ${t.key === 'cpuPct' && (p.cpuPct ?? 0) > 100 ? 'hot' : t.key === sort ? 'lead' : ''}`}>
                {COL_FMT[t.key].fmt(p)}
              </span>
            ))}
          </div>
        ))}
      </div></div>

      <div class="c-foot">
        <span>top {rows.length} by {COL_FMT[sort].head.toLowerCase()}{node.kernel ? ` · kernel ${node.kernel}` : ''}</span>
        <button class="inspect" onClick={() => onOpen(node.id)}>inspect<Chevron size={13} /></button>
      </div>
    </article>
  );
};


export const FleetView = ({ nodes, onOpen, tempHistory, powerHistory, netHistory, gpuTempHistory, gpuPowerHistory }: {
  nodes: FleetNode[]; onOpen: (id: string) => void;
  tempHistory: Map<string, number[]>; powerHistory: Map<string, number[]>;
  netHistory: Map<string, Array<[number, number]>>;
  gpuTempHistory: Map<string, number[]>; gpuPowerHistory: Map<string, number[]>;
}) => {
  const card = (n: FleetNode, compact = false) => (
    <NodeCard
      key={n.id}
      node={n}
      compact={compact}
      onOpen={onOpen}
      tempHistory={tempHistory.get(n.id) ?? []}
      powerHistory={powerHistory.get(n.id) ?? []}
      netHistory={netHistory.get(n.id) ?? []}
      gpuTempHistory={gpuTempHistory.get(n.id) ?? []}
      gpuPowerHistory={gpuPowerHistory.get(n.id) ?? []}
    />
  );
  // One machine takes the whole width. With more, the server keeps that card
  // and every other board (the Pi) gets a narrow one in a column beside it,
  // or under it on a narrower screen. The server is the cluster's control
  // plane, or failing that the board with the most threads.
  if (nodes.length <= 1) return <div class="grid single">{nodes.map((n) => card(n))}</div>;
  const main = nodes.find((n) => n.role === 'control-plane')
    ?? [...nodes].sort((a, b) => (b.cpu?.perCore.length ?? 0) - (a.cpu?.perCore.length ?? 0))[0];
  return (
    <div class="grid with-side">
      {card(main)}
      <div class="side">{nodes.filter((n) => n !== main).map((n) => card(n, true))}</div>
    </div>
  );
};
