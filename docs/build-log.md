# Build log

What has actually been done to the boards, in order, with the reasoning. Issue #5 is the plan; this is the record.

Convention: `pi1` is the 8GB board, `pi2` the 16GB board. Names follow the storage, not the silicon.

---

## Boards as they stand

| | pi1 | pi2 |
|---|---|---|
| RAM | 8GB | 16GB |
| Boot | SD card, `/boot/firmware` only — must stay in the slot | 1TB SSD |
| Root | 512GB SATA SSD on Waveshare PCIe HAT | same 1TB SSD |
| Bulk | 8TB HDD — **blocked on 12V** | — |
| LAN | see `~/.ssh/config` on the Mac | same |
| OS | Debian 13 trixie, aarch64, 4 cores | same |
| Runs | OSINT stack (Docker Compose), `llama-server` | k3s server |
| Role | untouched. Docker Compose only. | cluster control plane |

DHCP assigns both addresses; they are not reserved. Worth pinning in the home router at some point.

---

## 1. SSH access to pi2

New board had no key access. Ended up on password auth by choice — key auth was set up, then deliberately reverted.

`~/.ssh/config` on the Mac now carries:

```
Host pi
    HostName <pi1-lan>
    User pi
    PubkeyAuthentication no

Host pi2
    HostName <pi2-lan>
    User pi
    PubkeyAuthentication no
```

`PubkeyAuthentication no` is doing real work: an older passphrase-protected key exists on the Mac whose passphrase is unknown. Without this, ssh offers that key, the server accepts it as a candidate, and the client blocks on a passphrase prompt that can never be satisfied. Forcing password auth skips the whole path.

Two leftovers on pi2, harmless but worth clearing eventually:

- `~/.ssh/authorized_keys` holds two public keys whose private halves are unused
- `~/.ssh/id_ed25519_pi` on the Mac — a passphraseless key that was generated, then abandoned

Config backups: `~/.ssh/config.bak*` on the Mac, four of them.

**Consequence:** every remote command is interactive. Nothing can be scripted against the boards over SSH.

---

## 2. cgroups on pi2

Pi kernels boot with cgroup memory accounting disabled. Two effects, one of which was live on pi1 and unnoticed:

1. k3s installs, reports Ready, and then never schedules a pod. Nothing in the error mentions cgroups.
2. **`mem_limit` in every Compose file is silently ignored.** `docker stats` on pi1 reports `0B / 0B` for all six OSINT containers — the kernel declining to account, not Docker declining to display.

That second one means guard #2 in issue #1 has never been in force. `llama-server` runs outside Docker at 3.2GB and is the largest process on pi1, so it is what the OOM killer selects. Exactly the failure that guard was written to prevent.

Applied to pi2:

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

**pi1 has not had this applied.** Its memory limits remain unenforced.

---

## 3. k3s server on pi2

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--write-kubeconfig-mode 644" sh -
```

Installed **v1.36.4+k3s1**, containerd 2.3.4.

`--write-kubeconfig-mode 644` lets the `pi` user read the kubeconfig without sudo. Convenience only.

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
pi2   Ready    control-plane   v1.36.4+k3s1
```

`helm-install-traefik` errored twice before completing — a race against the CRD job on first start. It self-corrected without intervention; RESTARTS 2 then `Completed`.

### Cost

| | RAM | CPU |
|---|---|---|
| pi2 before k3s | 327Mi | — |
| pi2 with k3s idle | 1.0Gi (`kubectl top`: 852Mi) | 54m, 1% |
| plus 5 nginx pods | 913Mi | 89m, 2% |

**Control plane ≈ 700MB.** Five containers on top cost ~60MB. The overhead is the orchestrator, not the workloads — which is the argument for keeping the cluster to one node until something actually needs to move.

---

## 4. kubectl from the Mac

```bash
brew install kubectl                                        # kubernetes-cli 1.37.0
ssh pi2 'cat /etc/rancher/k3s/k3s.yaml' > ~/.kube/config-pi2
chmod 600 ~/.kube/config-pi2
sed -i '' 's|<loopback>|pi2|' ~/.kube/config-pi2
```

`KUBECONFIG` exported in `~/.zshrc`.

The `sed` is required: k3s writes the server as the loopback address, which resolves to the wrong machine when the file is read anywhere but the Pi.

Home LAN only. The cluster's TLS certificate carries pi2's LAN address, so connecting via any other name fails the cert check. A `tls-san` entry would fix that if remote `kubectl` is ever wanted.

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

## Security posture

| | |
|---|---|
| API server `:6443` | LAN only. No router forwarding. |
| Unauthenticated request | `401 Unauthorized` — verified |
| Auth | TLS client certificate. No password, nothing to brute-force. |
| Cert scope | `cluster-admin`, unrestricted |
| `~/.kube/config-pi2` | mode 600 |

The exposure is not the API server. It is the kubeconfig itself: plaintext admin credentials with no expiry. A `.gitignore` covering kubeconfigs, tokens, keys, env files and disk images landed with this file.

SSH remains password-authenticated on both boards, which is the weaker of the two doors.

---

## Open

- [ ] **12V supply for the 8TB.** £15–25. Blocks the entire archive tier — Samba, Kiwix, Jellyfin, Calibre-Web. Highest value item on the list.
- [ ] **`tailscale up --hostname=pi2`.** Tailscale is installed on pi2 but logged out. Nothing on pi2 is reachable from a phone until this runs.
- [ ] **cgroup flag on pi1.** Its `mem_limit`s are unenforced today.
- [ ] Dashboard — separate issue. System stats plus app launcher, served over Tailscale.
- [ ] DHCP reservations for both boards in the home router.
- [ ] Clear the two dead public keys from pi2's `authorized_keys`.
- [ ] Image pi1's SD card. It is boot-only and holds no data, but its loss means the board will not start.

Deferred by decision, not oversight:

- **pi1 joining the cluster.** Waits until `llama-server` moves to the Mac Mini and pi1's real free RAM can be measured, since `--kubelet-arg=system-reserved` must be a measured number. A scheduler that cannot see Docker will place pods into RAM that OSINT already holds.
- **Migrating OSINT into k8s.** Not planned. Issue #2 settled it: containers pinned to their own disk gain nothing from an orchestrator.
