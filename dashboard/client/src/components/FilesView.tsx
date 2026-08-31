/**
 * Miller columns over the browsable disks, biggest first — the OmniDiskSweeper
 * layout, because the question being asked of a homelab disk is almost always
 * "what is eating it" rather than "where is that one file".
 *
 * Every entry is shown, dotfiles included. On these boards the answer is
 * usually a dotfile — .cache, .ollama, a stray .venv — and hiding them would
 * also make each column stop adding up to its parent.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { DirEntry, DirListing, FleetNode } from '../../../shared/fleet';
import { getListing, getRoots } from '../lib/api';
import { bytes, relative } from '../lib/format';
import { Alert, Chevron, Disk } from './icons';

interface Cell {
  listing: DirListing | null;
  error: string | null;
  loading: boolean;
}

/**
 * Size drives the colour, so a column reads at a glance without comparing
 * numbers. The thresholds are deliberately coarse — this is meant to be
 * skimmed, not measured.
 */
const magnitude = (n: number): string => {
  if (n === 0) return 'zero';
  if (n >= 1e9) return 'huge';
  if (n >= 1e8) return 'big';
  if (n >= 1e6) return 'mid';
  return 'small';
};

const Row = ({
  entry,
  selected,
  onOpen,
}: {
  entry: DirEntry;
  selected: boolean;
  onOpen: () => void;
}) => (
  <button
    class={`fx-row ${selected ? 'on' : ''} ${entry.hidden ? 'hidden' : ''}`}
    onClick={onOpen}
    title={`${entry.name} · ${bytes(entry.bytes)} · ${relative(new Date(entry.mtime * 1000).toISOString())}`}
  >
    <span class={`fx-size ${magnitude(entry.bytes)}`}>{bytes(entry.bytes)}</span>
    {/* A symlink is set in italic, the way a file manager does, so a link to
        somewhere huge is not mistaken for the thing itself. */}
    <span class={`fx-name ${entry.link ? 'link' : ''}`}>{entry.name}</span>
    {entry.dir && <Chevron size={13} class="fx-arrow" />}
  </button>
);

const Column = ({
  cell,
  selectedName,
  onOpen,
}: {
  cell: Cell;
  selectedName: string | null;
  onOpen: (entry: DirEntry) => void;
}) => {
  if (cell.loading && !cell.listing) {
    return (
      <div class="fx-col">
        <div class="fx-note">
          <span class="fx-spinner" /> Sizing the tree…
        </div>
      </div>
    );
  }
  if (cell.error) {
    return (
      <div class="fx-col">
        <div class="fx-note bad">
          <Alert size={14} /> {cell.error}
        </div>
      </div>
    );
  }
  const listing = cell.listing;
  if (!listing) return <div class="fx-col" />;

  return (
    <div class="fx-col">
      {listing.entries.map((entry) => (
        <Row
          key={entry.name}
          entry={entry}
          selected={entry.name === selectedName}
          onOpen={() => onOpen(entry)}
        />
      ))}
      {listing.entries.length === 0 && <div class="fx-note">Empty</div>}
      {listing.truncated > 0 && (
        <div class="fx-note">{listing.truncated} smaller entries not shown</div>
      )}
      {!listing.complete && (
        <div class="fx-note bad">
          <Alert size={14} /> Sizing timed out — these are floors, not totals
        </div>
      )}
    </div>
  );
};

export const FilesView = ({ nodes }: { nodes: FleetNode[] }) => {
  const reachable = nodes.filter((n) => n.online && !n.error);
  const [nodeId, setNodeId] = useState<string | null>(null);
  /** Open directories, left to right. The first is a root. */
  const [trail, setTrail] = useState<string[]>([]);
  const [cells, setCells] = useState<Record<string, Cell>>({});
  const [rootError, setRootError] = useState<string | null>(null);
  const strip = useRef<HTMLDivElement>(null);

  const active = nodeId ?? reachable[0]?.id ?? null;

  // Pick the first root as soon as a node is chosen, so the view opens with
  // something on screen rather than an empty frame and a prompt.
  useEffect(() => {
    if (!active) return;
    setTrail([]);
    setCells({});
    setRootError(null);
    let alive = true;
    getRoots(active)
      .then((res) => {
        if (!alive) return;
        if (res.roots.length === 0) {
          setRootError('Nothing is browsable on this node yet. Run deploy/setup-browse.sh on it.');
          return;
        }
        setTrail([res.roots[0].path]);
      })
      .catch((err: Error) => alive && setRootError(err.message));
    return () => {
      alive = false;
    };
  }, [active]);

  // Fetch any column that is open and has no answer yet. Keyed by node and
  // path so switching boards cannot show the other one's tree.
  useEffect(() => {
    if (!active) return;
    for (const path of trail) {
      const key = `${active}:${path}`;
      if (cells[key]) continue;
      setCells((prev) => ({ ...prev, [key]: { listing: null, error: null, loading: true } }));
      getListing(active, path)
        .then((listing) =>
          setCells((prev) => ({ ...prev, [key]: { listing, error: null, loading: false } })),
        )
        .catch((err: Error) =>
          setCells((prev) => ({ ...prev, [key]: { listing: null, error: err.message, loading: false } })),
        );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, trail]);

  // A new column appears off the right edge; scroll to it the way Finder does.
  useEffect(() => {
    const el = strip.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [trail.length]);

  const [selected, setSelected] = useState<Record<number, string>>({});

  const open = (depth: number, entry: DirEntry) => {
    const parent = trail[depth];
    const child = `${parent.replace(/\/$/, '')}/${entry.name}`;
    // Everything to the right of the clicked column is now wrong. A file
    // selects without opening anything, which is what closes the tail.
    setTrail(entry.dir ? [...trail.slice(0, depth + 1), child] : trail.slice(0, depth + 1));
    setSelected({ ...selected, [depth]: entry.name });
  };

  const deepest = cells[`${active}:${trail[trail.length - 1]}`]?.listing ?? null;

  if (reachable.length === 0) {
    return (
      <div class="app-note">
        <Disk size={18} />
        <div>
          <strong>No node is answering</strong>
          <span>The disks can only be read through a board that is online.</span>
        </div>
      </div>
    );
  }

  return (
    <div class="page-stack">
      <div class="page-heading">
        <div>
          <p class="eyebrow">
            STORAGE <span class="mini-led" />
          </p>
          <h1>Everything, biggest first.</h1>
          <p class="subhead">Hidden files included — they are usually the answer.</p>
        </div>
        {reachable.length > 1 && (
          <div class="seg">
            {reachable.map((n) => (
              <button key={n.id} class={n.id === active ? 'on' : ''} onClick={() => setNodeId(n.id)}>
                {n.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {rootError && (
        <div class="warning-banner">
          <Alert size={18} />
          <div>
            <strong>Nothing to browse</strong>
            <span>{rootError}</span>
          </div>
        </div>
      )}

      <div class="fx-strip" ref={strip}>
        {trail.map((path, depth) => (
          <Column
            key={`${active}:${path}`}
            cell={cells[`${active}:${path}`] ?? { listing: null, error: null, loading: true }}
            selectedName={selected[depth] ?? null}
            onOpen={(entry) => open(depth, entry)}
          />
        ))}
      </div>

      {deepest && (
        <div class="fx-status">
          <span class="fx-path">{deepest.path}</span>
          <span>
            {bytes(deepest.total)} · {deepest.count} {deepest.count === 1 ? 'entry' : 'entries'}
          </span>
        </div>
      )}
    </div>
  );
};
