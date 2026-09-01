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

The cache lives in systemd's `CacheDirectory` — `/var/cache/jug-thumbs`, the
one path the service may write under `ProtectSystem=strict`. It is bounded
three ways: 500MB with least-recently-used pruning, a refusal to write below
5GB free, and a key of path plus mtime plus size. Everything in it is derived,
so deleting the directory costs nothing but the next regeneration.

The scanner lives in the metrics agent on each board, restricted to the roots
in `BROWSE_ROOTS` in `agent/pi-metrics.service`. It is read-only, it never
follows a symlink out of a root, and the unit runs it as `nobody` under
`ProtectSystem=strict`. A directory that `nobody` cannot enter is skipped
rather than failing the scan — its size then reads low.

## Changing things

Read everywhere, write in a few places. `BROWSE_WRITABLE` in
`agent/pi-metrics.service` names them: the archive, and `/media` and `/mnt`,
which is where drives land.

The same list appears again as `ReadWritePaths`, which is the one that
matters. `ProtectSystem=strict` makes the whole filesystem read-only to the
agent; those lines punch through for those paths and nothing else. A bug in
the write endpoints cannot reach `/etc` or a home directory even if every
check in the code were wrong, because the kernel refuses the open first.

Nothing overwrites. A copy landing on a name that exists becomes `name copy`.
Credential files are never copied, for the same reason they are never served.

## Plugging a drive in

```bash
make automount
```

Once per board. After that a drive is mounted when you attach it — USB, SATA,
whatever the kernel recognises — under `/media`, and appears in the console as
its own disk, writable, with nothing to configure.

Label a disk if you want a readable name:

```bash
sudo e2label /dev/sdX1 photos
```

Unlabelled drives mount under their device name instead. The board's existing
disks are untouched: they stay in fstab and stay where they are.

## Samba

```bash
ssh <node> 'bash ~/PI/deploy/install-samba.sh'
```

Prompts once for an SMB password, which is separate from the board's login
password and is never stored in this repo. Then, in Finder, ⌘K:

```
smb://<node>/browse
```

One share, `browse`, holding every disk. No Time Machine target: backups here
are made by hand.

`smbd` listens on every address, and `hosts allow` decides who is served —
the Tailscale range and this machine, nothing else. Asking Samba to bind the
Tailscale address alone was tried twice and does not work: its interface
handling wants something it recognises as a network, and a host route on a tun
device is not that. The cost is that port 445 is visible on the home LAN, where
nothing can read a file. **Do not port forward 445.** SMB is the protocol
ransomware worms travel on, and there is no version of exposing it to the
internet that ends well.

The boards do not advertise themselves over mDNS or NetBIOS, so they will not
appear under Network in the Finder sidebar. That is deliberate — the advert
offered a door that `hosts allow` refuses — and it is why the names are written
down here.

## Mounting them on the Mac

```bash
make mounts
```

Once, on the Mac. It creates a mount point per board under `~/Shares`, stores
each board's SMB password in the login keychain, and installs a LaunchAgent
that runs `deploy/sync-share-mounts.sh` every 15 seconds. Nothing in it needs
`sudo`.

Each pass compares two things — what `tailscale status` can reach, and what is
in the mount table — and makes them match. Nothing is remembered between
passes, so there is no state to go stale and no order to get wrong.

### Why not /Volumes

Because macOS removes a mount point when the mount goes away, and it does that
whether or not something else put the directory there first. `/Volumes/jug2`
was created ahead of time with `sudo mkdir`, mounted, then force-unmounted, and
the directory went with the mount.

`/Volumes` is `root:wheel`, so a pass running as the user could never make it
again. A share dropped for being wedged would be dropped permanently, and the
log would say `does not exist — run the installer` on every pass from then on.

Under `~/Shares` the pass owns the directory and remakes it whenever it needs
one. That is also what removed the last privileged step from the whole
arrangement: nothing here runs as root now.

### A mount can be dead while the board is fine

