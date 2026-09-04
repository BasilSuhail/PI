#!/usr/bin/env python3
"""News from the OSINT board into Discord (#127).

Uptime Kuma says when something breaks. This says when something happens.

Runs as a CronJob in the cluster and reads the board over HTTP, exactly the way
Kuma reads it. The board is not modified and does not know this exists. That is
the point: the stack it runs serves continuously, and the branch it runs is a
large open pull request. A reader is a safer shape than a change.

## What earns a message

Two questions the board already answers, used for two different jobs.

`/stories/developing` is the console's pinned slot. Its gates are declared in
the board's own code and not tuned at read time: harm severity at least 0.6, at
least three independent tellers, at least one new member in twelve hours, and at
least a day old. Clearing all four is rare. That is the alert.

`/stories/top` is the reading page's feed. Clustering on the board runs twice an
hour, so its newest two rows change up to 48 times a day. Alerting on those
would be a firehose, so they are never a trigger. They ride along inside a pin's
message as context, which costs nothing and keeps the message at two or three
titles.

## Why a story is announced once

The pinned slot holds a story for as long as it keeps gathering coverage, so
every run would otherwise re-send the same three. `announced.json` on the volume
records the ids already sent; entries expire after the board's own story
retention window, so the file stays bounded and a story cannot come back around
under an id that was reused.

## Why dry run does everything but post

`DRY_RUN` replaces the POST with a log line and changes nothing else, state
included. A dry run that did not record would print the same stories every half
hour and teach nothing; recording means the log shows the real arrival rate,
which is the number nobody has measured yet. The cost is that arming it later
will not re-send whatever was seen during the dry run. That is correct: those
are not new.

A failed post is not recorded, so the next run tries again rather than silently
dropping the one message that mattered.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

#: Kept well under Discord's own ceilings (256 for a title, 4096 for a
#: description) rather than at them. A headline cut at exactly the limit reads
#: as a bug; cut short with an ellipsis it reads as a headline.
TITLE_MAX = 220
GIST_MAX = 400

#: Amber when the board's own gist called the story escalating, otherwise the
#: console's cyan. Colour is the only thing in the message that is not a
#: measurement, so it repeats a measurement rather than adding a judgement.
COLOUR_ESCALATING = 0xE0A03C
COLOUR_NORMAL = 0x3BA9C4

HTTP_TIMEOUT_S = 20.0


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _env_int(name: str, default: int) -> int:
    raw = _env(name)
    try:
        return int(raw) if raw else default
    except ValueError:
        print(f"warn: {name}={raw!r} is not a number, using {default}", file=sys.stderr)
        return default


def _log(message: str) -> None:
    """Timestamped, to stdout. `kubectl logs` on a completed job is the only
    place these are read, and a job's lines have no clock of their own."""
    print(f"{datetime.now(UTC).strftime('%Y-%m-%d %H:%M:%SZ')}  {message}", flush=True)


def _get_json(url: str, token: str) -> Any:
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    if token:
        # X-API-Key rather than a bearer, because the board documents this one
        # as the header for scripts and probes.
        request.add_header("X-API-Key", token)
    with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_S) as response:
        return json.loads(response.read().decode("utf-8"))


def _post_json(url: str, payload: dict[str, Any]) -> int:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_S) as response:
        return response.status


