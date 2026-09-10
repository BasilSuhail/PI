/**
 * The process table behind "view more" — a classic activity monitor:
 * one header row naming the columns (process · cpu · memory · energy ·
 * disk · network), one plain row per process, values only, no bars.
 *
 * Clicking a column header sorts by it. Energy is the board's watts
 * apportioned by CPU share — Linux cannot measure per-process power, so
 * it is red and labelled ≈, an estimate. Per-process network is not
 * something the agent reports; the column stays, honestly dashed.
 */

import { useMemo, useState } from 'preact/hooks';
import type { ProcessRow } from '../../../shared/fleet';
import { getProcesses, usePoll } from '../lib/api';
import { bytes, pct } from '../lib/format';
import type { RailNode } from './PiCard';

type SortKey = 'cpu' | 'mem' | 'power' | 'read';

/** The columns, in order; `key` null where a column cannot sort. */
const COLS: Array<{ key: SortKey | null; label: string }> = [
  { key: null, label: '#' },
  { key: null, label: 'process' },
  { key: 'cpu', label: 'cpu' },
  { key: 'mem', label: 'memory' },
  { key: 'power', label: 'energy' },
  { key: 'read', label: 'disk' },
  { key: null, label: 'network' },
];

/** Board watts × this process's share of all cores. An estimate; see above. */
const estWatts = (
  p: ProcessRow,
  watts: number | null,
  cores: number | null,
): number | null =>
  watts != null && cores != null && p.cpuPct != null
    ? (watts * p.cpuPct) / (cores * 100)
    : null;

export const ProcessMonitor = ({ node }: { node: RailNode }) => {
  const [sort, setSort] = useState<SortKey>('cpu');
  const [filter, setFilter] = useState('');

  // Polls only while mounted — the monitor is behind "view more", so the
  // boards answer these extra requests only while somebody is watching.
  const poll = usePoll(() => getProcesses(node.id, 25), 3000, [node.id]);
  const watts = node.power?.watts ?? null;
  const cores = node.cpu?.cores ?? null;

  const procs = useMemo(() => {
    const list = poll.data ?? (poll.loading ? node.topProcesses : []);
    const q = filter.trim().toLowerCase();
    const matched = q
      ? list.filter((p) =>
          p.name.toLowerCase().includes(q) ||
          String(p.pid).includes(q) ||
          (p.user ?? '').toLowerCase().includes(q))
      : list;
    const key = (p: ProcessRow): number => {
      switch (sort) {
        case 'mem': return p.memBytes;
        case 'power': return estWatts(p, watts, cores) ?? -1;
        case 'read': return p.diskReadBytes;
        default: return p.cpuPct ?? -1;
      }
    };
    return [...matched].sort((a, b) => key(b) - key(a));
  }, [poll.data, poll.loading, node.topProcesses, filter, sort, watts, cores]);

  const totals = useMemo(() => {
    let cpu = 0, ram = 0, pwr = 0;
    for (const p of procs) {
      cpu += p.cpuPct ?? 0;
      ram += p.memBytes;
      pwr += estWatts(p, watts, cores) ?? 0;
    }
    return { cpu, ram, pwr };
  }, [procs, watts, cores]);

  return (
    <div class="pm">
      <div class="pm-bar">
        <input
          class="pm-filter"
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
          placeholder="Filter by name, pid or user"
          aria-label="Filter processes"
        />
        <span class="pm-count">{procs.length} running</span>
      </div>

      <div class="pm-list">
        <div class="pm-row pm-thead">
          {COLS.map((c) => {
            const k = c.key;
            return k ? (
              <button
                key={c.label}
                class={`pm-th ${sort === k ? 'on' : ''}`}
                onClick={() => setSort(k)}
                title={`sort by ${c.label}`}
              >
                {c.label}{sort === k ? ' ▾' : ''}
              </button>
            ) : (
              <span key={c.label} class={`pm-th ${c.label === '#' || c.label === 'network' ? 'ta-r' : ''}`}>{c.label}</span>
            );
          })}
        </div>

        {procs.map((p, i) => {
          const est = estWatts(p, watts, cores);
          return (
            <div class="pm-row" key={p.pid} title={p.cmdline ?? p.name}>
              <span class="pm-i ta-r">{i + 1}</span>
              <span class="pm-name">
                {p.name}
                <small>pid {p.pid}{p.user ? ` · ${p.user}` : ''} · {p.threads}t</small>
              </span>
              <span class="pm-v">{p.cpuPct == null ? '—' : pct(p.cpuPct)}</span>
              <span class="pm-v">{bytes(p.memBytes, 1)}</span>
              <span class="pm-v t-red" title="Board watts apportioned by CPU share — an estimate, not a measurement.">
                {est == null ? '—' : `≈${est < 0.1 ? est.toFixed(3) : est.toFixed(2)}W`}
              </span>
              <span class="pm-v" title="cumulative bytes read since start">{p.diskReadBytes ? bytes(p.diskReadBytes, 1) : '—'}</span>
              <span class="pm-v muted" title="per-process network is not reported by the agent">—</span>
            </div>
          );
        })}

        {!procs.length && (
          <div class="empty">
            {poll.error ? `agent refused — ${poll.error}` : filter ? `nothing matches “${filter}”` : 'No process data.'}
          </div>
        )}
      </div>

      <div class="pm-totals">
        <span>Σ cpu {pct(totals.cpu)}</span>
        <span>Σ memory {bytes(totals.ram, 1)}</span>
        <span class="t-red" title="Sum of per-process estimates; the board itself is the measured total.">Σ energy ≈{totals.pwr.toFixed(2)}W</span>
      </div>
    </div>
  );
};
