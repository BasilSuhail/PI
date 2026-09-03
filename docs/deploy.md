# Deploy notes

The commands you actually run are in the [README](../README.md): `make
dashboard`, `make agents`, `make check`. This is what sits behind them.

Every command on this page runs **on the Mac**, from `~/folders/PI`. The parts
that happen on a board — the git pull, the build, the systemd install — are run
there by a script that `make` or `ssh` started. Nothing here is meant to be
typed into a board's own shell.

## The shape

Deploys are a **pull on the board**, not a push from the Mac. Each node holds a
read-only checkout of this repo at `~/PI`; a deploy is:

```
fetch origin → reset --hard origin/main → build on the board → install
```

Three consequences worth knowing:

- **The board is never a source of truth.** `reset --hard` means anything
  edited directly on the node is gone at the next deploy. Edit the repo, open a
  PR, merge, deploy. This is deliberate: the old installer protected
  node-side edits by never overwriting `apps.json`, and the cost was that the
  OSINT News tile merged in #21 silently never arrived.
- **The Mac's checkout does not matter to a deploy.** The board pulls from
  GitHub itself, so `make dashboard` ships what is on `main` whether or not the
  Mac has pulled. Pull on the Mac to get new *targets*, not new code.
- **It builds on the board.** The boards are arm64; cross-building from the Mac
  buys nothing and risks shipping the wrong architecture. A dashboard build
  takes a few minutes.

`git log --oneline -1` runs as part of every deploy, so the commit that just
landed is printed before the build starts.

## Bootstrapping a node

```bash
make bootstrap NODE=jug2
```

Run once per node, and again only after a reimage. It is idempotent — a second
run verifies rather than replaces. What it does, in order:

1. Generates an ed25519 key on the node at `~/.ssh/id_PI_deploy` if absent.
2. Registers the public half as a **read-only deploy key** on the repo, via
   `gh`, from the Mac. Read-only: the board can pull and can never push.
3. Adds a `Host PI.github` alias to the node's SSH config so that key is used
   for this repo only, rather than becoming the node's default GitHub identity.
4. Clones to `~/PI`, or fast-forwards it if already there.

It reuses one SSH connection for all three remote steps, so the board's
password is asked for once rather than three times.

The repo is private, which is the whole reason for the deploy key. The key
never leaves the board; only the public half is sent to GitHub.

## When GitHub is unreachable from the board

The push-based flow still works and needs no checkout on the node:

```bash
cd ~/folders/PI
rsync -a --delete --exclude node_modules --exclude dist dashboard/ jug2:~/dashboard/
scp deploy/install-dashboard.sh jug2:~/
ssh jug2 'bash ~/install-dashboard.sh'
```

Copied on its own like that, the installer cannot see `k8s/`, so it leaves the
cluster role labels as they are and says so. To set them up this way, send the
directory too and run the script from inside a copy of the tree.

Copy the installer every time rather than running the copy already on the
board — it carries the migrations, and a stale copy is how the service ended up
broken twice. `--exclude dist` matters: the node builds its own, and a
Mac-built one is the wrong architecture.

For the agents, send the whole `agent/` directory, not just the script:
`install.sh` installs `pi-metrics.py` and `pi-metrics.service` from alongside
itself.

## Other one-time setup

Archive tree on jug2:

```bash
scp deploy/setup-archive.sh jug2:~/ && ssh jug2 'bash ~/setup-archive.sh'
```

Exposing the dashboard on the tailnet (already done). Which port depends on
which of the two installs holds it:

```bash
ssh jug2 'sudo tailscale serve --bg 8080'   # systemd unit, listening itself
ssh jug2 'sudo tailscale serve --bg 80'     # Deployment, behind Traefik
```

`make dashboard-k8s` repoints this to 80 on its way out. `make dashboard` does
**not** repoint it back, so returning to systemd means setting 8080 by hand or
the tailnet URL answers nothing.

Either way it lands at `https://jug2.taild9f605.ts.net` — tailnet-only, real
certificate, no open ports.

## Services beyond the dashboard

```bash
make uptime
```

The first of these installs the Tailscale operator as well, through k3s'
bundled helm-controller so nothing extra is needed on the board. After that,
any Service with an Ingress marked `ingressClassName: tailscale` gets its own
tailnet name and certificate, which is what lets a second app exist without
fighting the console for `/`.

The operator's OAuth client is asked for once and stored as a Secret. See the
README section for the tag owners it needs first.

## When something is wrong

```bash
make check                                  # which install holds the dashboard
make logs                                   # its last 40 lines, systemd or k3s
ssh jug 'journalctl -u glances -n 40 --no-pager'
```

`active` with nothing listening means the process started and exited without a
traceback. Check the port before believing the unit — 8080 is the systemd
install serving directly, 80 is Traefik fronting the Deployment:

```bash
ssh jug2 'ss -lntp | grep -E ":(80|8080|61208|9101)\b"'
```

A deploy that runs clean but changes nothing on screen — check what actually
landed, and which commit the board is on:

```bash
ssh jug2 'git -C ~/PI log --oneline -1'
ssh jug2 'cat /opt/jug-console/dist/apps.json'    # systemd install
```

Under k3s the image tag *is* the commit, so it answers the same question
directly:

```bash
ssh jug2 'sudo k3s kubectl -n jug get deploy jug-console \
  -o jsonpath="{.spec.template.spec.containers[0].image}"; echo'
```

If a bootstrap fails at the GitHub step, the node's key exists but is not
registered. `gh repo deploy-key list --repo BasilSuhail/PI` shows what is
registered; re-running `make bootstrap NODE=jug2` reuses the same key.
