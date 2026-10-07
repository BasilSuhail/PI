#!/usr/bin/env python3
"""Temperature-driven fan control for the PC's motherboard fan headers.

The BIOS curve runs every fan at a fixed floor whatever the temperature, so a
CPU idling at 22° and a CPU transcoding at 70° sound the same. This replaces
it: the CPU fan follows the CPU, and the case fans stay off until the CPU, the
GPU or a drive actually warms up.

Fail-safe in both directions. A missing CPU reading, an error, or the service
stopping for any reason hands every header back to the chip's own automatic
mode (pwmN_enable=2), which is the BIOS curve the board shipped with. systemd
runs `--release` after the process exits, so a crash or a kill lands there too.

Stdlib only. Config: /etc/pi-fans.json (written once by install-fan-curve.sh,
then left alone so it can be tuned). State for the dashboard: /run/pi-fans.json.
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import time

HWMON = os.environ.get("HWMON_ROOT", "/sys/class/hwmon")
CONF = os.environ.get("FANS_CONF", "/etc/pi-fans.json")
STATE = os.environ.get("FANS_STATE", "/run/pi-fans.json")
INTERVAL_SEC = 3
GPU_EVERY_SEC = 10
NVIDIA_SMI = shutil.which("nvidia-smi")

# Headers as identified on the PC: pwm2, pwm3 and pwm4 each stopped one case
# fan at 0%; pwm1 drives the CPU cooler, which bottoms out near 800 rpm and
# never stops. Duty is 0-255.
DEFAULT = {
    "cpu": {"pwm": "pwm1", "label": "CPU", "min": 51, "max": 255, "from": 50, "to": 75},
    "case": {
        "pwms": {"pwm2": "Rear exhaust", "pwm3": "Front intake, bottom", "pwm4": "Front intake, top"},
        # A stopped fan needs a push to start, then holds a lower duty.
        "start": 102,
        "max": 255,
        "on": {"cpu": 60, "gpu": 60, "drive": 45},
        # Lower than "on", so a reading hovering at the threshold does not
        # switch the fans on and off every few seconds.
        "off": {"cpu": 55, "gpu": 55, "drive": 42},
        "full": {"cpu": 80, "gpu": 80, "drive": 50},
    },
}


def log(msg):
    print(msg, flush=True)


def read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


def write(path, value):
    with open(path, "w") as f:
        f.write(str(value))


def chips():
    try:
        entries = sorted(os.listdir(HWMON))
    except OSError:
        return []
    out = []
    for e in entries:
        path = os.path.join(HWMON, e)
        out.append((read(os.path.join(path, "name")) or "", path))
    return out


def fan_chip():
    for name, path in chips():
        if name.startswith("it8"):
            return path
    return None


def first_temp(path):
    raw = read(os.path.join(path, "temp1_input"))
    try:
        return int(raw) / 1000.0
    except (TypeError, ValueError):
        return None


def cpu_temp():
    for name, path in chips():
        if name in ("k10temp", "coretemp"):
            return first_temp(path)
    return None


def drive_temp():
    """The hottest drive, or None when drivetemp reports nothing."""
    temps = [t for name, path in chips() if name == "drivetemp" for t in [first_temp(path)] if t is not None]
    return max(temps) if temps else None


_gpu = {"at": 0.0, "value": None}


def gpu_temp():
    if not NVIDIA_SMI:
        return None
    now = time.time()
    if now - _gpu["at"] >= GPU_EVERY_SEC:
        value = None
        try:
            out = subprocess.run(
                [NVIDIA_SMI, "--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=4,
            )
            if out.returncode == 0:
                value = float(out.stdout.strip().splitlines()[0])
        except (subprocess.SubprocessError, OSError, ValueError, IndexError):
            value = None
        _gpu.update(at=now, value=value)
    return _gpu["value"]


def ramp(t, lo, hi, dmin, dmax):
    if t is None or t <= lo:
        return dmin
    if t >= hi:
        return dmax
    return round(dmin + (dmax - dmin) * (t - lo) / (hi - lo))


def load_conf():
    try:
        with open(CONF) as f:
            return json.load(f)
    except (OSError, ValueError):
        return DEFAULT


def headers(conf):
    return [conf["cpu"]["pwm"], *conf["case"]["pwms"].keys()]


def release(conf=None):
    """Every header back to the chip's automatic mode: the BIOS curve."""
    conf = conf or load_conf()
    path = fan_chip()
    if path:
        for p in headers(conf):
            try:
                write(os.path.join(path, p + "_enable"), 2)
            except OSError:
                pass
    try:
        os.remove(STATE)
    except OSError:
        pass


