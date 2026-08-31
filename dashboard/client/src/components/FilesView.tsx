/**
 * The disks, as columns: board, then disk, then folder, then file.
 *
 * Miller columns sorted biggest first — the OmniDiskSweeper layout, because
 * the question asked of a homelab disk is almost always "what is eating it"
 * rather than "where is that one file". The board is the first column rather
 * than a control above them, so moving between machines is the same gesture
 * as opening a folder.
 *
 * A board holds nothing itself. Everything is on one of its disks, so the
 * second column is disks and only disks — being "on pi" is not a place a
 * file could be saved, and the tree should not pretend otherwise. Named roots
 * like the archive are pinned inside the disk that actually holds them.
 *
 * Every entry is shown, dotfiles included. On these boards the answer is
 * usually a dotfile — .cache, .ollama, a stray .venv — and hiding them would
 * also make each column stop adding up to its parent.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { DirEntry, DirListing, DirRoots, FleetNode } from '../../../shared/fleet';
import { getListing, getRoots, thumbUrl, upload, write } from '../lib/api';
import { bytes } from '../lib/format';
import { Alert, Chevron, Disk, Grid, List } from './icons';

/** A board is column zero; below it, paths are real. `@node:<id>` marks one. */
const NODE_PREFIX = '@node:';
const isNodeCol = (key: string) => key.startsWith(NODE_PREFIX);
const nodeOf = (key: string) => key.slice(NODE_PREFIX.length);

/** Column zero itself. Not a path — the fleet. */
const FLEET = '@fleet';

interface Cell {
  listing: DirListing | null;
  error: string | null;
  loading: boolean;
}

interface Picked {
  entry: DirEntry;
  /** The column the entry lives in, so opening it truncates the right tail. */
  depth: number;
  /** Key of the column, which is what its children are fetched against. */
  parent: string;
  /** Board the entry is on. Null in column zero. */
  node: string | null;
  path: string;
}

/**
 * Size drives the colour so a column reads without comparing numbers. Coarse
 * on purpose — this is meant to be skimmed, not measured.
 */
const magnitude = (n: number): string =>
  n === 0 ? 'zero' : n >= 1e9 ? 'huge' : n >= 1e8 ? 'big' : n >= 1e6 ? 'mid' : 'small';

const IMAGE = /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i;

/**
 * A disk's name in the column. The device is what distinguishes them on these
 * boards — sda is the SSD, mmcblk0 the card — and the mount point is what
 * makes a second partition of the same device tell itself apart.
 */
