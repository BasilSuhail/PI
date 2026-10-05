# The PC

One x86 desktop replaces both boards. jug's OSINT stack and everything jug2
runs under k3s move onto it, and both Pis retire. The open issues stay open
until it is stable.

Read off the machine under Windows before it was wiped, unless a row says
otherwise.

---

## Hardware

| | | |
|---|---|---|
| Board | ASUS ROG STRIX B350-F GAMING | BIOS 6232, 2024-09-29, UEFI |
| Secure Boot | on | Debian boots with it on. See the GPU row |
| CPU | AMD Ryzen 5 1600 | 6 cores, 12 threads, 3.2 GHz base. **No integrated graphics** |
| RAM | 24 GB, 4 of 4 slots | mixed sticks, running at 2133 MT/s. Stick sizes not read yet |
| GPU | NVIDIA GeForce GTX 1050 Ti, 4 GB | stays in: the CPU has no display output of its own |
| PSU | Corsair CX600M | 600 W, semi-modular |
| Wi-Fi | Ubit AX210S, PCIe x1 | Intel AX210: Wi-Fi 6E and Bluetooth 5.3. In-kernel `iwlwifi`, no vendor driver |
| Ethernet | onboard, unused | no cable can reach where the PC sits |
| Fans | 2 × Noctua 4-pin PWM, planned | CHA_FAN headers: bottom front intake, top rear exhaust |

---

## Disks

The [disk layout](../README.md#the-disks) carries over: the OS and every app's
settings on one fast drive, files you would recognise on the spinning ones.

| Drive | Interface | Holds | Mount |
|---|---|---|---|
| 1 TB NVMe | M.2 slot, 2280 | the OS and `1) Archive/Apps` | `/` |
| 1 TB SSD | SATA | OSINT, and room for anything else | not decided |
| HDD1, 6 TB (Seagate ST6000VX009) | SATA | Jellyfin media, Kiwix, downloads | `/srv/storage`, as now |
| HDD2 | SATA | the Nextcloud pool | `/srv/hdd2`, as now |
| 1 TB HDD | SATA | backups | not decided |

Mount points stay the same so every hostPath in `k8s/` works without edits.

Both HDDs move over as they are, with no reformat. They are ext4 and mounted
by UUID, so Linux sees the same disks under the same names.

Retired: the 512 GB SSD (its apps move to the NVMe), the Samsung 860 EVO
250 GB that holds Windows, both Pis, the Waveshare SATA HAT and its 12V
adapter. The PSU powers the drives directly, so the adapter failure in #146
cannot happen again.

Already in the PC: a WD Blue 1 TB HDD (WD10EZEX), 7200 rpm.

---

## BIOS, before installing

- **Advanced → AMD CBS → Power Supply Idle Control → Typical Current Idle.**
  First-generation Ryzen can freeze on Linux when it sits idle in deep
  C-states. A server is idle most of the time.
- **Restore AC Power Loss → Power On.** It comes back by itself after a cut.
- **Onboard Devices Configuration → RGB off.**
- **Memory: leave at defaults.** Four mixed sticks on Zen 1 are already at the
  slowest speed. Run memtest86+ for one full pass before trusting it.
- **Boot order:** NVMe first, once the OS is on it.

---

## OS

Debian 13 (trixie), amd64, no desktop. It is the same Debian the Pis run, so
the repo's `apt` and `systemd` scripts carry over.

- Partitions: EFI plus a single ext4 root on the NVMe. No separate `/home`
  and no LVM. `1) Archive` is a directory on that root, the same as on jug2.
- Installer tasks: **SSH server** and **standard system utilities** only.
- Wi-Fi firmware: `firmware-iwlwifi`. Since Debian 12 the official images
  ship non-free firmware, so the installer can bring up the AX210 itself.
  Confirm this on the download page before relying on it.
- After the install: `amd64-microcode`, Tailscale, k3s and Docker, then the
  `make` targets.

## Wi-Fi

- Regulatory domain GB.
- Power save off. `make wifi` does this, but it defaults to `wlan0` and this
  interface will have a different name, so pass `IFACE=`.
- Prefer 5 GHz. 6 GHz on Linux depends on the regulatory domain, and 5 GHz is
  the known-good band.
- The connection must come up at boot with no one logged in.
- Reserve the address in the router.

---

## The GPU

A GTX 1050 Ti (Pascal) can encode and decode H.264 and HEVC, including
10-bit HEVC, but not AV1. That covers Jellyfin transcoding and Immich's
machine learning if they are ever moved onto it.

Using it needs the proprietary NVIDIA driver and the container toolkit. With
Secure Boot on, the driver's module has to be signed and its key enrolled
(MOK) at the next boot. Turning Secure Boot off is the other way.

Until then the card only drives a screen. Nothing in the repo uses it.

---

## Not known yet

- The make and model of the 1 TB NVMe.
- HDD2's size and model.
- The RAM stick sizes: `sudo dmidecode -t memory`.
- Whether the 1 TB backup HDD is the WD Blue already in the PC.
- What the B350-F's M.2 slot shares with the SATA ports. Five SATA drives
  would be needed if the WD Blue stayed in as well. Check the manual before
  cabling.
