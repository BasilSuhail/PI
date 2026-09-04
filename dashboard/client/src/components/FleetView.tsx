import type { CredentialStatus, FleetNode, ProcessRow } from '../../../shared/fleet';
import { bytes, capacity, celsius, cpuTone, diskTone, memTone, pct, relative, shortDate, uptime, watts, swapTone } from '../lib/format';
import { Chevron, Cpu, Key, Mem, Nodes, Power, Shield, Thermo } from './icons';
import { Meter, StatusDot } from './primitives';

export type SortKey = 'cpuPct' | 'memBytes' | 'diskReadBytes' | 'threads';

export const SORT_COLUMNS: Array<{ key: SortKey; tab: string; head: string; fmt: (p: ProcessRow) => string }> = [
  { key: 'cpuPct',        tab: 'CPU',     head: 'CPU %',  fmt: (p) => (p.cpuPct == null ? '—' : p.cpuPct.toFixed(1)) },
  { key: 'memBytes',      tab: 'Memory',  head: 'MEMORY', fmt: (p) => bytes(p.memBytes) },
  { key: 'diskReadBytes', tab: 'Disk',    head: 'READ',   fmt: (p) => (p.diskReadBytes ? bytes(p.diskReadBytes) : '—') },
  { key: 'threads',       tab: 'Threads', head: 'THR',    fmt: (p) => String(p.threads) },
];

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

const NodeCard = ({ node, sort, onOpen }: { node: FleetNode; sort: SortKey; onOpen: (id: string) => void }) => {
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
  const thr = node.temp?.throttled;
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
  const metric = (p: ProcessRow) => p[sort] ?? -1;
  const rows = [...node.topProcesses].sort((a, b) => metric(b) - metric(a)).slice(0, ROWS);

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
        {/* Said out loud rather than shown as live. The board was too busy to
            answer this poll, so part of this card is the previous one. */}
        {node.stale ? ' · holding last reading' : ''}
      </p>

      <div class="mrow">
        <span class="lbl">CPU</span><Meter value={cpu} tone={cpuTone(cpu)} />
        <strong class="fig">{pct(cpu)}</strong>
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

      <div class="c-meta">
        <span><Thermo size={13} /><em>TEMP</em><b>{celsius(node.temp?.cpuC)}</b></span>
        {node.capabilities.includes('power') && (
          <span><Power size={13} /><em>POWER</em><b>{watts(node.power?.watts)}</b></span>
        )}
        <span><Cpu size={13} /><em>UPTIME</em><b>{uptime(node.uptimeSec)}</b></span>
        <span class={`chip ${thr?.now || thr?.everSinceBoot ? 'warn' : 'ok'}`}>
          {thr?.now ? 'throttling now' : thr?.everSinceBoot ? 'throttled since boot' : '✓ nominal'}
        </span>
      </div>

      <div class="ptable" data-sort={sort}><div class="pscroll">
        <div class="prow phead">
          <span>PROCESS</span>
          {SORT_COLUMNS.map((c) => (
            <span key={c.key} data-col={c.key} class={c.key === sort ? 'sorted' : ''}>
              {c.head}{c.key === sort ? ' ▾' : ''}
            </span>
          ))}
        </div>
        {rows.length === 0 && (
          <div class="prow body"><span class="pname">—</span><span class="pval">no data</span><span /><span /><span /></div>
        )}
        {rows.map((p) => (
          <div class="prow body" key={p.pid}>
            <span class="pname">{p.name}</span>
            {SORT_COLUMNS.map((c) => (
              <span key={c.key} data-col={c.key}
                    class={`pval ${c.key === 'cpuPct' && (p.cpuPct ?? 0) > 100 ? 'hot' : c.key === sort ? 'lead' : ''}`}>
                {c.fmt(p)}
              </span>
            ))}
          </div>
        ))}
      </div></div>

      <div class="c-foot">
        <span>top {rows.length} by {SORT_COLUMNS.find((c) => c.key === sort)!.head.toLowerCase()}</span>
        <button class="inspect" onClick={() => onOpen(node.id)}>inspect<Chevron size={13} /></button>
      </div>
    </article>
  );
};

const Cell = ({ icon, tone, label, value, sub, vclass = '' }: {
  icon: preact.ComponentChildren; tone: string; label: string; value: string; sub: string; vclass?: string;
}) => (
  <div class="cell">
    <span class={`ticon ${tone}`}>{icon}</span>
    <div><span>{label}</span><strong class={vclass}>{value}</strong><small>{sub}</small></div>
  </div>
);

