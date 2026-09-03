#!/usr/bin/env python3
"""Pi-specific metrics Glances does not expose: power draw and throttle state,
plus a read-only directory scanner, file reads, and cached thumbnails.

Stdlib only. Serves JSON on :9101. Degrades to capabilities-only on hardware
without vcgencmd, so the same file can be dropped on any node.
"""

import hashlib
import json
import os
import plistlib
import re
import shutil
import stat
import struct
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = 9101
VCGENCMD = shutil.which("vcgencmd")

# Named tops of the tree, as `label=path` pairs. The whole filesystem is
# readable on purpose: a file manager that cannot show you your own Docker
# volumes or a config under /etc is not a file manager, it is a folder.
#
# Writing is the opposite — see WRITABLE below. Read everywhere, change almost
# nothing, which is how Finder treats /System.
def _parse_roots(raw):
    out = []
    for item in raw.split(","):
        item = item.strip()
        if not item or "=" not in item:
            continue
        label, path = item.split("=", 1)
        real = os.path.realpath(path)
        if os.path.isdir(real):
            out.append((label.strip(), real))
    return tuple(out)


BROWSE_ROOTS = _parse_roots(
    os.environ.get("BROWSE_ROOTS", "system=/,archives=/srv/archive")
)

# Only these may ever be modified, and only once write endpoints exist. Every
# other path is readable and permanently untouchable — deleting a board's /etc
# from a phone should not be one mis-tap away.
WRITABLE = tuple(
    os.path.realpath(p)
    for p in os.environ.get(
        "BROWSE_WRITABLE", "/srv/archive:/srv/browse:/media:/mnt"
    ).split(":")
    if p
)


def _under(real, root):
    """Whether a resolved path sits at or below a root.

    The separator is appended only when the root does not already end in one,
    or a root of "/" would build the prefix "//" and match nothing at all.
    """
    if real == root:
        return True
    return real.startswith(root if root.endswith(os.sep) else root + os.sep)


def is_writable(real):
    return any(_under(real, w) for w in WRITABLE)


# Files whose whole point is to hold a credential. They stay visible in a
# listing, because a tree that quietly omits things stops adding up and you
# would never know what you were not being shown — but their contents are
# never served. Seeing that a .env exists is useful; reading it over the
# tailnet is how a key ends up somewhere it cannot be recalled from.
SECRET_NAMES = (
    ".env", ".npmrc", ".netrc", ".pgpass", ".htpasswd",
    "credentials", "secrets", "id_rsa", "id_ed25519", "kubeconfig",
    "node-token", "k3s.yaml",
)
SECRET_SUFFIXES = (".key", ".pem", ".p12", ".pfx", ".keystore", ".jks", ".kdbx")


def is_secret(name):
    low = name.lower()
    if low.endswith(SECRET_SUFFIXES):
        return True
    return any(low == n or low.startswith(n + ".") for n in SECRET_NAMES)

# A recursive size means walking the whole subtree. On spinning storage that is
# minutes, so answers are kept and re-used until the directory itself changes.
SCAN_TTL_SEC = 600
# A single request should return something rather than hang. Past this the scan
# stops and says so, and what it has is still worth showing.
SCAN_DEADLINE_SEC = 20
# A directory with a hundred thousand entries would be a useless wall of rows
# and a large response. The biggest are the ones being looked for.
MAX_ENTRIES = 2000
# Cached listings, at up to MAX_ENTRIES each. Kept small on purpose: the unit
# file caps this process at 128M and a full cache has to fit inside that with
# room to spare.
MAX_CACHED_DIRS = 32

# ── Thumbnails ────────────────────────────────────────────────────────────
# systemd creates and owns this via CacheDirectory=, which is also what makes
# it writable under ProtectSystem=strict. Everything in it is derived: delete
# the directory at any time and the next viewer regenerates what they look at.
THUMB_DIR = os.environ.get("THUMB_DIR", "/var/cache/jug-thumbs")
THUMB_PX = 256
# Read once per file, ever, and only for a tile actually scrolled into view.
# There is no background pass over the disks on purpose — a nightly crawl is
# what rules out the photo managers that would otherwise do this job.
THUMB_CACHE_MAX = int(os.environ.get("THUMB_CACHE_MAX_MB", "500")) * 1024 * 1024
# Below this much free space the cache stops writing and serves what it has.
# It must never be the thing that fills the disk it exists to help you watch.
THUMB_FREE_FLOOR = 5 * 1024 * 1024 * 1024
# Refuse an upload that would leave the disk with less than this free. Filling
# the disk a service is running from takes the board out, not just the upload.
UPLOAD_HEADROOM = 2 * 1024 * 1024 * 1024

