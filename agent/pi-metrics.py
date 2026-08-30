#!/usr/bin/env python3
"""Pi-specific metrics Glances does not expose: power draw and throttle state.

Stdlib only. Serves JSON on :9101. Degrades to capabilities-only on hardware
without vcgencmd, so the same file can be dropped on any node.
"""

import json
import re
import shutil
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 9101
VCGENCMD = shutil.which("vcgencmd")

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


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.rstrip("/") not in ("", "/metrics", "/health"):
            self.send_error(404)
            return

        if self.path.rstrip("/") == "/health":
            body = json.dumps({"ok": True}).encode()
        else:
            body = json.dumps(collect()).encode()

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
