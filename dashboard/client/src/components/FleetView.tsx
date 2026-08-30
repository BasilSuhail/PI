import type { FleetNode, ProcessRow } from '../../../shared/fleet';
import { bytes, capacity, celsius, cpuTone, diskTone, memTone, pct, relative, uptime, watts } from '../lib/format';
import { Chevron, Cpu, Mem, Nodes, Power, Shield, Thermo } from './icons';
import { Meter, StatusDot } from './primitives';

export type SortKey = 'cpuPct' | 'memBytes' | 'diskReadBytes' | 'threads';

export const SORT_COLUMNS: Array<{ key: SortKey; tab: string; head: string; fmt: (p: ProcessRow) => string }> = [
  { key: 'cpuPct',        tab: 'CPU',     head: 'CPU %',  fmt: (p) => p.cpuPct.toFixed(1) },
  { key: 'memBytes',      tab: 'Memory',  head: 'MEMORY', fmt: (p) => bytes(p.memBytes) },
  { key: 'diskReadBytes', tab: 'Disk',    head: 'READ',   fmt: (p) => (p.diskReadBytes ? bytes(p.diskReadBytes) : '—') },
  { key: 'threads',       tab: 'Threads', head: 'THR',    fmt: (p) => String(p.threads) },
];

const ROWS = 5;

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
  // Root filesystem: the boot medium is the SD card on pi1, so the disk the
  // system actually lives on is the one worth a bar.
  const disk = node.disks.find((d) => d.mount === '/') ?? node.disks[0];
  const rows = [...node.topProcesses].sort((a, b) => b[sort] - a[sort]).slice(0, ROWS);

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
      </p>

      <div class="mrow">
        <span>CPU</span><Meter value={cpu} tone={cpuTone(cpu)} /><strong>{pct(cpu)}</strong>
      </div>
      <div class="mrow">
        <span>RAM</span><Meter value={mem} tone={memTone(mem)} /><strong>{pct(mem)}</strong>
      </div>
      {disk && (
        <div class="mrow" title={`${disk.device} on ${disk.mount} — ${bytes(disk.usedBytes)} of ${capacity(disk.totalBytes)}`}>
          <span>DISK</span>
          <Meter value={disk.usedPct} tone={diskTone(disk.usedPct)} />
          <strong>{pct(disk.usedPct)}</strong>
        </div>
      )}

      <div class="c-meta">
        <span><Thermo size={13} />{celsius(node.temp?.cpuC)}</span>
        {node.capabilities.includes('power') && <span><Power size={13} />{watts(node.power?.watts)}</span>}
        <span><Cpu size={13} />{uptime(node.uptimeSec)}</span>
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
                    class={`pval ${c.key === 'cpuPct' && p.cpuPct > 100 ? 'hot' : c.key === sort ? 'lead' : ''}`}>
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

export const FleetView = ({ nodes, sort, onOpen }: {
  nodes: FleetNode[]; sort: SortKey; onOpen: (id: string) => void;
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