# Two at a time. The ingest keeps the other cores whatever the viewer does.
_thumb_slots = threading.Semaphore(2)
_thumb_lock = threading.Lock()

THUMBABLE = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff")

# vcgencmd get_throttled returns a bitmask. Low bits are live, high bits are
# sticky since boot — a board that browned out an hour ago still reports it.
THROTTLE_BITS = {
    0: ("under-voltage", "now"),
    1: ("arm frequency capped", "now"),
    2: ("currently throttled", "now"),
    3: ("soft temperature limit", "now"),
    16: ("under-voltage", "since boot"),
    17: ("arm frequency capped", "since boot"),
    18: ("throttled", "since boot"),
    19: ("soft temperature limit", "since boot"),
}

# Input rail, not a consumer. Counting it would double the total.
INPUT_RAIL = "EXT5V"


def vcgencmd(*args):
    if not VCGENCMD:
        return None
    try:
        out = subprocess.run(
            [VCGENCMD, *args], capture_output=True, text=True, timeout=3
        )
        return out.stdout.strip() if out.returncode == 0 else None
    except (subprocess.SubprocessError, OSError):
        return None


def read_power():
    """Sum volts x amps across PMIC rails. Pi 5 only; earlier boards have no PMIC."""
    raw = vcgencmd("pmic_read_adc")
    if not raw:
        return None

    volts, amps = {}, {}
    for line in raw.splitlines():
        m = re.match(r"\s*(\w+?)_([AV])\s+(?:current|volt)\(\d+\)=([\d.]+)[AV]", line)
        if not m:
            continue
        rail, kind, value = m.group(1), m.group(2), float(m.group(3))
        (amps if kind == "A" else volts)[rail] = value

    rails, total = [], 0.0
    for rail in sorted(volts.keys() & amps.keys()):
        if rail == INPUT_RAIL:
            continue
        watts = volts[rail] * amps[rail]
        total += watts
        rails.append(
            {
                "name": rail,
                "volts": round(volts[rail], 4),
                "amps": round(amps[rail], 4),
                "watts": round(watts, 3),
            }
        )

    if not rails:
        return None
    return {"watts": round(total, 2), "rails": rails}


def read_throttled():
    raw = vcgencmd("get_throttled")
    if not raw or "=" not in raw:
        return None

    try:
        value = int(raw.split("=")[1], 16)
    except ValueError:
        return None

    now, ever = [], []
    for bit, (label, when) in THROTTLE_BITS.items():
        if value & (1 << bit):
            (now if when == "now" else ever).append(label)

    return {
        "raw": hex(value),
        "now": bool(now),
        "everSinceBoot": bool(ever),
        "reasons": now,
        "reasonsSinceBoot": ever,
    }


def read_temp():
    """Prefer the sysfs thermal zone — present on any Linux box, not just Pi."""
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            return round(int(f.read().strip()) / 1000.0, 1)
    except (OSError, ValueError):
        pass

    raw = vcgencmd("measure_temp")
    if raw and "=" in raw:
        try:
            return float(raw.split("=")[1].rstrip("'C"))
        except ValueError:
            pass
    return None


def read_model():
    try:
        with open("/proc/device-tree/model") as f:
            return f.read().strip("\x00").strip()
    except OSError:
        return None


