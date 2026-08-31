# Deploy notes

The two commands you actually run are in the [README](../README.md). This is
everything that sits behind them: the one-time setup, why the commands are
shaped the way they are, and what to do when a deploy does not take.

## Why the dashboard deploy looks like that

```bash
rsync -a --delete --exclude node_modules --exclude dist dashboard/ jug2:~/dashboard/
scp deploy/install-dashboard.sh jug2:~/
ssh jug2 'bash ~/install-dashboard.sh'
```

- **It builds on the board.** The boards are arm64. Cross-building from the Mac
  buys nothing and risks shipping the wrong architecture, which is what
  `--exclude dist` prevents — the node builds its own.
- **Copy the installer every time**, rather than running the copy already on
  jug2. It carries the migrations, and a stale copy is how the service ended up
  broken twice.
- **`apps.json` travels with it.** The launcher config is part of the build, so
  a tile added to `dashboard/server/apps.json` lands on the next deploy. It used
  to be seeded once and then left alone; that protected tiles edited on the node
  but silently dropped tiles added in the repo, which is how the OSINT News tile
  went missing after it was merged. The repo is the source of truth now — edit
  it there, not on the board.
- **The whole `agent/` directory**, not just the script: `install.sh` installs
  `pi-metrics.py` and `pi-metrics.service` from alongside itself.

`apps.json` is read on every request, so a tile change needs no rebuild and no
restart — the install does both anyway.

## One-time setup

Archive tree on jug2:

```bash
cd ~/folders/PI
scp deploy/setup-archive.sh jug2:~/
ssh jug2 'bash ~/setup-archive.sh'
```

Exposing the dashboard on the tailnet (already done):

```bash
ssh jug2 'sudo tailscale serve --bg 8080'
```

That puts it at `https://jug2.taild9f605.ts.net` — tailnet-only, real
certificate, no open ports.

## When something is wrong

```bash
ssh jug2 'journalctl -u jug-console -n 40 --no-pager'
ssh jug  'journalctl -u glances -n 40 --no-pager'
```

`active` with nothing listening means the process started and exited without a
traceback. Check the port before believing the unit:

```bash
ssh jug2 'ss -lntp | grep -E "8080|61208|9101"'
```

A deploy that runs clean but changes nothing on screen is worth one check of
what actually landed:

```bash
ssh jug2 'cat /opt/jug-console/dist/apps.json; ls -l /opt/jug-console/dist'
```
