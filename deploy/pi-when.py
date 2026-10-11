#!/usr/bin/env python3
"""What was happening on the PC at one moment, for "it stuttered at 1h10" or
"my upload stopped at 23 GB at 12:15".

Two halves. Every minute `pi-when record` writes one line of readings to
/var/lib/pi-when/<day>.jsonl on the OS drive, kept for 14 days: CPU, memory,
the GPU and its video engines, how busy each drive was, Wi-Fi speed and
signal, pings to the router and the internet, temperatures, fans, and every
app's restart count. The lookup puts everything around a moment on one page:

  sudo pi-when 12:15 nextcloud
  sudo pi-when "yesterday 21:40" jellyfin --who <name>
  sudo pi-when "sat 12:15" --minutes 20

  who was using the app, how (direct or relay) and how fast   (pi-paths)
  what stands out: busy drives, Wi-Fi or internet drops, restarts, memory kills
  the PC minute by minute
  the app's own log: Jellyfin's playback and transcode lines (with the film
  position, and whether transcoding kept up), Nextcloud's errors and upload
  requests minute by minute, or any other app's error lines
  kernel warnings and Wi-Fi messages

Any time `date -d` understands works; a bare HH:MM later than now means
yesterday. Jellyfin keeps its own log for 3 days and an app's console log
lasts until its second restart, so ask within a few days. Stdlib only;
changes nothing.
"""

import argparse
import datetime
import glob
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import time

DIR = os.environ.get("WHEN_DIR", "/var/lib/pi-when")
STATE = os.environ.get("WHEN_STATE", "/run/pi-when.json")
KEEP_DAYS = 14
KUBECTL = ["k3s", "kubectl"]
NS = "pi"
DAY = 24 * 3600
MOUNTS = {"/": "os", "/srv/ssd": "ssd", "/srv/storage": "hdd1", "/srv/hdd2": "hdd2"}
INTERNET = "1.1.1.1"
FANS_STATE = "/run/pi-fans.json"
# The same words the morning report treats as an error.
POD_ERROR = re.compile(r"\b(ERR|ERROR|FATAL|CRIT|CRITICAL|PANIC|panic|Exception|Traceback)\b")
DISK_TROUBLE = re.compile(r"I/O error|EXT4-fs error|Buffer I/O|critical medium error|failed command: (READ|WRITE)|"
                          r"Remounting filesystem read-only|blk_update_request", re.I)
WIFI = re.compile(r"disconnect|deauth|associat|state change|beacon|roam|CTRL-EVENT", re.I)
OOM = re.compile(r"Out of memory|oom-kill|Killed process", re.I)
LINES = 60


def sh(args, timeout=30):
    try:
        out = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return out.stdout if out.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


# ---------------------------------------------------------------- recording

def drive_names():
    """{'sda': 'hdd1', ...}: each whole disk named after what it holds."""
    names = {}
    for line in (read("/proc/mounts") or "").splitlines():
        dev, mnt = line.split()[:2]
        if mnt not in MOUNTS or not dev.startswith("/dev/"):
            continue
        part = os.path.basename(os.path.realpath(dev))
        parent = os.path.basename(os.path.dirname(os.path.realpath("/sys/class/block/" + part)))
        names[part if parent == "block" else parent] = MOUNTS[mnt]
    return names


def cpu_ticks():
    v = [int(x) for x in (read("/proc/stat") or "cpu 0").splitlines()[0].split()[1:]]
    return sum(v[:8]), (v[3] + v[4]) if len(v) > 4 else 0


def disk_counters(names):
    out = {}
    for line in (read("/proc/diskstats") or "").splitlines():
        f = line.split()
        if len(f) > 12 and f[2] in names:
            out[names[f[2]]] = [int(f[5]), int(f[9]), int(f[12])]  # sectors read, written, ms busy
    return out