def read_disks():
    """One row per physical block device.

    Glances reports mount points, and a mount point cannot say whether the
    thing under it spins. That fact lives in sysfs, so it is reported here:
    the console names a disk "HDD 6TB" or "SSD 1TB" by what it is, and the
    Finder tree is built to the same names by setup-browse.sh reading the
    same files. Loops, ram and zram are not disks and stay out.
    """
    disks = []
    try:
        names = sorted(os.listdir("/sys/block"))
    except OSError:
        return disks
    for name in names:
        if name.startswith(("loop", "ram", "zram")):
            continue
        base = "/sys/block/" + name
        try:
            with open(base + "/size") as f:
                sectors = int(f.read().strip())
            with open(base + "/queue/rotational") as f:
                rotational = f.read().strip() == "1"
        except (OSError, ValueError):
            continue
        # USB-SATA bridges do not pass through the rotational flag; the
        # kernel defaults to 1 (spinning) for every USB disk, which makes
        # a Pi's boot SSD read "HDD". If the sysfs device path walks
        # through a USB controller, override: nobody puts a spinning disk
        # behind USB on these boards.
        if rotational:
            try:
                real = os.path.realpath(base + "/device")
                if "usb" in real.lower():
                    rotational = False
            except OSError:
                pass
        model = None
        for model_path in (base + "/device/model", base + "/device/name"):
            try:
                with open(model_path) as f:
                    text = f.read().strip("\x00").strip()
                if text:
                    model = text
                    break
            except OSError:
                continue
        disks.append(
            {
                "device": name,
                "sizeBytes": sectors * 512,
                "rotational": rotational,
                "model": model,
            }
        )
    return disks


def collect():
    power = read_power()
    throttled = read_throttled()
    temp = read_temp()

    capabilities = []
    if power:
        capabilities.append("power")
    if throttled:
        capabilities.append("throttle")

    return {
        "ts": int(time.time()),
        "model": read_model(),
        "tempC": temp,
        "power": power,
        "throttled": throttled,
        "capabilities": capabilities,
        "disks": read_disks(),
    }


_scan_cache = {}
_scan_lock = threading.Lock()


def resolve_under_root(path):
    """The path a request may read, or None.

    realpath first: it collapses ../ and resolves every symlink, so the check
    is against where the path actually lands rather than how it was spelled.
    """
    real = os.path.realpath(path or "")
    for _, root in BROWSE_ROOTS:
        if _under(real, root):
            return real
    return None


def subtree_bytes(path, dev, deadline):
    """Apparent bytes under a directory, the number a file manager shows.

    Stays on one device, the way `du -x` does — without that, the bind mounts
    under /srv/browse would each count every other disk mounted beneath them.
    Symlinks are measured as links, never followed, so a loop cannot hang this
    and a link to a huge tree cannot inflate its parent.
    """
    total = 0
    stack = [path]
    while stack:
        if time.monotonic() > deadline:
            return total, False
        try:
            with os.scandir(stack.pop()) as it:
                for entry in it:
                    try:
                        st = entry.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    if st.st_dev != dev:
                        continue
                    if stat.S_ISDIR(st.st_mode):
                        stack.append(entry.path)
                    else:
                        total += st.st_size
        except OSError:
            continue  # unreadable subdirectory: skip it, keep the rest
    return total, True


# ── Finder tags ────────────────────────────────────────────────────────────
#
# macOS keeps a file's tags in an extended attribute, and Samba writes it
# through to ext4, so the tags set in Finder are on the board and can be read
# back. One place stores a tag and both ends show it; a tag store of our own
# would be a second answer to the same question, free to disagree.
#
# The attribute name has to be spelled exactly, and it is not what it looks
# like. macOS calls it `com.apple.metadata:_kMDItemUserTags`, but the colon is
# illegal in a Windows stream name, so the catia module in smb.conf maps it to
# U+F022 in the private use area. A literal colon here would create an
# attribute nothing ever reads, and would fail silently, which is the worst way
# for this to be wrong.
TAG_XATTR = "user.DosStream.com.apple.metadata\uf022_kMDItemUserTags:$DATA"

# The value is a binary plist holding an array of "Name\nIndex" strings, e.g.
# "Red\n6". The index is what Finder draws the dot from — on anything since
# 10.9 the old FinderInfo colour byte is not needed as well.
TAG_COLOURS = {
    "Grey": 1, "Green": 2, "Purple": 3, "Blue": 4,
    "Yellow": 5, "Red": 6, "Orange": 7,
}


def finder_tags(path):
    """The tag names on one file, or an empty list.

    Never raises. A missing attribute is the normal case, an unreadable one is
    not worth failing a whole directory listing over, and a value written by
    something other than Finder is not worth trusting into a crash.
    """
    try:
        raw = os.getxattr(path, TAG_XATTR, follow_symlinks=False)
    except OSError:
        return []
    try:
        loaded = plistlib.loads(raw)
    except Exception:
        return []
    if not isinstance(loaded, list):
        return []
    # Finder stores "Name\nIndex"; the name is the half worth showing.
    return [str(t).split("\n")[0] for t in loaded if str(t).split("\n")[0]]