def _truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _clip(text: str | None, limit: int) -> str:
    """One line, trimmed to fit. Collapses every run of whitespace, newlines
    included, because a headline that wraps inside an embed field is a headline
    that has broken the layout.

    Deliberately not used on a block that is meant to have lines in it — see
    `news_embed`, which was flattened into a single paragraph by exactly this.
    """
    if not text:
        return ""
    return _truncate(" ".join(text.split()), limit)


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _age(value: str | None, now: datetime) -> str:
    """How long ago, in the console's own vocabulary. Unknown stays unknown."""
    moment = _parse_time(value)
    if moment is None:
        return "—"
    minutes = int((now - moment).total_seconds() // 60)
    if minutes < 1:
        return "now"
    if minutes < 60:
        return f"{minutes}m ago"
    hours = minutes // 60
    if hours < 48:
        return f"{hours}h ago"
    return f"{hours // 24}d ago"


def load_state(path: Path, ttl_days: int, now: datetime) -> dict[str, str]:
    """Announced story ids, with anything past the retention window dropped.

    A missing or unreadable file is an empty state, never a crash. The first run
    has no file, and a truncated one is not worth losing a night's alerts over —
    the cost of being wrong here is at most one repeated message.
    """
    try:
        raw = json.loads(path.read_text())
    except FileNotFoundError:
        return {}
    except (OSError, json.JSONDecodeError) as exc:
        print(f"warn: state at {path} unreadable ({exc}), starting empty", file=sys.stderr)
        return {}

    announced = raw.get("announced") if isinstance(raw, dict) else None
    if not isinstance(announced, dict):
        return {}

    cutoff = now - timedelta(days=ttl_days)
    kept: dict[str, str] = {}
    for story_id, sent_at in announced.items():
        moment = _parse_time(sent_at if isinstance(sent_at, str) else None)
        if moment is not None and moment >= cutoff:
            kept[str(story_id)] = sent_at
    return kept


def save_state(path: Path, announced: dict[str, str]) -> None:
    """Write via a neighbour and rename, so a job killed mid-write leaves the
    previous state rather than a half file that the next run discards."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"announced": announced}, indent=2, sort_keys=True))
    temporary.replace(path)


def evidence_line(story: dict[str, Any]) -> str:
    """The board's reasons for the pin, in one line, in its own numbers."""
    reasons = story.get("pin_reasons") or {}
    parts: list[str] = []
    severity = reasons.get("max_severity")
    if isinstance(severity, (int, float)):
        parts.append(f"severity {severity:.2f}")
    owners = story.get("owner_count")
    if isinstance(owners, int):
        parts.append(f"{owners} independent tellers")
    fresh = reasons.get("new_members_12h")
    if isinstance(fresh, int):
        parts.append(f"{fresh} new in 12h")
    age = reasons.get("age_hours")
    if isinstance(age, int):
        parts.append(f"{age}h old" if age < 48 else f"{age // 24}d old")
    return " · ".join(parts) or "—"


def pin_embed(story: dict[str, Any]) -> dict[str, Any]:
    escalating = story.get("escalating") == "escalating"
    countries = [c for c in (story.get("countries") or []) if c]
    fields = [{"name": "Why it is pinned", "value": _clip(evidence_line(story), 400)}]
    if countries:
        fields.append({"name": "Where", "value": _clip(", ".join(countries), 400), "inline": True})
    if story.get("category"):
        fields.append({"name": "Tag", "value": _clip(story["category"], 60), "inline": True})
    return {
        "title": _clip(story.get("title"), TITLE_MAX) or "(untitled story)",
        "description": _clip(story.get("gist"), GIST_MAX),
        "color": COLOUR_ESCALATING if escalating else COLOUR_NORMAL,
        "fields": fields,
    }


def news_embed(headlines: list[dict[str, Any]], news_url: str, now: datetime) -> dict[str, Any]:
    """The context section. Empty is said out loud rather than left blank."""
    if headlines:
        lines = [
            f"`{_age(row.get('last_seen'), now):>8}`  {_clip(row.get('title'), 180)}"
            for row in headlines
        ]
    else:
        lines = ["Nothing else in the window."]
    if news_url:
        lines.append(f"\n[Open the reading page]({news_url})")
    return {
        "title": "Also in the last 48h",
        # Truncated, not clipped: the lines are the point here.
        "description": _truncate("\n".join(lines), 3000),
        "color": COLOUR_NORMAL,
    }


def build_payload(
    pins: list[dict[str, Any]],
    headlines: list[dict[str, Any]],
    news_url: str,
    now: datetime,
) -> dict[str, Any]:
    return {
        "username": "OSINT",
        "embeds": [pin_embed(story) for story in pins] + [news_embed(headlines, news_url, now)],
    }


def newest_unpinned(top: list[dict[str, Any]], pinned_ids: set[str], count: int) -> list[dict]:
    """The reading page's own rule: pinned rows removed, then newest first.

    A pinned story appearing again underneath its own alert would read as two
    stories, which is the mistake the console already avoids.
    """
    rest = [row for row in top if str(row.get("id")) not in pinned_ids]
    # A row with an unreadable timestamp sorts last rather than crashing the
    # run: the feed is context, and losing the alert over it would be backwards.
    oldest = datetime.min.replace(tzinfo=UTC)
    rest.sort(key=lambda row: _parse_time(row.get("last_seen")) or oldest, reverse=True)
    return rest[:count]


def main() -> int:
    base_url = _env("OSINT_BASE_URL").rstrip("/")
    if not base_url:
        print("OSINT_BASE_URL is not set — nothing to read.", file=sys.stderr)
        return 2

    token = _env("OSINT_API_TOKEN")
    webhook = _env("DISCORD_WEBHOOK_URL")
    # Absent means dry run whatever the flag says. There is no configuration
    # that posts to nowhere, and a missing webhook is the likeliest install
    # mistake — it should degrade to the safe mode, not to a stack trace.
    dry_run = _env("DRY_RUN", "true").lower() not in {"false", "0", "no"} or not webhook
    if not webhook:
        _log("no webhook configured — dry run")

    developing_limit = _env_int("DEVELOPING_LIMIT", 3)
    news_lines = _env_int("NEWS_LINES", 2)
    top_hours = _env_int("TOP_HOURS", 48)
    ttl_days = _env_int("STATE_TTL_DAYS", 30)
    state_path = Path(_env("STATE_PATH", "/state/announced.json"))

    now = datetime.now(UTC)
    announced = load_state(state_path, ttl_days, now)

    try:
        developing = _get_json(
            f"{base_url}/api/stories/developing?limit={developing_limit}", token
        )
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
        print(f"could not read the pinned stories: {exc}", file=sys.stderr)
        return 1

    if not isinstance(developing, list):
        print(f"unexpected shape from /stories/developing: {type(developing).__name__}", file=sys.stderr)
        return 1

    pinned_ids = {str(story.get("id")) for story in developing}
    fresh = [story for story in developing if str(story.get("id")) not in announced]

    _log(f"{len(developing)} pinned, {len(fresh)} of them new")
    if not fresh:
        # Still written: the load above dropped anything past the window, and
        # not saving would leave the file growing for as long as nothing new
        # ever pins.
        save_state(state_path, announced)
        return 0

    headlines: list[dict[str, Any]] = []
    try:
        top = _get_json(f"{base_url}/api/stories/top?hours={top_hours}&limit=60", token)
        if isinstance(top, list):
            headlines = newest_unpinned(top, pinned_ids, news_lines)
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as exc:
        # The context section is not worth losing the alert over. Say what is
        # missing and send the pins.
        print(f"warn: could not read the feed, sending without it: {exc}", file=sys.stderr)

    payload = build_payload(fresh, headlines, f"{base_url}/news", now)

    if dry_run:
        _log("DRY RUN — would have posted:")
        print(json.dumps(payload, indent=2, ensure_ascii=False), flush=True)
    else:
        try:
            status = _post_json(webhook, payload)
        except (urllib.error.URLError, OSError) as exc:
            # Deliberately not recorded, so the next run tries again.
            print(f"discord refused the message: {exc}", file=sys.stderr)
            return 1
        _log(f"posted {len(fresh)} story(ies) and {len(headlines)} headline(s) — HTTP {status}")

    for story in fresh:
        announced[str(story.get("id"))] = now.isoformat()
    save_state(state_path, announced)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