def route():
    """(interface, gateway) of the default route."""
    for line in (read("/proc/net/route") or "").splitlines()[1:]:
        f = line.split()
        if len(f) > 2 and f[1] == "00000000":
            return f[0], socket.inet_ntoa(struct.pack("<L", int(f[2], 16)))
    return None, None


def net_counters(iface):
    for line in (read("/proc/net/dev") or "").splitlines():
        if line.strip().startswith(iface + ":"):
            f = line.split(":", 1)[1].split()
            return [int(f[0]), int(f[8])]
    return None


def wifi_signal(iface):
    for line in (read("/proc/net/wireless") or "").splitlines()[2:]:
        f = line.split()
        if f and f[0].rstrip(":") == iface:
            return float(f[3].rstrip("."))
    return None


def pings(targets):
    """{name: [replies out of 3, average ms]} for each target, pinged together."""
    procs = {k: subprocess.Popen(["ping", "-n", "-q", "-c", "3", "-i", "0.2", "-W", "1", t],
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
             for k, t in targets.items() if t}
    out = {}
    for k, p in procs.items():
        try:
            text = p.communicate(timeout=5)[0]
        except subprocess.TimeoutExpired:
            p.kill()
            text = ""
        got = re.search(r"(\d+) received", text)
        avg = re.search(r"= [\d.]+/([\d.]+)/", text)
        out[k] = [int(got.group(1)) if got else 0, round(float(avg.group(1)), 1) if avg else None]
    return out


def hwmon_temps(names):
    temps = {}
    for h in glob.glob("/sys/class/hwmon/hwmon*"):
        kind = read(h + "/name")
        raw = read(h + "/temp1_input")
        if raw is None:
            continue
        if kind in ("k10temp", "coretemp"):
            temps["cpu"] = round(int(raw) / 1000)
        elif kind == "drivetemp":
            blocks = glob.glob(h + "/device/block/*")
            block = os.path.basename(blocks[0]) if blocks else None
            if block in names:
                temps[names[block]] = round(int(raw) / 1000)
    return temps


def gpu():
    smi = shutil.which("nvidia-smi")
    if not smi:
        return None

    def query(fields):
        out = sh([smi, "--query-gpu=" + fields, "--format=csv,noheader,nounits"], 10).splitlines()
        return [int(float(x)) if re.fullmatch(r"\s*[\d.]+\s*", x) else None for x in out[0].split(",")] if out else []

    core = query("utilization.gpu,temperature.gpu")
    if len(core) < 2:
        return None
    codec = query("utilization.encoder,utilization.decoder") + [None, None]
    return {"use": core[0], "c": core[1], "enc": codec[0], "dec": codec[1]}


def mem():
    info = {}
    for line in (read("/proc/meminfo") or "").splitlines():
        k, v = line.split(":", 1)
        info[k] = int(v.split()[0]) * 1024
    total = info.get("MemTotal") or 1
    return round(100 * (total - info.get("MemAvailable", 0)) / total), \
        round((info.get("SwapTotal", 0) - info.get("SwapFree", 0)) / 2 ** 20)


def fans():
    try:
        with open(FANS_STATE) as f:
            state = json.load(f)
    except (OSError, ValueError):
        return {}
    return {v.get("label", k): v.get("duty") for k, v in state.get("fans", {}).items()}


def pods():
    """{'namespace/pod': [restarts, ready]}"""
    try:
        data = json.loads(sh(KUBECTL + ["get", "pods", "-A", "-o", "json"], 20) or "{}")
    except ValueError:
        return {}
    out = {}
    for p in data.get("items", []):
        if p["status"].get("phase") in ("Succeeded", "Failed"):
            continue
        cs = p["status"].get("containerStatuses") or []
        out["%s/%s" % (p["metadata"]["namespace"], p["metadata"]["name"])] = [
            sum(c.get("restartCount", 0) for c in cs), int(bool(cs) and all(c.get("ready") for c in cs))]
    return out


def record():
    now = time.time()
    names = drive_names()
    iface, gateway = route()
    try:
        with open(STATE) as f:
            prev = json.load(f)
    except (OSError, ValueError):
        prev = {}
    total, idle = cpu_ticks()
    disks = disk_counters(names)
    net = net_counters(iface) if iface else None
    cur = {"t": now, "cpu": [total, idle], "disk": disks, "net": net, "if": iface}
    used, swap = mem()
    row = {"t": int(now), "load": float((read("/proc/loadavg") or "0").split()[0]), "mem": used, "swap": swap,
           "gpu": gpu(), "temp": hwmon_temps(names), "fans": fans(), "pods": pods(),
           "ping": pings({"router": gateway, "internet": INTERNET}),
           "wifi": {"if": iface, "sig": wifi_signal(iface) if iface else None}}
    dt = now - prev.get("t", 0)
    if 0 < dt < 600:
        dtot, didle = total - prev["cpu"][0], idle - prev["cpu"][1]
        row["cpu"] = round(100 * (dtot - didle) / dtot) if dtot > 0 else None
        row["disk"] = {}
        for name, (r, w, busy) in disks.items():
            old = prev.get("disk", {}).get(name)
            if old:
                row["disk"][name] = [min(100, round((busy - old[2]) / dt / 10)),
                                     round((r - old[0]) * 512 / dt / 1e6, 1), round((w - old[1]) * 512 / dt / 1e6, 1)]
        if net and prev.get("net") and prev.get("if") == iface:
            row["wifi"]["down"] = round((net[0] - prev["net"][0]) * 8 / dt / 1e6, 1)
            row["wifi"]["up"] = round((net[1] - prev["net"][1]) * 8 / dt / 1e6, 1)
    os.makedirs(DIR, exist_ok=True)
    with open(os.path.join(DIR, time.strftime("%Y-%m-%d.jsonl", time.localtime(now))), "a") as f:
        f.write(json.dumps(row, separators=(",", ":")) + "\n")
    with open(STATE + ".tmp", "w") as f:
        json.dump(cur, f)
    os.replace(STATE + ".tmp", STATE)
    cutoff = time.strftime("%Y-%m-%d", time.localtime(now - KEEP_DAYS * DAY))
    for old in glob.glob(os.path.join(DIR, "*.jsonl")):
        if os.path.basename(old)[:10] < cutoff:
            os.remove(old)


# ---------------------------------------------------------------- the lookup

def hm(ts):
    return time.strftime("%H:%M", time.localtime(ts))


def clock(ms):
    s = int(ms) // 1000
    return "%d:%02d:%02d" % (s // 3600, s // 60 % 60, s % 60)


def parse_when(text):
    out = sh(["date", "-d", text, "+%s"])
    if not out.strip():
        sys.exit("can't read the time %r; try 12:15, \"yesterday 12:15\" or \"2026-10-10 12:15\"" % text)
    ts = int(out)
    if ts > time.time() + 60 and re.fullmatch(r"\s*\d{1,2}:\d{2}\s*", text):
        ts -= DAY
    return ts


def days(start, end):
    d, out = datetime.date.fromtimestamp(start), []
    while d <= datetime.date.fromtimestamp(end):
        out.append(d)
        d += datetime.timedelta(days=1)
    return out


def rows(start, end):
    out = []
    for d in days(start - 120, end):
        try:
            with open(os.path.join(DIR, d.isoformat() + ".jsonl")) as f:
                out += [json.loads(l) for l in f if l.strip()]
        except (OSError, ValueError):
            pass
    return [r for r in out if start - 120 <= r["t"] <= end]


def journal(args, start, end):
    out = []
    for line in sh(["journalctl", "--no-pager", "-o", "json", "--since", "@%d" % start, "--until", "@%d" % end]
                   + args, 60).splitlines():
        try:
            e = json.loads(line)
            msg = e.get("MESSAGE")
            if isinstance(msg, list):
                msg = bytes(msg).decode(errors="replace")
            out.append((int(e["__REALTIME_TIMESTAMP"]) / 1e6, msg or ""))
        except (ValueError, KeyError, TypeError):
            pass
    return out


def section(title, lines, empty):
    print("\n== " + title)
    if not lines:
        print("  " + empty)
    for line in lines[:LINES]:
        print("  " + line)
    if len(lines) > LINES:
        print("  ... %d more" % (len(lines) - LINES))


def who_used(app, who, start, end):
    lines = []
    for ts, msg in journal(["_SYSTEMD_UNIT=pi-paths.service"], start, end):
        if app and msg.split()[:1] != [app]:
            continue
        if who and who.lower() not in msg.lower():
            continue
        lines.append("%s  %s" % (hm(ts), re.sub(r"\s{2,}", "  ", msg)))
    return lines


def pod_changes(data, app):
    out = []
    for a, b in zip(data, data[1:]):
        pa, pb = a.get("pods", {}), b.get("pods", {})
        for name, (restarts, ready) in sorted(pb.items()):
            short = name.split("/", 1)[1]
            if app and app not in short:
                continue
            if name in pa:
                if restarts > pa[name][0]:
                    out.append((b["t"], "%s restarted (crash or killed)" % short))
                elif pa[name][1] and not ready:
                    out.append((b["t"], "%s stopped answering its health check" % short))
                elif ready and not pa[name][1]:
                    out.append((b["t"], "%s ready again" % short))
            elif pa:
                out.append((b["t"], "%s started (new pod)" % short))
        for name in sorted(set(pa) - set(pb)):
            if not app or app in name:
                out.append((b["t"], "%s went away" % name.split("/", 1)[1]))
    return out


def stands_out(data, app):
    notes = []
    for a, b in zip(data, data[1:]):
        if b["t"] - a["t"] > 100:
            notes.append((a["t"] + 60, "no readings until %s: the PC was too busy, or off" % hm(b["t"])))
    for r in data:
        t = r["t"]
        if (r.get("cpu") or 0) >= 90:
            notes.append((t, "CPU flat out (%d%%)" % r["cpu"]))
        if r.get("mem", 0) >= 92:
            notes.append((t, "memory nearly full (%d%%, swap %d MB)" % (r["mem"], r.get("swap", 0))))
        for name, (busy, rd, wr) in (r.get("disk") or {}).items():
            if busy >= 90:
                notes.append((t, "%s drive busy %d%% (reading %.0f MB/s, writing %.0f MB/s)" % (name, busy, rd, wr)))
        g = r.get("gpu") or {}
        for k, label in (("enc", "video encoder"), ("dec", "video decoder"), ("use", "GPU")):
            if (g.get(k) or 0) >= 90:
                notes.append((t, "%s flat out (%d%%)" % (label, g[k])))
        p = r.get("ping", {})
        router, net = p.get("router") or [3, None], p.get("internet") or [3, None]
        if router[0] < 3:
            notes.append((t, "Wi-Fi: lost %d of 3 pings to the router" % (3 - router[0])))
        elif (router[1] or 0) > 50:
            notes.append((t, "Wi-Fi slow: router ping %.0f ms" % router[1]))
        if net[0] == 0 and router[0] > 0:
            notes.append((t, "internet down (router fine)"))
        elif net[0] < 3 and router[0] == 3:
            notes.append((t, "internet: lost %d of 3 pings" % (3 - net[0])))
        sig = (r.get("wifi") or {}).get("sig")
        if sig is not None and sig < -75:
            notes.append((t, "Wi-Fi signal weak (%d dBm)" % sig))
        for name, c in (r.get("temp") or {}).items():
            if (name == "cpu" and c >= 85) or (name != "cpu" and c >= 50):
                notes.append((t, "%s hot (%d°)" % (name, c)))
    return notes + pod_changes(data, app)


def table(data, start):
    order = list(MOUNTS.values())
    disks = sorted({d for r in data for d in (r.get("disk") or {})}, key=lambda d: order.index(d) if d in order else 9)
    widths = [5, 5, 5, 5, 5, 5] + [6] * len(disks) + [7, 6, 5, 9, 9, 5, 5]
    fmt = lambda cells: "".join(str(c).rjust(w) for c, w in zip(cells, widths))
    lines = [fmt(["time", "cpu", "ram", "gpu", "enc", "dec"] + disks + ["down", "up", "sig", "router", "internet",
                                                                      "cpu°", "hdd°"]),
             " " * 30 + "drive busy".center(6 * len(disks)) + "Wi-Fi Mbit/s".center(13) + " dBm" + "ping".center(18)]
    pct = lambda v: "%d%%" % v if isinstance(v, (int, float)) else "-"
    ping = lambda x: ("%.0fms" % x[1] if x[0] == 3 else "%d/3 lost" % (3 - x[0])) if x else "-"
    for r in data:
        if r["t"] < start - 60:
            continue
        g, w, p, temp = r.get("gpu") or {}, r.get("wifi") or {}, r.get("ping") or {}, r.get("temp") or {}
        hdd = [c for n, c in temp.items() if n.startswith("hdd")]
        lines.append(fmt([hm(r["t"]), pct(r.get("cpu")), pct(r.get("mem")), pct(g.get("use")), pct(g.get("enc")),
                          pct(g.get("dec"))] + [pct((r.get("disk") or {}).get(d, [None])[0]) for d in disks]
                         + [w.get("down", "-"), w.get("up", "-"), int(w["sig"]) if w.get("sig") is not None else "-",
                            ping(p.get("router")), ping(p.get("internet")), temp.get("cpu", "-"),
                            max(hdd) if hdd else "-"]))
    return lines


def exec_app(app, script, container=None):
    return sh(KUBECTL + ["-n", NS, "exec", "deploy/" + app] + (["-c", container] if container else [])
              + ["--", "sh", "-c", script], 60)


JF_LINE = re.compile(r"^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\.\d+ ([+-]\d\d:\d\d)\] \[(\w+)\] \[\d+\] ([\w.]+): (.*)")
JF_KEEP = re.compile(r"Playback|playing|transcod|FFmpeg|ffmpeg|stream|throttl|session|Authentication", re.I)


def jellyfin_log(who, start, end):
    files = " ".join("/data/log/log_%s.log" % d.strftime("%Y%m%d") for d in days(start, end))
    lines = []
    for line in exec_app("jellyfin", "cat %s 2>/dev/null" % files).splitlines():
        m = JF_LINE.match(line)
        if not m:
            continue
        ts = datetime.datetime.fromisoformat(m.group(1).replace(" ", "T") + m.group(2)).timestamp()
        level, msg = m.group(3), m.group(5)
        if not start <= ts <= end:
            continue
        if level == "INF" and not JF_KEEP.search(msg):
            continue
        if who and level == "INF" and who.lower() not in msg.lower():
            continue
        msg = re.sub(r"Stopped at (\d+) ms", lambda s: "Stopped at %s into the film" % clock(s.group(1)), msg)
        lines.append("%s  [%s] %s" % (hm(ts), level, msg[:220]))
    return lines


def jellyfin_transcodes(start, end):
    """The transcodes that were running in the window: the film, error lines,
    and how fast ffmpeg went (below 1x it can't keep up and the video stops to buffer)."""
    script = ("for f in $(find /data/log -name 'FFmpeg*.log' -newermt @%d 2>/dev/null); do "
              "echo \"### $f\"; head -c 4000 \"$f\" | grep -o -m1 'file:\"[^\"]*\"'; "
              "grep -i -m5 -E 'error|invalid|corrupt|non-monoton' \"$f\"; "
              "tr '\\r' '\\n' < \"$f\" | grep -o 'speed=[ 0-9.]*x' | tail -n 600; done" % start)
    out, cur = [], None
    for line in exec_app("jellyfin", script).splitlines() + ["### end"]:
        if line.startswith("### "):
            if cur:
                speeds, slow = cur["speeds"], [s for s in cur["speeds"] if s < 1.0]
                if not speeds:
                    verdict = "no speed readings"
                elif slow:
                    verdict = "slowest %.2fx, %d of %d readings under 1x: transcoding could NOT keep up" % (
                        min(speeds), len(slow), len(speeds))
                else:
                    verdict = "slowest %.2fx: kept up" % min(speeds)
                out.append("started %s: %s  %s" % (cur["began"], cur["film"], verdict))
                out += ["    " + e[:200] for e in cur["errors"]]
            name = line[4:]
            stamp = re.search(r"(\d{4}-\d\d-\d\d)_(\d\d)-(\d\d)-(\d\d)", name)
            began = time.mktime(time.strptime(" ".join(stamp.groups()), "%Y-%m-%d %H %M %S")) if stamp else 0
            cur = None if name == "end" or began > end else {
                "began": hm(began) if began else "?", "film": os.path.basename(name), "errors": [], "speeds": []}
        elif cur:
            if line.startswith('file:"'):
                cur["film"] = os.path.basename(line[6:-1])
            elif line.startswith("speed="):
                try:
                    cur["speeds"].append(float(line[6:-1]))
                except ValueError:
                    pass
            else:
                cur["errors"].append(line.strip())
    return out


def nextcloud_log(who, start, end):
    """Warnings and errors from Nextcloud's own log (nextcloud.log, JSON lines)."""
    dates = {d.isoformat() for d in days(start - DAY, end + DAY)}
    script = "grep -h -E '%s' /var/www/html/data/nextcloud.log 2>/dev/null | tail -n 5000" % "|".join(sorted(dates))
    levels = ["debug", "info", "warn", "ERROR", "FATAL"]
    lines = []
    for line in exec_app("nextcloud", script, "nextcloud").splitlines():
        try:
            e = json.loads(line)
            ts = datetime.datetime.fromisoformat(e["time"]).timestamp()
        except (ValueError, KeyError, TypeError):
            continue
        if not start <= ts <= end or int(e.get("level", 0)) < 2:
            continue
        if who and who.lower() not in str(e.get("user", "")).lower():
            continue
        lines.append("%s  [%s] %s %s: %s  (%s %s)" % (
            hm(ts), levels[min(int(e.get("level", 0)), 4)], e.get("app", ""), e.get("user", "-"),
            str(e.get("message", ""))[:200], e.get("method", ""), str(e.get("url", ""))[:80]))
    return lines


ACCESS = re.compile(r'"(\w+) (\S+) HTTP/[\d.]+" (\d{3}) ')


def nextcloud_requests(who, start, end):
    """Nextcloud's web requests minute by minute, from its console log: how many
    pieces of an upload arrived, and every request that failed."""
    since = datetime.datetime.fromtimestamp(start, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    text = ""
    for prev in (["--previous"], []):
        text += sh(KUBECTL + ["-n", NS, "logs", "deploy/nextcloud", "-c", "nextcloud", "--timestamps",
                              "--since-time=" + since] + prev, 60)
    per_min, errors = {}, []
    for line in text.splitlines():
        stamp, _, rest = line.partition(" ")
        m = ACCESS.search(rest)
        if not m:
            continue
        try:
            ts = datetime.datetime.fromisoformat(stamp[:19] + "+00:00").timestamp()
        except ValueError:
            continue
        method, path, status = m.group(1), m.group(2), int(m.group(3))
        if not start <= ts <= end or path.startswith("/status.php"):
            continue
        if who and ("/%s/" % who.lower()) not in path.lower():
            continue
        minute = per_min.setdefault(hm(ts), [0, 0, 0])
        minute[0] += 1
        if method in ("PUT", "MOVE") and "/remote.php/dav/" in path:
            minute[1] += 1
        if status >= 400:
            minute[2] += 1
            errors.append("%s  %s %s  -> %d" % (hm(ts), method, path[:110], status))
    lines = ["%s  %4d requests  %4d upload pieces  %3d failed" % (k, *v) for k, v in sorted(per_min.items())]
    if errors:
        lines += ["", "failed requests:"] + errors
    return lines


def app_errors(app, start, end):
    since = datetime.datetime.fromtimestamp(start, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines = []
    for prev in (["--previous"], []):
        for line in sh(KUBECTL + ["-n", NS, "logs", "deploy/" + app, "--all-containers", "--timestamps",
                                  "--since-time=" + since] + prev, 60).splitlines():
            stamp, _, rest = line.partition(" ")
            try:
                ts = datetime.datetime.fromisoformat(stamp[:19] + "+00:00").timestamp()
            except ValueError:
                continue
            if start <= ts <= end and POD_ERROR.search(rest):
                lines.append("%s  %s" % (hm(ts), rest[:220]))
    return lines


def lookup(args):
    at = parse_when(args.time)
    start, end = at - args.minutes * 60, at + args.minutes * 60
    app = (args.app or "").lower()
    print("%s, %s to %s%s%s" % (time.strftime("%a %d %b %H:%M", time.localtime(at)), hm(start), hm(end),
                                ", " + app if app else "", ", " + args.who if args.who else ""))
    data = rows(start, end)

    section("Who was using %s (each minute: path and speed)" % (app or "the apps"), who_used(app, args.who, start, end),
            "nobody over Tailscale in this window (Funnel viewers show in the app's log below)")

    notes = sorted(stands_out(data, app))
    for ts, msg in journal(["-k"], start, end):
        if OOM.search(msg):
            notes.append((ts, "memory kill: " + msg[:160]))
        elif DISK_TROUBLE.search(msg):
            notes.append((ts, "disk error: " + msg[:160]))
    section("What stands out", ["%s  %s" % (hm(t), m) for t, m in sorted(notes)],
            "nothing: no busy drives, drops, restarts or memory kills" if data else
            "no readings for this time (recording started later, or older than %d days)" % KEEP_DAYS)
    section("The PC, minute by minute", table(data, start) if data else [], "no readings")

    if app == "jellyfin":
        section("Jellyfin's log (playback, transcoding, warnings, errors)", jellyfin_log(args.who, start, end),
                "nothing (Jellyfin keeps its log 3 days)")
        section("Transcodes running then", jellyfin_transcodes(start, end),
                "none: the film played as is (direct play), or the log is gone")
    elif app == "nextcloud":
        section("Nextcloud's requests, minute by minute", nextcloud_requests(args.who, start, end),
                "none (the console log is gone after two restarts)")
        section("Nextcloud's log (warnings and errors)", nextcloud_log(args.who, start, end), "nothing")
    elif app:
        section("%s's error lines" % app, app_errors(app, start, end), "none")

    wifi = [(t, m) for t, m in journal(["-u", "NetworkManager", "-u", "wpa_supplicant"], start, end) if WIFI.search(m)]
    kern = journal(["-k", "-p", "warning"], start, end)
    section("Wi-Fi and kernel messages", ["%s  %s" % (hm(t), m[:200]) for t, m in sorted(wifi + kern)], "none")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "record":
        return record()
    p = argparse.ArgumentParser(prog="pi-when", description="What was happening on the PC around a moment.")
    p.add_argument("time", help='12:15, "yesterday 12:15", "sat 21:40", "2026-10-10 12:15"')
    p.add_argument("app", nargs="?", help="jellyfin, nextcloud, immich, ... (optional)")
    p.add_argument("--who", help="only this user's lines (Tailscale or app user name)")
    p.add_argument("--minutes", type=int, default=10, help="how far either side to look (default 10)")
    args = p.parse_args()
    if os.geteuid() != 0:
        sys.exit("run with sudo")
    lookup(args)


if __name__ == "__main__":
    main()