def set_finder_tags(path, names):
    """Replace the tags on one file. An empty list removes the attribute."""
    if not names:
        try:
            os.removexattr(path, TAG_XATTR, follow_symlinks=False)
        except OSError:
            pass
        return []
    encoded = []
    for name in names:
        index = TAG_COLOURS.get(name)
        if index is None:
            raise Refused(400, f"not a Finder tag colour: {name}")
        encoded.append(f"{name}\n{index}")
    os.setxattr(
        path,
        TAG_XATTR,
        plistlib.dumps(encoded, fmt=plistlib.FMT_BINARY),
        follow_symlinks=False,
    )
    return names


def scan(path):
    """One directory, every entry, biggest first.

    Hidden entries are included deliberately. A dotfile is exactly the thing
    that quietly eats a disk — .cache and .ollama are not noise here, they are
    usually the answer — and hiding them would make the sizes add up wrong.
    """
    try:
        dir_st = os.stat(path)
    except OSError as err:
        return {"error": err.strerror or "cannot read", "path": path}

    key = (path, dir_st.st_mtime_ns)
    with _scan_lock:
        hit = _scan_cache.get(key)
        if hit and time.time() - hit["ts"] < SCAN_TTL_SEC:
            return hit["result"]

    deadline = time.monotonic() + SCAN_DEADLINE_SEC
    entries, complete = [], True
    try:
        with os.scandir(path) as it:
            listing = list(it)
    except OSError as err:
        return {"error": err.strerror or "cannot read", "path": path}

    for entry in listing:
        try:
            st = entry.stat(follow_symlinks=False)
        except OSError:
            continue
        is_link = stat.S_ISLNK(st.st_mode)
        is_dir = entry.is_dir(follow_symlinks=False)
        if is_dir:
            size, done = subtree_bytes(entry.path, st.st_dev, deadline)
            complete = complete and done
        else:
            size = st.st_size
        entries.append(
            {
                "name": entry.name,
                "dir": is_dir,
                "link": is_link,
                "bytes": size,
                "mtime": int(st.st_mtime),
                # Sent rather than inferred: the client should not have to know
                # that a leading dot is what makes something hidden on Unix.
                "hidden": entry.name.startswith("."),
                # Listed, sized, never opened. See SECRET_NAMES.
                "secret": is_secret(entry.name),
                # The same tags Finder shows, read from the same attribute.
                "tags": finder_tags(entry.path),
            }
        )

    entries.sort(key=lambda e: (-e["bytes"], e["name"].lower()))
    result = {
        "path": path,
        "parent": os.path.dirname(path) if resolve_under_root(os.path.dirname(path)) else None,
        "total": sum(e["bytes"] for e in entries),
        "count": len(entries),
        "truncated": max(0, len(entries) - MAX_ENTRIES),
        "complete": complete,
        "writable": is_writable(path),
        "entries": entries[:MAX_ENTRIES],
    }

    with _scan_lock:
        # Keyed on the directory's mtime, so a stale entry is only ever a
        # directory nothing has changed. Bounded so a long browse cannot grow
        # the agent's memory without limit.
        if len(_scan_cache) > MAX_CACHED_DIRS:
            _scan_cache.clear()
        _scan_cache[key] = {"ts": time.time(), "result": result}
    return result


def open_file(path):
    """A readable file under a root, and its size — or None.

    Directories are refused: downloading one means building an archive, which
    is a different job with a different cost.
    """
    real = resolve_under_root(path)
    if not real or not os.path.isfile(real):
        return None
    if is_secret(os.path.basename(real)):
        return None
    try:
        return real, os.path.getsize(real)
    except OSError:
        return None


def exif_thumbnail(path):
    """The thumbnail a JPEG already carries, if it carries one.

    Free when present: a byte-range copy out of the Exif block, no decoding
    and no library. Rare in practice — downloads and export pipelines strip
    it — so this is an optimisation, not the strategy.
    """
    try:
        with open(path, "rb") as f:
            if f.read(2) != b"\xff\xd8":
                return None
            while f.tell() < 4 * 1024 * 1024:
                head = f.read(2)
                if len(head) < 2 or head[0] != 0xFF:
                    return None
                marker = head[1]
                if marker == 0xDA:          # start of scan: no Exif after this
                    return None
                if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                    continue
                size = struct.unpack(">H", f.read(2))[0]
                body = f.read(size - 2)
                if marker == 0xE1 and body[:6] == b"Exif\x00\x00":
                    return _thumb_from_tiff(body[6:])
    except (OSError, struct.error):
        pass
    return None