const diskName = (device: string, mount: string): string => {
  const dev = device.replace(/^\/dev\//, '');
  if (/^mmcblk/.test(dev)) return mount === '/' ? 'SD card' : `SD card · ${mount}`;
  if (/^(sd|nvme|vd)/.test(dev)) return mount === '/' ? 'SSD' : `SSD · ${mount}`;
  return mount === '/' ? dev : mount;
};

/**
 * Where a row leads. An entry carrying its own path is followed to it — that
 * covers boards, disks, and a root pinned into a disk's listing, none of which
 * sit where their name would put them. Joining the name onto the parent is the
 * fallback for ordinary directories, not the rule.
 */
const childKey = (parent: string, entry: DirEntry): string =>
  entry.path ?? `${parent.replace(/\/$/, '')}/${entry.name}`;

const entryPath = (listing: DirListing, entry: DirEntry): string =>
  childKey(listing.path, entry);

export const FilesView = ({ nodes }: { nodes: FleetNode[] }) => {
  const reachable = nodes.filter((n) => n.online && !n.error);
  const [trail, setTrail] = useState<string[]>([FLEET]);
  const [cells, setCells] = useState<Record<string, Cell>>({});
  const [picked, setPicked] = useState<Record<number, string>>({});
  const [sel, setSel] = useState<Picked | null>(null);
  const [view, setView] = useState<'list' | 'grid'>('list');
  const [preview, setPreview] = useState<Picked | null>(null);
  /** Named roots per board, so a disk's column can pin the ones that live on it. */
  const [rootsByNode, setRootsByNode] = useState<Record<string, DirRoots['roots']>>({});
  const [clip, setClip] = useState<{ node: string; path: string; name: string; cut: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const strip = useRef<HTMLDivElement>(null);

  /** Column zero is built here rather than fetched — the fleet is already known. */
  const fleetCell: Cell = {
    loading: false,
    error: reachable.length === 0 ? 'No board is answering. The disks are only readable through one.' : null,
    listing: {
      path: FLEET,
      parent: null,
      total: 0,
      count: reachable.length,
      truncated: 0,
      complete: true,
      // No size on a board. It holds several disks and adding them together
      // produces a number that describes none of them; the figures belong on
      // the disks themselves, one column in.
      entries: reachable.map((n) => ({
        name: n.name,
        dir: true,
        link: false,
        bytes: 0,
        mtime: 0,
        hidden: false,
        path: NODE_PREFIX + n.id,
      })),
    },
  };

  const cellFor = (key: string): Cell =>
    key === FLEET ? fleetCell : (cells[key] ?? { listing: null, error: null, loading: true });

  /** The board a column belongs to, walking back up the trail. */
  const nodeAt = (depth: number): string | null => {
    for (let i = depth; i >= 0; i -= 1) {
      if (isNodeCol(trail[i])) return nodeOf(trail[i]);
    }
    return null;
  };

  // Fetch any open column that has no answer yet. A board's column asks for
  // its roots; everything deeper asks for one directory.
  useEffect(() => {
    trail.forEach((key, depth) => {
      if (key === FLEET || cells[key]) return;
      const node = nodeAt(depth);
      if (!node) return;
      setCells((prev) => ({ ...prev, [key]: { listing: null, error: null, loading: true } }));

      const done = (listing: DirListing) =>
        setCells((prev) => ({ ...prev, [key]: { listing, error: null, loading: false } }));
      const failed = (err: Error) =>
        setCells((prev) => ({ ...prev, [key]: { listing: null, error: err.message, loading: false } }));

      if (isNodeCol(key)) {
        const board = nodes.find((n) => n.id === node);
        getRoots(node)
          .then((res) => {
            setRootsByNode((prev) => ({ ...prev, [node]: res.roots }));
            const entries: DirEntry[] = (board?.disks ?? []).map((d) => ({
              name: diskName(d.device, d.mount),
              dir: true,
              link: false,
              bytes: d.usedBytes,
              mtime: 0,
              hidden: false,
              path: d.mount,
              capacity: d.totalBytes,
            }));
            done({
              path: key,
              parent: null,
              total: 0,
              count: entries.length,
              truncated: 0,
              complete: true,
              entries,
            });
          })
          .catch(failed);
      } else {
        getListing(node, key)
          .then((listing) => done({ ...listing, entries: withPins(listing, node) }))
          .catch(failed);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trail]);

  // A new column arrives off the right edge; follow it, the way Finder does.
  useEffect(() => {
    const el = strip.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [trail.length]);

  /**
   * A named root shown at the top of the disk that holds it. Only on the
   * disk's own column: deeper down it would appear again at every level.
   */
  const withPins = (listing: DirListing, node: string): DirEntry[] => {
    const board = nodes.find((n) => n.id === node);
    const isMount = (board?.disks ?? []).some((d) => d.mount === listing.path);
    if (!isMount) return listing.entries;
    const pins = (rootsByNode[node] ?? [])
      .filter((r) => r.path !== listing.path && r.path.startsWith(listing.path.replace(/\/$/, '') + '/'))
      .map((r) => ({
        name: r.name,
        dir: true,
        link: false,
        bytes: 0,
        mtime: 0,
        hidden: false,
        path: r.path,
        locked: !r.writable,
        pinned: true,
      }));
    return [...pins, ...listing.entries];
  };

  const here = trail[trail.length - 1];
  const hereListing = cellFor(here).listing;

  /** Forget a column so the fetch effect asks for it again. */
  const invalidate = (...keys: string[]) =>
    setCells((prev) => {
      const next = { ...prev };
      for (const key of keys) delete next[key];
      return next;
    });

  /**
   * Every change goes through here: run it, show whatever the board said if it
   * refused, then drop the columns it touched so they are read again rather
   * than patched locally into something that might not match the disk.
   */
  const act = async (fn: () => Promise<void>, ...touched: string[]) => {
    setBusy(true);
    setProblem(null);
    try {
      await fn();
      invalidate(...touched.filter(Boolean));
      setSel(null);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'that was refused');
    } finally {
      setBusy(false);
    }
  };

  const select = (entry: DirEntry, parent: string, depth: number) => {
    setSel({ entry, parent, depth, node: nodeAt(depth), path: childKey(parent, entry) });
    // Drop every selection to the right: those rows belonged to what was open
    // before, and leaving them lit makes a refreshed column look stale.
    setPicked((prev) => ({
      ...Object.fromEntries(Object.entries(prev).filter(([d]) => +d < depth)),
      [depth]: entry.name,
    }));
  };

  const open = (entry: DirEntry, parent: string, depth: number) => {
    const key = childKey(parent, entry);
    select(entry, parent, depth);
    // Clicking the open folder again folds it back up. Anything to its right
    // belonged to it and goes with it.
    const alreadyOpen = trail[depth + 1] === key;
    setTrail(entry.dir && !alreadyOpen ? [...trail.slice(0, depth + 1), key] : trail.slice(0, depth + 1));
  };

  /** Clicking under the rows drops the row selection and targets the column. */
  const targetColumn = (depth: number) => {
    setSel(null);
    setPicked((prev) => Object.fromEntries(Object.entries(prev).filter(([d]) => +d < depth)));
    setTrail(trail.slice(0, depth + 1));
  };

  const download = () => {
    if (!sel || !sel.node || sel.entry.dir) return;
    // A plain navigation, so the browser's own download handling takes over
    // rather than this holding the bytes in memory.
    window.location.href = `/api/nodes/${encodeURIComponent(sel.node)}/download?path=${encodeURIComponent(sel.path)}`;
  };

  const siblings = (): DirEntry[] =>
    (cellFor(sel?.parent ?? here).listing?.entries ?? []).filter((e) => !e.dir && IMAGE.test(e.name));

  const step = (dir: number) => {
    if (!preview) return;
    const list = siblings();
    const at = list.findIndex((e) => e.name === preview.entry.name);
    if (at < 0 || list.length === 0) return;
    const next = list[(at + dir + list.length) % list.length];
    setPreview({ ...preview, entry: next, path: childKey(preview.parent, next) });
  };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setPreview(null);
        return;
      }
      if (ev.key === ' ' && (sel || preview)) {
        ev.preventDefault();
        if (preview) setPreview(null);
        else if (sel && !sel.entry.dir && IMAGE.test(sel.entry.name)) setPreview(sel);
        return;
      }
      if (preview && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft')) {
        ev.preventDefault();
        step(ev.key === 'ArrowRight' ? 1 : -1);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const canPreview = !!sel && !sel.entry.dir && IMAGE.test(sel.entry.name);
  const node = nodeAt(trail.length - 1);
  /** Writes land in the column being looked at; its own flag decides. */
  const canWriteHere = !!hereListing?.writable && !!node;
  /** Renaming or deleting changes the folder the row sits in, not the row. */
  const canChangeSel = !!sel && !!cellFor(sel.parent).listing?.writable && !!sel.node;

  const newFolder = () => {
    const name = prompt('Name for the new folder');
    if (!name || !node) return;
    void act(() => write(node, { op: 'mkdir', path: here, name }), here);
  };

  const rename = () => {
    if (!sel || !sel.node) return;
    const name = prompt('Rename to', sel.entry.name);
    if (!name || name === sel.entry.name) return;
    void act(() => write(sel.node!, { op: 'rename', path: sel.path, name }), sel.parent);
  };

  const remove = () => {
    if (!sel || !sel.node) return;
    const what = sel.entry.dir ? `${sel.entry.name} and everything in it` : sel.entry.name;
    if (!confirm(`Delete ${what}?\n\nThis cannot be undone.`)) return;
    void act(() => write(sel.node!, { op: 'delete', path: sel.path }), sel.parent, sel.path);
  };

  const paste = () => {
    if (!clip || !node) return;
    void act(
      () => write(node, { op: clip.cut ? 'move' : 'copy', path: clip.path, to: here }),
      here,
      clip.path.replace(/\/[^/]+$/, ''),
    );
    if (clip.cut) setClip(null);
  };

  const duplicate = () => {
    if (!sel || !sel.node) return;
    void act(() => write(sel.node!, { op: 'copy', path: sel.path, to: sel.parent }), sel.parent);
  };

  /** A move by drag, and a drop of files from outside. Same destination. */
  const dropInto = (destination: string, ev: DragEvent) => {
    ev.preventDefault();
    if (!node) return;
    const files = [...(ev.dataTransfer?.files ?? [])];
    if (files.length) {
      void act(async () => {
        for (const file of files) await upload(node, destination, file);
      }, destination);
      return;
    }
    const moved = ev.dataTransfer?.getData('text/pi-path');
    if (!moved || moved === destination) return;
    void act(
      () => write(node, { op: 'move', path: moved, to: destination }),
      destination,
      moved.replace(/\/[^/]+$/, ''),
    );
  };

  return (
    <div class="page-stack">
      <div class="fx-bar">
        <div class="fx-sel">
          <strong>{sel ? sel.entry.name : hereListing ? label(here, hereListing, nodes) : 'Storage'}</strong>
          <span class="fx-meta">
            <span>{bytes(sel ? sel.entry.bytes : (hereListing?.total ?? 0))}</span>
            <span class="fx-where">
              {sel ? readablePath(nodes, sel.path) : readablePath(nodes, hereListing?.path ?? '')}
            </span>
          </span>
        </div>

        <div class="fx-actions">
          <button class="fx-act" disabled={!canPreview} onClick={() => sel && setPreview(sel)}>
            Quick Look
          </button>
          <button class="fx-act" disabled={!sel || sel.entry.dir} onClick={download}>
            Download
          </button>
          <button
            class="fx-act"
            disabled={!sel}
            onClick={() => sel && navigator.clipboard?.writeText(sel.path).catch(() => {})}
          >
            Copy path
          </button>
          <button class="fx-act" disabled={!sel || busy} onClick={duplicate}>Duplicate</button>
          <button
            class="fx-act"
            disabled={!sel || busy}
            onClick={() => sel && setClip({ node: sel.node!, path: sel.path, name: sel.entry.name, cut: false })}
          >
            Copy
          </button>
          <button
            class="fx-act"
            disabled={!canChangeSel || busy}
            onClick={() => sel && setClip({ node: sel.node!, path: sel.path, name: sel.entry.name, cut: true })}
          >
            Cut
          </button>
          <button class="fx-act" disabled={!clip || !canWriteHere || busy} onClick={paste}>
            Paste
          </button>
          <button class="fx-act" disabled={!canWriteHere || busy} onClick={newFolder}>
            New folder
          </button>
          <button class="fx-act" disabled={!canChangeSel || busy} onClick={rename}>Rename</button>
          <button class="fx-act danger" disabled={!canChangeSel || busy} onClick={remove}>Delete</button>
        </div>

        <div class="fx-view">
          <button class={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>
            <List size={13} /> List
          </button>
          <button class={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')}>
            <Grid size={13} /> Grid
          </button>
        </div>
      </div>

      {problem && (
        <div class="warning-banner">
          <Alert size={18} />
          <div>
            <strong>That did not happen</strong>
            <span>{problem}</span>
          </div>
        </div>
      )}

      {view === 'list' ? (
        <div class="fx-strip" ref={strip}>
          {trail.map((key, depth) => (
            <Column
              key={key}
              cell={cellFor(key)}
              selectedName={picked[depth] ?? null}
              node={nodeAt(depth)}
              onOpen={(entry) => open(entry, key, depth)}
              onTarget={() => targetColumn(depth)}
              onDrop={(destination, ev) => dropInto(destination, ev)}
              onMenu={(entry, ev) => {
                select(entry, key, depth);
                setMenu({ x: ev.clientX, y: ev.clientY });
              }}
            />
          ))}
        </div>
      ) : (
        <Grille
          cell={cellFor(here)}
          node={nodeAt(trail.length - 1)}
          selectedName={sel?.entry.name ?? null}
          onSelect={(entry) => select(entry, here, trail.length - 1)}
          onOpen={(entry) => open(entry, here, trail.length - 1)}
          onPreview={(entry) => setPreview({ entry, parent: here, depth: trail.length - 1, node: nodeAt(trail.length - 1), path: childKey(here, entry) })}
        />
      )}

      {hereListing && (
        <div class="fx-status">
          <span class="fx-where">
            {hereListing.path === FLEET
              ? 'fleet'
              : isNodeCol(hereListing.path)
                ? nodeName(nodes, nodeOf(hereListing.path))
                : hereListing.path}
          </span>
          <span>
            {hereListing.count} {hereListing.count === 1 ? 'entry' : 'entries'}
            {hereListing.truncated > 0 && ` · ${hereListing.truncated} smaller not shown`}
            {!hereListing.complete && ' · sizing timed out, totals are floors'}
          </span>
        </div>
      )}

      {menu && (
        <>
          {/* One list, two ways in. The bar and the menu offer the same
              actions with the same guards, so they cannot disagree. */}
          <div class="fx-scrim" onClick={() => setMenu(null)} />
          <div class="fx-menu" style={{ left: menu.x, top: menu.y }}>
            <button disabled={!canPreview} onClick={() => { setMenu(null); sel && setPreview(sel); }}>
              Quick Look
            </button>
            <button disabled={!sel || sel.entry.dir} onClick={() => { setMenu(null); download(); }}>
              Download
            </button>
            <hr />
            <button disabled={!sel} onClick={() => { setMenu(null); sel && setClip({ node: sel.node!, path: sel.path, name: sel.entry.name, cut: false }); }}>
              Copy
            </button>
            <button disabled={!canChangeSel} onClick={() => { setMenu(null); sel && setClip({ node: sel.node!, path: sel.path, name: sel.entry.name, cut: true }); }}>
              Cut
            </button>
            <button disabled={!clip || !canWriteHere} onClick={() => { setMenu(null); paste(); }}>
              Paste
            </button>
            <button disabled={!sel} onClick={() => { setMenu(null); duplicate(); }}>Duplicate</button>
            <hr />
            <button disabled={!canChangeSel} onClick={() => { setMenu(null); rename(); }}>Rename</button>
            <button class="danger" disabled={!canChangeSel} onClick={() => { setMenu(null); remove(); }}>
              Delete
            </button>
          </div>
        </>
      )}

      {preview && preview.node && (
        <div class="fx-ql" onClick={() => setPreview(null)}>
          <figure onClick={(e) => e.stopPropagation()}>
            <img src={thumbUrl(preview.node, preview.path)} alt={preview.entry.name} />
            <figcaption>
              <span>{preview.entry.name}</span>
              <span>{bytes(preview.entry.bytes)} · ← → to step · Esc to close</span>
            </figcaption>
          </figure>
        </div>
      )}
    </div>
  );
};

/** A board's own key is a tailnet id, which is not a thing to show anyone. */
const nodeName = (nodes: FleetNode[], id: string): string =>
  nodes.find((n) => n.id === id)?.name ?? id;

const readablePath = (nodes: FleetNode[], key: string): string =>
  key === FLEET ? 'fleet' : isNodeCol(key) ? nodeName(nodes, nodeOf(key)) : key;

/** A board column and a roots column have no path worth printing. */
const label = (key: string, listing: DirListing, nodes: FleetNode[]): string =>
  key === FLEET
    ? 'Fleet'
    : isNodeCol(key)
      ? nodeName(nodes, nodeOf(key))
      : listing.path.split('/').pop() || listing.path;

const Column = ({
  cell,
  selectedName,
  node,
  onOpen,
  onTarget,
  onDrop,
  onMenu,
}: {
  cell: Cell;
  selectedName: string | null;
  node: string | null;
  onOpen: (entry: DirEntry) => void;
  onTarget: () => void;
  onDrop: (destination: string, ev: DragEvent) => void;
  onMenu: (entry: DirEntry, ev: MouseEvent) => void;
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
        <button
          class={`fx-row ${entry.name === selectedName ? 'on' : ''} ${entry.hidden ? 'hidden' : ''} ${entry.pinned ? 'pin' : ''}`}
          onClick={() => onOpen(entry)}
          onContextMenu={(ev) => { ev.preventDefault(); onMenu(entry, ev as unknown as MouseEvent); }}
          key={entry.name}
          draggable={!entry.pinned}
          onDragStart={(ev) =>
            ev.dataTransfer?.setData('text/pi-path', entryPath(listing, entry))
          }
          // Only a folder is a destination. Dropping on a file would have to
          // guess whether you meant beside it or into its parent.
          onDragOver={(ev) => entry.dir && ev.preventDefault()}
          onDrop={(ev) => entry.dir && onDrop(entryPath(listing, entry), ev as unknown as DragEvent)}
        >
          <span class={`fx-size ${magnitude(entry.bytes)}`}>
            {entry.bytes ? bytes(entry.bytes) : '—'}
            {entry.capacity ? <span class="fx-cap"> / {bytes(entry.capacity)}</span> : null}
          </span>
          {/* Italic for a symlink, the way a file manager sets one, so a link
              to something huge is not mistaken for the thing itself. */}
          <span class={`fx-name ${entry.link ? 'link' : ''}`}>{entry.name}</span>
          {/* A locked root is readable and copyable like anything else; what
              it refuses is being changed. Marked so that is visible before
              you try. */}
          {entry.pinned && <span class="fx-pin" title="A named root on this disk">◆</span>}
          {entry.locked && <span class="fx-lock" title="Read-only — copy from it, never change it">read-only</span>}
          {entry.dir && <Chevron size={13} class="fx-arrow" />}
        </button>
      ))}
      {listing.entries.length === 0 && (
        <div class="fx-note">
          {node ? 'Empty' : 'Nothing mounted. Run deploy/setup-browse.sh on this board.'}
        </div>
      )}
      {/* The dead zone: clicking below the rows targets this column's folder,
          so an action lands on what is being looked at. */}
      {/* The dead zone is also the drop target for "into the folder I am
          looking at", which is most drops. */}
      <div
        class="fx-pad"
        onClick={onTarget}
        onDragOver={(ev) => ev.preventDefault()}
        onDrop={(ev) => onDrop(listing.path, ev as unknown as DragEvent)}
      />
    </div>
  );
};

const Grille = ({
  cell,
  node,
  selectedName,
  onSelect,
  onOpen,
  onPreview,
}: {
  cell: Cell;
  node: string | null;
  selectedName: string | null;
  onSelect: (entry: DirEntry) => void;
  onOpen: (entry: DirEntry) => void;
  onPreview: (entry: DirEntry) => void;
}) => {
  const listing = cell.listing;
  if (!listing) return <div class="fx-grid" />;

  return (
    <div class="fx-grid">
      {listing.entries.map((entry) => (
        <button
          class={`fx-tile ${entry.name === selectedName ? 'on' : ''} ${entry.hidden ? 'hidden' : ''}`}
          key={entry.name}
          onClick={() => onSelect(entry)}
          onDblClick={() => (entry.dir ? onOpen(entry) : onPreview(entry))}
        >
          <span class="fx-shot">
            {node && !entry.dir && IMAGE.test(entry.name) ? (
              // Lazy on purpose: the board only makes a thumbnail for a tile
              // that is actually scrolled into view.
              <img
                src={thumbUrl(node, `${listing.path.replace(/\/$/, '')}/${entry.name}`)}
                alt=""
                loading="lazy"
                onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')}
              />
            ) : (
              <Disk size={30} />
            )}
          </span>
          <span class="fx-tname">{entry.name}</span>
          <span class="fx-tsize">{bytes(entry.bytes)}</span>
        </button>
      ))}
      {listing.entries.length === 0 && <div class="fx-note">Empty</div>}
    </div>
  );
};