/**
 * The one thing on this page that is about the dashboard rather than the
 * boards. A key that lapses empties the fleet with no warning anywhere else,
 * so it earns a tile beside the fleet totals rather than a line in the docs.
 */
const CredentialCell = ({ cred }: { cred: CredentialStatus }) => {
  const tone = cred.state === 'expired' ? 'red' : cred.state === 'soon' ? 'orange' : 'grey';
  const vclass = cred.state === 'expired' ? 'critv' : cred.state === 'soon' ? 'warnv' : '';

  // The date is the answer to "when", which is what gets acted on. Days are
  // the answer to "how urgent", and belong underneath it.
  const sub =
    cred.state === 'unknown' ? 'expiry not recorded'
    : cred.state === 'expired' ? 'expired · nodes will not load'
    : cred.daysLeft === 0 ? 'expires today'
    : `${cred.daysLeft} day${cred.daysLeft === 1 ? '' : 's'} left`;

  return (
    <Cell icon={<Key />} tone={tone} label={cred.name}
          value={cred.state === 'unknown' ? '—' : shortDate(cred.expiresAt)}
          sub={sub} vclass={vclass} />
  );
};

export const FleetView = ({ nodes, sort, credentials, onOpen }: {
  nodes: FleetNode[]; sort: SortKey; credentials: CredentialStatus[]; onOpen: (id: string) => void;
}) => {
  const live = nodes.filter((n) => n.online && !n.error);
  const thr = live.filter((n) => n.temp?.throttled?.now).length;
  const avgCpu = live.length ? live.reduce((s, n) => s + (n.cpu?.usagePct ?? 0), 0) / live.length : 0;
  const avgMem = live.length ? live.reduce((s, n) => s + (n.mem?.usedPct ?? 0), 0) / live.length : 0;
  const powered = live.filter((n) => n.power);
  const totalW = powered.reduce((s, n) => s + (n.power?.watts ?? 0), 0);
  const busiest = live.reduce<FleetNode | null>((a, n) => ((n.cpu?.usagePct ?? 0) > (a?.cpu?.usagePct ?? -1) ? n : a), null);
  const hot = live.reduce<FleetNode | null>((a, n) => ((n.temp?.cpuC ?? -1) > (a?.temp?.cpuC ?? -1) ? n : a), null);
  const hotC = hot?.temp?.cpuC ?? 0;

  return (
    <>
      <div class="grid">
        {nodes.map((n) => <NodeCard key={n.id} node={n} sort={sort} onOpen={onOpen} />)}
      </div>

      <div class="striprule"><span>FLEET</span><div /></div>
      <div class="strip">
        <div class="sgroup">
          <div class="pair">
            <Cell icon={<Nodes />} tone="grey" label="Nodes"
                  value={`${live.length}/${nodes.length}`} sub="online" />
            <Cell icon={<Shield />} tone={thr ? 'red' : 'green'} label="Throttling"
                  value={String(thr)} sub={thr ? 'needs attention' : 'none'} />
          </div>
        </div>
        {credentials.length > 0 && (
          <div class="sgroup">
            <div class="pair">
              {credentials.map((c) => <CredentialCell key={c.name} cred={c} />)}
            </div>
          </div>
        )}
        <div class="sgroup">
          <div class="pair">
            <Cell icon={<Cpu />} tone="green" label="CPU" value={pct(avgCpu)}
                  sub={busiest ? `avg · ${busiest.name} peak ${pct(busiest.cpu?.usagePct ?? 0)}` : 'avg'}
                  vclass={avgCpu > 80 ? 'critv' : avgCpu > 50 ? 'warnv' : ''} />
            <Cell icon={<Mem />} tone="aqua" label="Memory" value={pct(avgMem)} sub="fleet average"
                  vclass={avgMem > 85 ? 'critv' : avgMem > 70 ? 'warnv' : ''} />
          </div>
          <div class="pair">
            <Cell icon={<Power />} tone="aqua" label="Power"
                  value={powered.length ? watts(totalW) : '—'}
                  sub={powered.length ? `across ${powered.length} node${powered.length > 1 ? 's' : ''}` : 'no PMIC nodes'} />
            <Cell icon={<Thermo />} tone={hotC > 70 ? 'red' : 'orange'} label="Temperature"
                  value={celsius(hot?.temp?.cpuC)}
                  sub={hot ? `${hot.name} warmest · limit 85°` : '—'}
                  vclass={hotC > 80 ? 'critv' : hotC > 70 ? 'warnv' : ''} />
          </div>
        </div>
      </div>
    </>
  );
};