def _thumb_from_tiff(tiff):
    """IFD1 of an Exif block is the thumbnail's directory. Tags 0x0201 and
    0x0202 are its offset and length."""
    if len(tiff) < 8:
        return None
    endian = "<" if tiff[:2] == b"II" else ">" if tiff[:2] == b"MM" else None
    if not endian:
        return None
    try:
        ifd0 = struct.unpack(endian + "I", tiff[4:8])[0]
        count = struct.unpack(endian + "H", tiff[ifd0:ifd0 + 2])[0]
        ifd1 = struct.unpack(endian + "I", tiff[ifd0 + 2 + count * 12:][:4])[0]
        if not ifd1:
            return None
        n = struct.unpack(endian + "H", tiff[ifd1:ifd1 + 2])[0]
        offset = length = None
        for i in range(n):
            e = ifd1 + 2 + i * 12
            tag = struct.unpack(endian + "H", tiff[e:e + 2])[0]
            val = struct.unpack(endian + "I", tiff[e + 8:e + 12])[0]
            if tag == 0x0201:
                offset = val
            elif tag == 0x0202:
                length = val
        if offset is None or not length:
            return None
        blob = tiff[offset:offset + length]
        return blob if blob[:2] == b"\xff\xd8" else None
    except (struct.error, IndexError):
        return None


def thumb_path(real, st):
    """Cache filename. Keyed on the file's identity and its mtime and size, so
    editing a file invalidates its thumbnail and nothing else does."""
    key = f"{real}\0{st.st_mtime_ns}\0{st.st_size}".encode()
    return os.path.join(THUMB_DIR, hashlib.sha256(key).hexdigest()[:32] + ".webp")


def prune_thumbs():
    """Keep the cache under its cap, oldest-used first. Cheap: a stat per file
    and a sort, run only after a write."""
    try:
        files = []
        total = 0
        with os.scandir(THUMB_DIR) as it:
            for e in it:
                try:
                    st = e.stat()
                except OSError:
                    continue
                files.append((st.st_atime, st.st_size, e.path))
                total += st.st_size
        if total <= THUMB_CACHE_MAX:
            return
        files.sort()
        for _, size, path in files:
            try:
                os.unlink(path)
            except OSError:
                continue
            total -= size
            if total <= THUMB_CACHE_MAX * 0.9:
                return
    except OSError:
        pass


def make_thumb(real, out):
    """Shell out to vipsthumbnail rather than importing an imaging library.

    The child does the work and its memory dies with it, so this process never
    grows. vips also decodes JPEG at reduced scale rather than building the
    full bitmap first, which is most of why it is fast enough to do on demand.
    """
    # vips picks its output format from the extension, so the temporary name
    # has to keep .webp last. Writing beside the target and renaming means a
    # reader never sees a half-written file.
    tmp = out[:-len(".webp")] + ".part.webp"
    try:
        r = subprocess.run(
            ["vipsthumbnail", real, "--size", f"{THUMB_PX}x{THUMB_PX}",
             "-o", tmp + "[Q=72,strip]"],
            capture_output=True, timeout=20,
        )
        if r.returncode == 0 and os.path.exists(tmp):
            os.replace(tmp, out)
            return True
    except (subprocess.SubprocessError, OSError):
        pass
    try:
        os.unlink(tmp)
    except OSError:
        pass
    return False


def thumbnail(path):
    """Bytes of a thumbnail for one file, or None. Cached, and never generated
    for anything not asked for."""
    real = resolve_under_root(path)
    if not real or not os.path.isfile(real):
        return None
    if not real.lower().endswith(THUMBABLE):
        return None
    try:
        st = os.stat(real)
    except OSError:
        return None

    out = thumb_path(real, st)
    try:
        with open(out, "rb") as f:
            os.utime(out, None)          # touch, so the pruner sees it as used
            return f.read(), "image/webp"
    except OSError:
        pass

    embedded = exif_thumbnail(real)
    if embedded:
        return embedded, "image/jpeg"

    with _thumb_slots:
        try:
            os.makedirs(THUMB_DIR, exist_ok=True)
            if shutil.disk_usage(THUMB_DIR).free < THUMB_FREE_FLOOR:
                return None              # disk is tight: serve nothing, write nothing
        except OSError:
            return None
        if not make_thumb(real, out):
            return None
    with _thumb_lock:
        prune_thumbs()
    try:
        with open(out, "rb") as f:
            return f.read(), "image/webp"
    except OSError:
        return None