A wifi drop long enough for the server to forget the session leaves the mount
in the mount table and the board perfectly reachable. macOS offers to Ignore
it, and Ignore means keep waiting:

```
$ mount | grep smbfs
//jug@jug2/browse on ... (smbfs, ...)     # listed
$ ls ~/Shares/jug2                        # hangs until killed
```

Tailnet up, board online, mount present — every reason the pass has to act says
there is nothing wrong. So each pass probes a mounted share and forces it off
if it does not answer, and the next pass remounts it.

The probe cannot be a simple command with a time limit. Everything that touches
a wedged path blocks, including `smbutil statshares`, which reads kernel state
rather than the server and still hung until the mount was forced away by hand.
macOS ships no `timeout`, and a process stuck in uninterruptible I/O on a dead
mount may not die on `SIGKILL` either.

So a child does the reading and touches a file if it gets an answer, and the
parent watches the clock and walks away when it runs out — without waiting for
the child, because waiting for it is the same hang by another route. The forced
unmount that follows is what actually releases it. The unmount runs in the
background too, one at a time per mount point, and the next pass reports what
really happened rather than this one waiting to find out.

None of this may block, and that is the reason for all of it: launchd will not
start a second copy of an agent that is still running, so a pass that hangs is
not a pass that was missed. It is the last one that ever runs, and it hangs
holding the mount it was supposed to clear.

Two reasons it is a timer and not a login item:

- macOS does not remount SMB across a reboot. The mount lives in memory, and
  nothing in the system puts it back.
- Tailscale is not up all the time, and an SMB mount whose server has gone is
  not inert. Finder blocks on it, and so does anything that walks the
  filesystem. Dropping the mount when the tailnet goes is the half that
  matters; putting it back when the tailnet returns is the easy half.

### Where the password lives

In the login keychain, one entry per board, handed to `mount_smbfs` on stdin at
mount time.

There are three ways to give `mount_smbfs` a password and only one of them is
any good. In the URL, as `//user:password@host`, it lands in argv, which `ps`
shows to every process on this Mac. In `~/Library/Preferences/nsmb.conf` — which
is what `man mount_smbfs` still tells you to do — it does not work at all:
macOS 15 no longer reads a password from that file, and `smbutil crypt`, which
used to scramble the value, has been removed. That was tried here first and it
silently did nothing.

The third way is stdin. `mount_smbfs` prompts for a password, and a prompt reads
whatever is on stdin, so a pipe answers it. The password goes from the keychain
into a pipe and no further: not into argv, not into a file. `-N` must not be
used alongside it, since that flag suppresses the prompt and the prompt is the
thing doing the reading.

The installer reads each entry back after storing it. Writing to the keychain
and reading from it are different permissions, and the read is the one that
matters — the pass runs from an agent, with nobody there to dismiss a dialog.
Better to find a keychain that will not answer while a person is watching.

### Which user

The board's login name, not the Mac's. `install-samba.sh` takes `valid users`
from whoever runs it on the board, so the share on `jug` admits `jug` and
refuses everyone else. The installer reads the name out of your ssh config
(`ssh -G <node>`) and bakes the mapping into the agent, so there is one place
that records how to reach a board rather than two.

```bash
tail -f ~/Library/Logs/jug.share-mounts.log
```

The log only records changes, so it is a list of mounts and unmounts rather
than a heartbeat. `Authentication error` in it means the stored password is not
the one the board has; set it again on the board and re-run `make mounts`:

```bash
ssh <node> 'sudo smbpasswd <user>'
```

To stop the whole thing:

```bash
launchctl bootout gui/$(id -u)/jug.share-mounts
```

## Why no Filebrowser

It was the plan until the layout above was settled on. Filebrowser is a good
file *manager* and has no concept of recursive directory size, so it cannot
answer the question this view exists to answer. Samba covers writing, in a
better interface than any web upload, and the console covers looking. Adding
it would mean a third way to see the same files and a second set of passwords.