def publish(conf, duties, case_on, temps):
    """What the dashboard shows: a name per fan, and that it is managed."""
    fans = {}
    for p, label in [(conf["cpu"]["pwm"], conf["cpu"]["label"]), *conf["case"]["pwms"].items()]:
        fans["fan" + p[3:]] = {"label": label, "duty": duties.get(p), "managed": True}
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"fans": fans, "caseOn": case_on, "temps": temps, "ts": int(time.time())}, f)
    os.replace(tmp, STATE)


def step(conf, path, state):
    cpu, gpu, drive = cpu_temp(), gpu_temp(), drive_temp()
    if cpu is None:
        raise RuntimeError("no CPU temperature")

    c = conf["case"]
    hot = lambda lim: cpu >= lim["cpu"] or (gpu is not None and gpu >= lim["gpu"]) or (drive is not None and drive >= lim["drive"])
    if not state["case_on"] and hot(c["on"]):
        state["case_on"] = True
        log("case fans on: cpu %.0f° gpu %s drive %s" % (cpu, gpu, drive))
    elif state["case_on"] and not hot(c["off"]):
        state["case_on"] = False
        log("case fans off: cpu %.0f° gpu %s drive %s" % (cpu, gpu, drive))

    k = conf["cpu"]
    duties = {k["pwm"]: ramp(cpu, k["from"], k["to"], k["min"], k["max"])}
    case_duty = 0
    if state["case_on"]:
        case_duty = max(
            ramp(cpu, c["on"]["cpu"], c["full"]["cpu"], c["start"], c["max"]),
            ramp(gpu, c["on"]["gpu"], c["full"]["gpu"], c["start"], c["max"]) if gpu is not None else 0,
            ramp(drive, c["on"]["drive"], c["full"]["drive"], c["start"], c["max"]) if drive is not None else 0,
        )
    for p in c["pwms"]:
        duties[p] = case_duty

    kicks = []
    for p, duty in duties.items():
        prev = state["last"].get(p)
        if prev == duty:
            continue
        # A stopped fan may not start at a low duty: full for two seconds first.
        if duty and prev == 0:
            write(os.path.join(path, p), 255)
            kicks.append(p)
        else:
            write(os.path.join(path, p), duty)
            state["last"][p] = duty
    if kicks:
        time.sleep(2)
        for p in kicks:
            write(os.path.join(path, p), duties[p])
            state["last"][p] = duties[p]

    publish(conf, duties, state["case_on"], {"cpu": cpu, "gpu": gpu, "drive": drive})


def run(once=False):
    conf = load_conf()
    path = fan_chip()
    if not path:
        log("no it87 fan chip; nothing to control")
        sys.exit(1)

    def stop(*_):
        release(conf)
        log("released to the BIOS curve")
        sys.exit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    for p in headers(conf):
        write(os.path.join(path, p + "_enable"), 1)
    log("controlling %s" % ", ".join(headers(conf)))

    state = {"case_on": False, "last": {}}
    while True:
        try:
            step(conf, path, state)
        except Exception as err:  # any failure: hand back, let systemd restart us
            log("fail-safe: %s" % err)
            release(conf)
            sys.exit(1)
        if once:
            return
        time.sleep(INTERVAL_SEC)


if __name__ == "__main__":
    if "--release" in sys.argv:
        release()
    elif "--default-config" in sys.argv:
        print(json.dumps(DEFAULT, indent=2))
    else:
        run(once="--once" in sys.argv)
