# Build log

What has actually been done to the boards, in order, with the reasoning. Issue #5 is the plan; this is the record.

Convention: `jug1` is the 8GB board, `jug2` the 16GB board. Names follow the storage, not the silicon.

---

## Boards as they stand

| | jug1 | jug2 |
|---|---|---|
| RAM | 8GB | 16GB |
| Boot | SD card, `/boot/firmware` only — must stay in the slot | its own SSD |
| Root | its own 512GB SSD | 1TB SSD — apps, and the faster small backups |
| Expansion | none | Waveshare PCIe SATA HAT — ASMedia ASM106x, one port in use |
| Bulk | — | 6TB HDD (ST6000VX009) on the HAT, 12V barrel fitted — blank, migration pending |
| LAN | see `~/.ssh/config` on the Mac | same |
| OS | Debian 13 trixie, aarch64, 4 cores | same |
| Runs | OSINT stack (Docker Compose), `llama-server` | k3s server |
| Role | untouched. Docker Compose only. | cluster control plane |

DHCP assigns both addresses; they are not reserved. Worth pinning in the Fritz!Box at some point.

---

## 1. SSH access to jug2

New board had no key access. Ended up on password auth by choice — key auth was set up, then deliberately reverted.

`~/.ssh/config` on the Mac now carries:

```
Host jug
    HostName <jug1-lan>
    User jug
    PubkeyAuthentication no

Host jug2
    HostName <jug2-lan>
    User jug
    PubkeyAuthentication no
```

`PubkeyAuthentication no` is doing real work: an older passphrase-protected key exists on the Mac whose passphrase is unknown. Without this, ssh offers that key, the server accepts it as a candidate, and the client blocks on a passphrase prompt that can never be satisfied. Forcing password auth skips the whole path.

Two leftovers on jug2, harmless but worth clearing eventually:

- `~/.ssh/authorized_keys` holds two public keys whose private halves are unused
- `~/.ssh/id_ed25519_pi` on the Mac — a passphraseless key that was generated, then abandoned

Config backups: `~/.ssh/config.bak*` on the Mac, four of them.

**Consequence:** every remote command is interactive. Nothing can be scripted against the boards over SSH.

---

## 2. cgroups on jug2

Pi kernels boot with cgroup memory accounting disabled. Two effects, one of which was live on jug1 and unnoticed:

1. k3s installs, reports Ready, and then never schedules a pod. Nothing in the error mentions cgroups.
2. **`mem_limit` in every Compose file is silently ignored.** `docker stats` on jug1 reports `0B / 0B` for all six OSINT containers — the kernel declining to account, not Docker declining to display.

That second one means guard #2 in issue #1 has never been in force. `llama-server` runs outside Docker at 3.2GB and is the largest process on jug1, so it is what the OOM killer selects. Exactly the failure that guard was written to prevent.

Applied to jug2:

```bash
sudo cp /boot/firmware/cmdline.txt /boot/firmware/cmdline.txt.bak
sudo sed -i '$ s/$/ cgroup_memory=1 cgroup_enable=memory/' /boot/firmware/cmdline.txt
sudo reboot
```

`cmdline.txt` must remain a single line with no trailing newline, or the board does not boot.

**Verification is not `/proc/cgroups`.** Debian 13 is cgroup v2 only, so the v1 table has no memory row and looks like a failure. The authoritative file:

```
$ cat /sys/fs/cgroup/cgroup.controllers
cpuset cpu io memory pids
```

`memory` present — correct.

One detail worth knowing. The Pi bootloader prepends its own parameters, including `cgroup_disable=memory`:

```
reboot=w ... cgroup_disable=memory ... cgroup_memory=1 cgroup_enable=memory
             ↑ firmware                  ↑ ours, appended last
```

The kernel reads left to right and the last value wins. This is why the flags must go at the **end** of `cmdline.txt`.

**jug1 has not had this applied.** Its memory limits remain unenforced.

---

