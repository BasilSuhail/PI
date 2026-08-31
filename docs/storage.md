# Storage

Two ways into the same files. Both point at `/srv/browse`, and neither owns
anything: underneath are plain directories on plain filesystems, so either can
be removed without losing a byte.

| | Storage view | Samba |
|---|---|---|
| Where | the console, any browser | Finder on the Mac |
| What it is for | finding what is eating a disk | moving files, backups |
| Writes | no, read-only by design | yes |
| Hidden files | shown | shown |

## The browse root

One directory per disk, built by bind mount:

```
/srv/browse/
├── archive     the curated tree, /srv/archive
├── ssd-1tb
├── ssd-512
└── sdcard
```

Bind mounts rather than symlinks. Samba only follows a symlink out of a share
with `wide links = yes`, which switches off a protection worth keeping; a bind
mount gives the same view without that.

Build or rebuild it with:

```bash
ssh <node> 'bash ~/PI/deploy/setup-browse.sh'
```

It reads what is mounted, skips the operating system's own filesystems, binds
the rest, and writes an fstab line per disk so the tree survives a reboot. It
is idempotent, and it prunes entries for disks that have gone.

**Adding a disk later** is two steps: mount it anywhere (`/mnt/whatever`, by
UUID, with `nofail`), then re-run the script. It appears in the console and in
Finder with no further configuration.

## The Storage view

`Storage` in the console toolbar. Columns, biggest first, in the shape
OmniDiskSweeper uses — because the question asked of a homelab disk is nearly
always "what is eating it", not "where is that one file".

The first column is the fleet, the second is that board's disks, and the rest
are directories. Moving between boards is the same gesture as opening a
folder, and each board's total reads before anything is clicked. Clicking an
open folder again collapses it; clicking the empty space under a column
targets that column's own folder.

`Grid` swaps the columns for thumbnails — list stays the default. Space opens
Quick Look on an image, arrow keys step through the folder.

Sizes on directories are the whole subtree. That means a walk, so the first
visit to a large tree takes time; the answer is then cached until that
directory changes. If a scan passes twenty seconds it returns what it has and
says the numbers are floors.

Dotfiles are shown, dimmed but never dropped. On these boards `.cache` and
`.ollama` are usually the answer, and hiding them would also make a column
stop adding up to its parent.

## Thumbnails

Grid view asks the agent for a 256px WebP per image, and only for tiles
actually scrolled into view. There is no background pass over the disks: a
nightly crawl is what rules out the photo managers that would otherwise do
this job.

The board needs libvips for this:

```bash
sudo apt-get install -y libvips-tools
```

Without it, only images carrying an Exif thumbnail preview — which is few.
Across a sample of 144 photos here, 5 had one; downloads and export pipelines
strip them. `/api/nodes/<id>/cache` reports whether the tool is present.

The agent shells out to `vipsthumbnail` rather than importing an imaging
library, so its own memory never grows: measured over a cold batch of eight
photos, resident memory moved 26320K to 26352K. Generation was 52-113ms per
image on a laptop; expect a few hundred on a board, once per file ever.

The cache lives in systemd's `CacheDirectory` — `/var/cache/pi-thumbs`, the
one path the service may write under `ProtectSystem=strict`. It is bounded
three ways: 500MB with least-recently-used pruning, a refusal to write below
5GB free, and a key of path plus mtime plus size. Everything in it is derived,
so deleting the directory costs nothing but the next regeneration.

The scanner lives in the metrics agent on each board, restricted to the roots
in `BROWSE_ROOTS` in `agent/pi-metrics.service`. It is read-only, it never
follows a symlink out of a root, and the unit runs it as `nobody` under
`ProtectSystem=strict`. A directory that `nobody` cannot enter is skipped
rather than failing the scan — its size then reads low.

## Samba

```bash
ssh <node> 'bash ~/PI/deploy/install-samba.sh'
```

Prompts once for an SMB password, which is separate from the board's login
password and is never stored in this repo. Then, in Finder, ⌘K:

```
smb://<node>.<tailnet>.ts.net/browse
```

Two shares: `browse` for the disks, `timemachine` for laptop backups.

Bound to `lo` and `tailscale0` only, with `hosts allow` limited to the
Tailscale range. Nothing listens on the LAN. **Do not port forward 445.** SMB
is the protocol ransomware worms travel on, and there is no version of exposing
it to the internet that ends well.

The first Time Machine backup runs for hours. Do it on ethernet.

## Why no Filebrowser

It was the plan until the layout above was settled on. Filebrowser is a good
file *manager* and has no concept of recursive directory size, so it cannot
answer the question this view exists to answer. Samba covers writing, in a
better interface than any web upload, and the console covers looking. Adding
it would mean a third way to see the same files and a second set of passwords.
