# The PC

One x86 desktop, jug3, replaced both boards. Everything jug2 ran under k3s
runs on it now, and jug's OSINT stack moves over next. Both Pis are retired.

This page is the machine as built. Where it differs from the plan it replaced,
the plan was wrong.

---

## Hardware

| | | |
|---|---|---|
| Board | ASUS ROG STRIX B350-F GAMING | BIOS 6232, UEFI |
| CPU | AMD Ryzen 5 1600 | 6 cores, 12 threads. **No integrated graphics** |
| RAM | 16 GB | |
| GPU | NVIDIA GeForce GTX 1050 Ti, 4 GB | stays in: the CPU has no display output of its own |
| PSU | Corsair CX600M | 600 W. No data link, so nothing can read its draw |
| Wi-Fi | Intel AX210 on a PCIe card | `wlp7s0`, in-kernel `iwlwifi`. The only network: no cable reaches the PC |
| Screen | none | jug3 runs headless. Everything is done over SSH |

---

## Disks

| Drive | Model | Holds | Mount |
|---|---|---|---|
| SSD1, 250 GB | Samsung 860 EVO | Debian, and nothing else | `/` |
| SSD2, 1 TB | Crucial BX500 | `1) Archive`: every app's settings and databases, and backups | `/srv/ssd`, bound to `/1) Archive` |
| HDD1, 6 TB | Seagate ST6000VX009 | Jellyfin, Kiwix, downloads | `/srv/storage` |
| HDD2, 6 TB | WD Purple WD64PURZ | Nextcloud, Immich, backups, ArchiveBox | `/srv/hdd2`, under the `/srv/pool` mergerfs pool |

All four are mounted by UUID with `nofail`. The `sdX` letters move between
boots on this board, so nothing may refer to a disk by them.

SSD2 was jug2's root disk. Its old Pi system was archived to
`/srv/hdd2/Backups/jug2-os.tgz` and removed, leaving only `1) Archive`. Its
fstab line binds `/srv/ssd/1) Archive` to `/1) Archive`, which is where every
install script looks, so no app needed a path changed. The OS lives on its own
drive so it can be reinstalled without touching the apps.

---

## BIOS

Set once, with a screen, and not to be revisited:

- **Advanced → AMD CBS → CPU Common Options → Power Supply Idle Control → Typical Current Idle.**
  First-generation Ryzen can freeze when idle without it.
- **Restore AC Power Loss → Power On.**
- **Wait For 'F1' If Error → Disabled.** A headless machine cannot press F1.
- **Secure Boot: off.** `mokutil --sb-state` confirms it over SSH. The NVIDIA
  and it87 modules are self-signed by DKMS, which only works with it off.

---

## OS

Debian 13 (trixie), amd64. The login user is `jug3`, with passwordless `sudo`
because the `make` targets run `sudo` without a terminal.

The installer put GNOME on despite the task being unticked. Its login screen
suspended the machine after twenty idle minutes, which looked like crashes.
It is disabled, not removed (removal takes NetworkManager with it, and that is
the Wi-Fi):

```
sudo systemctl disable --now gdm3
sudo systemctl set-default multi-user.target
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

Wi-Fi power saving is off (`IFACE=wlp7s0 bash deploy/tune-wifi.sh`; `make wifi`
does not pass the interface through).

---

## Drivers

| Driver | For | How |
|---|---|---|
| `nvidia-driver` 550 | GPU stats, NVENC | `contrib non-free` added in `/etc/apt/sources.list.d/nonfree.list`, then `apt install linux-headers-amd64 nvidia-driver nvidia-smi` and a reboot |
| it87, community DKMS build | fans | `github.com/frankcrawford/it87`, `sudo ./dkms-install.sh`. The board's IT8665E chip has no in-kernel driver. Loaded with `options it87 ignore_resource_conflict=1` and listed in `/etc/modules-load.d/it87.conf`. No kernel boot option needed |
| `drivetemp` | drive temperatures | loaded by `agent/install.sh` |
| RAPL energy counter | CPU package power | root-only by default; `agent/install.sh` adds a udev rule that makes it readable |

The GTX 1050 Ti reports no power draw (`N/A`), and its fan cannot go below
45%: both are set in the card's firmware.

`make gpu` installs NVIDIA's container toolkit, restarts k3s so it registers
the `nvidia` RuntimeClass, and gives the card to Jellyfin for NVENC/NVDEC.
Hardware acceleration is then switched on in Jellyfin's own Transcoding page.
The card decodes H.264, HEVC (8 and 10-bit), VP9 and older formats, and
encodes H.264 and HEVC; it has no AV1.

---

## Fans

`make fans` installs `deploy/fan-curve.py` as `pi-fans.service`. Config:
`/etc/pi-fans.json`.

| Header | Fan | Behaviour |
|---|---|---|
| pwm1 | CPU cooler | follows the CPU: slowest below 50°, full at 75°. It cannot stop (about 800 rpm minimum) |
| pwm2 | rear exhaust | off until CPU or GPU reaches 45°, then 30% rising to full at 80°; off again below 42°, after at least 1 minute on |
| pwm3 | front intake, top | as the exhaust |
| pwm4 | front intake, bottom | the hard drives only: on at 45°, 30% rising to full at 50°, off below 42° after at least 1 minute; it blows across them |
| pwm6 | nothing | free, for a fan on the GPU heatsink |

The three case fans stop fully at 0%. Stopping the service, or any failure,
hands every header back to the BIOS curve.

---

## What moved, and what it cost

- **Immich**: the database still held jug2's password while the new install
  generated a fresh one. Fixed by setting the database's password to the new
  secret with `ALTER USER`. Its library is on HDD2, so `install-immich.sh` now
  defaults to `/srv/hdd2`.
- **Nextcloud and Uptime Kuma**: re-running `make archive` over a populated
  archive re-owned every app's files to the login user. Nextcloud lost write
  access to its config; Kuma crashed on start. `setup-archive.sh` no longer
  recurses.
- **Uptime Kuma**: on a fresh cluster it needs the `pi` namespace, which used to
  come from the dashboard install. It now creates it.
- **Tailscale**: a new OAuth client for the operator, and a new API token for the
  dashboard, which expires on 5 January 2027.
