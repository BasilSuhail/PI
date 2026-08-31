#!/usr/bin/env python3
"""Pi-specific metrics Glances does not expose: power draw and throttle state,
plus a read-only directory scanner with recursive sizes.

Stdlib only. Serves JSON on :9101. Degrades to capabilities-only on hardware
without vcgencmd, so the same file can be dropped on any node.
"""

import json
import os
import re
import shutil
import stat
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = 9101
VCGENCMD = shutil.which("vcgencmd")

# The only paths this agent will describe. Everything else is refused, so a
# bug in the caller cannot turn this into a reader of /etc or a home directory.
BROWSE_ROOTS = tuple(
    os.path.realpath(p)
    for p in os.environ.get("BROWSE_ROOTS", "/srv/browse:/srv/archive").split(":")
    if p
)

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
    }


_scan_cache = {}
_scan_lock = threading.Lock()


def resolve_under_root(path):
    """The path a request may read, or None.

    realpath first: it collapses ../ and resolves every symlink, so the check
    is against where the path actually lands rather than how it was spelled.
    A link inside the tree pointing at /etc fails here like any other escape.
    """
    real = os.path.realpath(path or "")
    for root in BROWSE_ROOTS:
        if real == root or real.startswith(root + os.sep):
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


def roots():
    """The tops of the tree, for a client that has no path to start from."""
    out = []
    for root in BROWSE_ROOTS:
        if os.path.isdir(root):
            out.append({"path": root, "name": os.path.basename(root) or root})
    return {"roots": out}


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

    def log_message(self, *args):
        pass  # journald already timestamps; per-request lines are noise


if __name__ == "__main__":
    # Empty host binds all interfaces.
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