def cache_stats():
    total = count = 0
    try:
        with os.scandir(THUMB_DIR) as it:
            for e in it:
                try:
                    total += e.stat().st_size
                    count += 1
                except OSError:
                    continue
    except OSError:
        pass
    return {"bytes": total, "count": count, "capBytes": THUMB_CACHE_MAX,
            "tool": bool(shutil.which("vipsthumbnail"))}


# ── Writing ───────────────────────────────────────────────────────────────
# Every one of these resolves the path the same way a read does, then asks
# is_writable() as well. A caller that reaches this with /etc gets 403 from
# the agent, not from a greyed-out button — and systemd's ReadWritePaths would
# refuse it underneath that in any case.


class Refused(Exception):
    """A request that resolved fine and is still not allowed."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def writable_target(path, must_exist=True):
    real = resolve_under_root(path)
    if not real:
        raise Refused(403, "path is outside the browsable roots")
    if not is_writable(real):
        raise Refused(403, "this location is read-only")
    if must_exist and not os.path.exists(real):
        raise Refused(404, "no such path")
    return real


def safe_child(parent_real, name):
    """A new entry inside a directory, from a name the caller chose.

    The name is a name, never a path: a slash or a .. in it would place the
    result somewhere other than the directory being written to, which is the
    one thing this must not allow.
    """
    if not name or name in (".", "..") or "/" in name or "\\" in name:
        raise Refused(400, "that is not a usable name")
    child = os.path.join(parent_real, name)
    if os.path.dirname(os.path.realpath(child)) != os.path.realpath(parent_real):
        raise Refused(400, "that name would land outside the folder")
    return child


def unique_name(target):
    """A destination that does not already exist. Nothing here overwrites: a
    copy landing on a file of the same name becomes "name copy", the way
    Finder does it, rather than silently replacing something."""
    if not os.path.exists(target):
        return target
    stem, ext = os.path.splitext(target)
    for n in range(1, 200):
        suffix = " copy" if n == 1 else f" copy {n}"
        candidate = f"{stem}{suffix}{ext}"
        if not os.path.exists(candidate):
            return candidate
    raise Refused(409, "too many copies of that name already")


def do_write(op, body):
    if op == "mkdir":
        parent = writable_target(body.get("path", ""))
        child = safe_child(parent, body.get("name", ""))
        if os.path.exists(child):
            raise Refused(409, "something with that name is already here")
        os.mkdir(child, 0o755)
        return {"path": child}

    if op == "rename":
        real = writable_target(body.get("path", ""))
        child = safe_child(os.path.dirname(real), body.get("name", ""))
        if os.path.exists(child):
            raise Refused(409, "something with that name is already here")
        os.rename(real, child)
        return {"path": child}

    if op == "delete":
        real = writable_target(body.get("path", ""))
        if any(real == root for _, root in BROWSE_ROOTS) or is_mount(real):
            raise Refused(403, "that is a root of the tree, not a file in it")
        if os.path.isdir(real) and not os.path.islink(real):
            shutil.rmtree(real)
        else:
            os.unlink(real)
        return {"deleted": real}

    if op in ("copy", "move"):
        source = resolve_under_root(body.get("path", ""))
        if not source or not os.path.exists(source):
            raise Refused(404, "no such file")
        # Copying reads, so a file this agent will not serve is a file it will
        # not duplicate somewhere it might be served from.
        if is_secret(os.path.basename(source)):
            raise Refused(403, "credential files are not copied")
        if op == "move" and not is_writable(source):
            raise Refused(403, "the source is read-only, so it cannot be moved")
        into = writable_target(body.get("to", ""))
        if not os.path.isdir(into):
            raise Refused(400, "the destination is not a folder")
        if _under(into, source):
            raise Refused(400, "a folder cannot be moved inside itself")
        target = unique_name(os.path.join(into, os.path.basename(source)))
        if op == "move":
            shutil.move(source, target)
        elif os.path.isdir(source):
            shutil.copytree(source, target, symlinks=True)
        else:
            shutil.copy2(source, target)
        return {"path": target}

    if op == "tags":
        # Tagging changes metadata, not content, but it is still a write, so it
        # goes through the same gate as the rest: only under a writable root.
        real = writable_target(body.get("path", ""))
        names = body.get("tags", [])
        if not isinstance(names, list):
            raise Refused(400, "tags must be a list")
        return {"path": real, "tags": set_finder_tags(real, [str(n) for n in names])}

    raise Refused(400, f"unknown operation: {op}")


def is_mount(real):
    try:
        return os.path.ismount(real)
    except OSError:
        return False


def roots():
    """The tops of the tree, for a client with no path to start from."""
    return {
        "roots": [
            {"path": path, "name": label, "writable": is_writable(path)}
            for label, path in BROWSE_ROOTS
            if os.path.isdir(path)
        ]
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        url = urlparse(self.path)
        route = url.path.rstrip("/")

        if route == "/files":
            asked = parse_qs(url.query).get("path", [""])[0]
            if not asked:
                body = json.dumps(roots()).encode()
            else:
                real = resolve_under_root(asked)
                if not real:
                    self.send_error(403, "path is outside the browsable roots")
                    return
                if not os.path.isdir(real):
                    self.send_error(404, "not a directory")
                    return
                body = json.dumps(scan(real)).encode()
            self._send(body)
            return

        if route == "/download":
            found = open_file(parse_qs(url.query).get("path", [""])[0])
            if not found:
                self.send_error(404, "no such file under the browsable roots")
                return
            real, size = found
            self.send_response(200)
            # Bytes, not a guess at the type: the dashboard proxies this to a
            # browser, and a wrong Content-Type is how a file gets rendered
            # instead of saved.
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            with open(real, "rb") as f:
                shutil.copyfileobj(f, self.wfile, 64 * 1024)
            return

        if route == "/thumb":
            made = thumbnail(parse_qs(url.query).get("path", [""])[0])
            if not made:
                self.send_error(404, "no thumbnail for this file")
                return
            body, kind = made
            self.send_response(200)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            # Keyed on mtime upstream, so a hit is safe to keep. The browser
            # asking twice for the same unchanged file should cost nothing.
            self.send_header("Cache-Control", "private, max-age=86400")
            self.end_headers()
            self.wfile.write(body)
            return

        if route == "/cache":
            self._send(json.dumps(cache_stats()).encode())
            return

        if route not in ("", "/metrics", "/health"):
            self.send_error(404)
            return

        if route == "/health":
            body = json.dumps({"ok": True}).encode()
        else:
            body = json.dumps(collect()).encode()

        self._send(body)

    def _send(self, body):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        url = urlparse(self.path)
        route = url.path.rstrip("/")
        try:
            if route == "/write":
                length = int(self.headers.get("Content-Length") or 0)
                if length > 64 * 1024:
                    raise Refused(413, "that request is too large to be a write")
                body = json.loads(self.rfile.read(length) or b"{}")
                result = do_write(str(body.get("op", "")), body)
                self._send(json.dumps(result).encode())
                return

            if route == "/upload":
                q = parse_qs(url.query)
                into = writable_target(q.get("path", [""])[0])
                if not os.path.isdir(into):
                    raise Refused(400, "the destination is not a folder")
                target = unique_name(safe_child(into, q.get("name", [""])[0]))
                length = int(self.headers.get("Content-Length") or 0)
                free = shutil.disk_usage(into).free
                if length + UPLOAD_HEADROOM > free:
                    raise Refused(507, "not enough room on that disk")
                # Written beside the target and renamed, so a connection that
                # drops halfway leaves a .part behind rather than a file that
                # looks complete and is not.
                part = target + ".part"
                remaining = length
                with open(part, "wb") as f:
                    while remaining > 0:
                        chunk = self.rfile.read(min(1024 * 1024, remaining))
                        if not chunk:
                            break
                        f.write(chunk)
                        remaining -= len(chunk)
                if remaining:
                    os.unlink(part)
                    raise Refused(400, "the upload ended early")
                os.replace(part, target)
                self._send(json.dumps({"path": target}).encode())
                return

            self.send_error(404)
        except Refused as err:
            self.send_error(err.status, err.message)
        except json.JSONDecodeError:
            self.send_error(400, "that request body is not JSON")
        except OSError as err:
            self.send_error(500, err.strerror or "the filesystem refused that")

    def log_message(self, *args):
        pass  # journald already timestamps; per-request lines are noise


if __name__ == "__main__":
    # Empty host binds all interfaces.
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