## 3. k3s server on jug2

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--write-kubeconfig-mode 644" sh -
```

Installed **v1.36.4+k3s1**, containerd 2.3.4.

`--write-kubeconfig-mode 644` lets the `jug` user read the kubeconfig without sudo. Convenience only.

| Path | What |
|---|---|
| `/usr/local/bin/k3s` | the binary — API server, scheduler, controller-manager, kubelet, containerd |
| `/var/lib/rancher/k3s/server/db/state.db` | **SQLite. This is the cluster.** Back it up; nothing else matters. |
| `/var/lib/rancher/k3s/server/node-token` | join secret. Never commit. |
| `/etc/rancher/k3s/k3s.yaml` | kubeconfig, mode 644 |
| `/usr/local/bin/k3s-uninstall.sh` | complete undo |

Bundled and running: CoreDNS, Traefik, local-path-provisioner (default StorageClass), metrics-server.

Verified:

```
NAME   STATUS   ROLES           VERSION
jug2   Ready    control-plane   v1.36.4+k3s1
```

`helm-install-traefik` errored twice before completing — a race against the CRD job on first start. It self-corrected without intervention; RESTARTS 2 then `Completed`.

### Cost

| | RAM | CPU |
|---|---|---|
| jug2 before k3s | 327Mi | — |
| jug2 with k3s idle | 1.0Gi (`kubectl top`: 852Mi) | 54m, 1% |
| plus 5 nginx pods | 913Mi | 89m, 2% |

**Control plane ≈ 700MB.** Five containers on top cost ~60MB. The overhead is the orchestrator, not the workloads — which is the argument for keeping the cluster to one node until something actually needs to move.

---

## 4. kubectl from the Mac

```bash
brew install kubectl                                        # kubernetes-cli 1.37.0
ssh jug2 'cat /etc/rancher/k3s/k3s.yaml' > ~/.kube/config-jug2
chmod 600 ~/.kube/config-jug2
sed -i '' 's|<loopback>|jug2|' ~/.kube/config-jug2
```

`KUBECONFIG` exported in `~/.zshrc`.

The `sed` is required: k3s writes the server as the loopback address, which resolves to the wrong machine when the file is read anywhere but the Pi.

Home LAN only. The cluster's TLS certificate carries jug2's LAN address, so connecting via any other name fails the cert check. A `tls-san` entry would fix that if remote `kubectl` is ever wanted.

---

## 5. Reconciliation, demonstrated

```bash
kubectl create deployment hello --image=nginx --replicas=2
kubectl delete pods -l app=hello        # both
# 12 seconds later: two new pods, different names, Running
kubectl scale deployment hello --replicas=5
kubectl delete deployment hello
```

Deleting every pod and running nothing else returned two new ones. Desired state said 2, actual said 0, the controller closed the gap.

This is the difference from Compose. `restart: always` retries a container on the box it is already on. A controller re-creates it wherever the cluster has room — which is worth nothing on one node, and is the entire point on several.

---

## 6. Node agents on both boards

`agent/install.sh` on each board. Two services:

| Port | Service | What |
|---|---|---|
| 61208 | `glances.service` | REST API, `--disable-webui`. CPU, memory, disks, network, processes, containers. |
| 9101 | `pi-metrics.service` | stdlib Python. PMIC power draw and `vcgencmd` throttle state — the two things Glances cannot see. |

The shim returns empty `capabilities` on hardware without `vcgencmd`, so the same file drops onto any Linux node and the frontend renders fewer tiles rather than breaking.

Three things went wrong, all worth recording:

**The shim exited 0 in a restart loop.** Stripping a literal bind address to satisfy the commit guard left a trailing comment ahead of the chained call, so `.serve_forever()` was swallowed into it. The server was constructed and never started. No traceback — the process exited cleanly, so systemd reported `active` between attempts and the port stayed closed.

**Glances kept running under the package's own configuration.** Debian starts it at install time, so `systemctl enable --now` found the unit already active and left it alone — serving XML-RPC on another port rather than the REST API. Needs an explicit `restart`.

**Glances needs `python3-docker`** to read the Docker socket. Without it the containers plugin returns an empty list rather than an error, so jug1 would have shown no containers with nothing indicating why.

## 7. Fleet dashboard

`docs/dashboard.md` is the design. Frontend by Basil, backend here.

Discovery goes through the **Tailscale API, not the Kubernetes node list** — jug1 is on the tailnet but not in the cluster, so asking k8s would miss the busiest machine in the house. Cluster membership is applied afterwards as a label.

The frontend arrived as a Manus scaffold. The stylesheet, layout and view structure were kept as authored; the scaffold around them was removed — tRPC, Drizzle, MySQL, OAuth, S3, LLM and voice endpoints, Google Maps, 52 unused shadcn components, Tailwind (no utility class appears in the markup), wouter, react-query. **Roughly ninety dependencies became ten.** Next.js went with them; this is a static bundle plus a `node:http` server, 218KB of client and 14KB of server with no framework runtime.

Five bugs found by pointing the client at live agents rather than at fixtures:

| | |
|---|---|
| `uptime` is a string | `"0:44:03"`, or `"3 days, 2:15:09"` past a day — not a number. Reading `.seconds` returned null forever, and nothing would have looked broken. |
| `os_version` is the kernel | `hr_name` is a full description string. `platform` is bitness, not architecture. |
| Virtual interfaces dominate | jug1 reported nine: wlan0 plus a docker bridge and six veth pairs. jug2 nine too, via k3s CNI. Their traffic is already counted on the physical interface. |
| CPU samples arrive uninitialised | Glances computes CPU as a delta since the previous request, not from its own timer, so requests close together produce a window near zero and a sample where `total` and `idle` are both 0 — impossible on a running system. Retrying is itself a short window and makes it worse. A last-known-good cache with a 30s ceiling covers it. |
| `apps.json` was never read | Resolved beside the bundle but only present in source, so the launcher silently returned `[]`. |

## 8. Dashboard live on jug2

`deploy/install-dashboard.sh`. Builds on the board — the boards are arm64 and cross-building from the Mac buys nothing — then installs a systemd service.

Node 22 is installed if needed; Debian 13 ships 20, which the build rejects. Only `dist/` is installed: the client is bundled and the server imports nothing outside the standard library, so the runtime needs no packages at all.

The first unit would not start: `status=216/GROUP`, restarting every five seconds, 43 attempts. It set `SupplementaryGroups=tailscale` to reach the tailscaled socket without root, and **Debian's tailscale package creates no such group**. systemd refuses to spawn a process whose supplementary group does not resolve. Runs as the login user instead, who can already query the daemon.

Exposed with `tailscale serve --bg 8080` — real certificate, tailnet-only, no open ports, reachable from a phone with no client beyond Tailscale itself.

```
https://jug2.<tailnet>.ts.net   →  200
```

## 9. Archive tree on jug2

`deploy/setup-archive.sh`. Creates `/srv/archive` and seven directories under it.

The 8TB is still blocked on 12V, and the archive did not need to wait for it.
jug2 holds 873GB free, which covers Wikipedia at ~100GB, the book library and a
first laptop backup with room left. The tier that issue #1 describes — Samba,
Kiwix, Jellyfin, Calibre-Web — can be built now and moved later, because every
service is pointed at the path and never at a device.

```
/srv/archive/
├── backups/      laptops, Time Machine target
├── documents/
├── photos/
├── movies/
├── books/
├── wikipedia/    kiwix .zim files
└── repos/        git mirrors
```

Directories are `2775`: group-writable with the setgid bit, so anything written
later inherits the group rather than depending on which daemon created it.

**The trap this sets, and how the script defuses it.** `/srv/archive` is a plain
directory on `/dev/sda2` today and a mount point later. Mounting a disk over a
directory does not move what is underneath — those files stay on the root
filesystem, keep consuming it, and become invisible while the mount is live. The
script detects it is not on a mount point and prints the migration in full:
copy to the new disk mounted elsewhere, verify, then swap and delete. It also
refuses to run anywhere with less than 200GB free, since Wikipedia alone would
not fit.

Placement was decided by measurement, before the SATA HAT moved. jug1 sustains
~350% of a core during ingest bursts against a load average of 4.33 on four
cores; jug2 idles at 1.6% with load 0.038. Reads for Jellyfin and Samba belong
on the board that has cycles to serve them.

The hardware has since agreed with the measurement. The Waveshare PCIe SATA HAT
came off jug1 and went onto jug2, so the board that will hold the bulk disks is
also the board with the cycles to serve them. Each board still boots and roots
from a single SSD of its own; nothing is attached to the HAT's spare ports yet.

The 6TB's first hot-plug left the controller disabled, and the symptom was
misleading enough to be worth recording. Connecting a powered drive glitched
the PCIe link; the kernel recovered it, and the controller came back with its
COMMAND register at `0x0000` — memory decoding off, so every hardware register
read `0xffffffff` and no disk could be detected while the drive spun happily
and the HAT's activity LED showed green. Every visible symptom pointed at the
disk or the 12V supply, and both were fine. A reboot restored it;
`deploy/check-sata-hat.sh` reads that register now.

## Security posture

| | |
|---|---|
| API server `:6443` | LAN only. No router forwarding. |
| Unauthenticated request | `401 Unauthorized` — verified |
| Auth | TLS client certificate. No password, nothing to brute-force. |
| Cert scope | `cluster-admin`, unrestricted |
| `~/.kube/config-jug2` | mode 600 |

The exposure is not the API server. It is the kubeconfig itself: plaintext admin credentials with no expiry. A `.gitignore` covering kubeconfigs, tokens, keys, env files and disk images landed with this file.

SSH remains password-authenticated on both boards, which is the weaker of the two doors.

---

## Open

- [x] **12V supply.** A 12V 3A barrel is fitted and working: the drive spins up and the SATA link trains at 6.0 Gbps, which no dead or wrong-polarity supply would allow. Never metered — proven by the disk instead, which is the test that matters. Comfortable for one 3.5" drive, marginal for two.
- [x] **Confirm the SATA HAT enumerates on jug2.** Done, read out of `/sys` over the shim's file endpoint without a shell on the board. `0001:01:00.0` is an ASMedia `1b21:0612` SATA controller in AHCI mode, linked at 5.0 GT/s x1 — Gen 2, which is that part's maximum — in power state D0 with the `ahci` driver bound. It creates `ata1` and `ata2`. jug2's own 1TB SSD is on `host0`, not on the HAT. Both ports were free at that check; `link1` now carries the 6TB at 6.0 Gbps.
- [ ] **Bring the 6TB up as the archive disk.** Detected as `/dev/sdb`, an ST6000VX009 at 6.00 TB decimal — not the 8TB the plan assumed, and the records follow the disk. Factory blank. Partition and format it, then run the migration `deploy/setup-archive.sh` prints: mount it elsewhere, rsync `/srv/archive` across, verify, swap the fstab line in with `nofail`, and only then delete the copy on the root filesystem. One extra step the script does not mention: the existing `/srv/browse/archive` bind was made against the directory, so it must be re-bound after the new disk is mounted or Finder and the console keep showing the old contents.
- [ ] **Run `make automount` after this merge.** The rule was mounting each board's own root and boot partitions under `/media` at every boot — writable, through the console's file browser. Fixed in the repo by excluding them by device and PARTUUID; both boards need the re-run to pick up the rule and to unmount the two self-mounts jug2 is carrying right now.
- [ ] **cgroup flag on jug1.** Its `mem_limit`s are unenforced today, and container memory reads `—` on the dashboard until it is applied. Needs a reboot, which drops OSINT for about a minute.
- [ ] Point `dashboard/server/apps.json` at the real services. It carries two placeholder entries.
- [ ] DHCP reservations for both boards in the Fritz!Box.
- [ ] Clear the two dead public keys from jug2's `authorized_keys`.
- [ ] Image jug1's SD card. Boot-only and holds no data, but its loss means the board will not start.
- [ ] Wired ethernet. Both boards are on `wlan0`; issue #1 says a first Time Machine backup over wifi is hours.

Deferred by decision, not oversight:

- **jug1 joining the cluster.** Waits until `llama-server` moves to the Mac Mini and jug1's real free RAM can be measured, since `--kubelet-arg=system-reserved` must be a measured number. A scheduler that cannot see Docker will place pods into RAM that OSINT already holds.
- **Migrating OSINT into k8s.** Not planned. Issue #2 settled it: containers pinned to their own disk gain nothing from an orchestrator.
- **Moving the dashboard into k3s.** Merged in [#92](../../pull/92), not yet run on the board. `make dashboard-k8s`. Section 10 gets written once it has actually been deployed and measured; until then section 8 above is still what is live on jug2.
