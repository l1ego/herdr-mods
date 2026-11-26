"""Tokens the coding agents on this machine used, for the token-usage Herdr mod.

Reads the agents' own session logs, from where it stopped last time:
- Claude Code: <config dir>/projects/**/*.jsonl, the `usage` of each assistant message. A message
  is written once per content block, and a resumed session copies earlier messages into its new
  file, so a request counts once by its message and request ids.
- Codex: <CODEX_HOME>/sessions and archived_sessions, rollout-*.jsonl. A `token_usage_record` is
  one request, counted once by its `response_id` (a forked rollout copies its parent's records).
  Older rollouts only have `token_count` snapshots: each counts its `last_token_usage`, once per
  cumulative total, so a copied snapshot isn't counted twice. The model comes from the latest
  `turn_context`.
- Kimi Code: ~/.kimi*/sessions/**/wire.jsonl, its `usage.record` lines.

Every request is a row in ~/.local/state/herdr-token-usage/usage.db (SQLite); what was read of
each file is kept there too, so the next run reads only what was added. A run stops after its
time budget and says how much is left; the mod calls it again.

Usage: tokens.py run '{"tz": <seconds east of UTC>, "days": 90, "budget": 20}'
       tokens.py reset
Prints one JSON object. Only the standard library; runs on Linux, macOS and Windows.
"""

import glob
import json
import os
import socket
import sqlite3
import sys
import time
from datetime import datetime, timezone

HOME = os.path.expanduser("~")
STATE = os.path.join(HOME, ".local", "state", "herdr-token-usage")
DB = os.path.join(STATE, "usage.db")
LOCK = os.path.join(STATE, "scan.lock")
LOCK_STALE = 15 * 60
COMMIT_EVERY = 20000  # lines between commits inside a big file

SCHEMA = """
CREATE TABLE IF NOT EXISTS req (
  key TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, tier TEXT NOT NULL,
  ts INTEGER NOT NULL, input INTEGER NOT NULL, cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL, output INTEGER NOT NULL,
  reasoning INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS req_ts ON req (ts);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY, offset INTEGER NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL,
  ctx TEXT NOT NULL
);
"""

UPSERT = """
INSERT INTO req (key, provider, model, tier, ts, input, cache_read, cache_write, cache_write_1h, output, reasoning)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (key) DO UPDATE SET
  input = max(input, excluded.input), cache_read = max(cache_read, excluded.cache_read),
  cache_write = max(cache_write, excluded.cache_write),
  cache_write_1h = max(cache_write_1h, excluded.cache_write_1h),
  output = max(output, excluded.output), reasoning = max(reasoning, excluded.reasoning)
"""


def n(value):
    """A token count: a non-negative int, else 0."""
    return int(value) if isinstance(value, (int, float)) and value > 0 else 0


def iso_seconds(text):
    try:
        return int(datetime.fromisoformat(str(text).replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


# --- Where the logs are ----------------------------------------------------------------------------


def claude_dirs():
    dirs = set()
    env = os.environ.get("CLAUDE_CONFIG_DIR", "")
    for d in [env, *env.split(os.pathsep), *glob.glob(os.path.join(HOME, ".claude*"))]:
        if d and os.path.isdir(os.path.join(d, "projects")):
            dirs.add(os.path.realpath(os.path.join(d, "projects")))
    return sorted(dirs)


def codex_dirs():
    home = os.environ.get("CODEX_HOME") or os.path.join(HOME, ".codex")
    return [os.path.realpath(os.path.join(home, d)) for d in ("sessions", "archived_sessions")
            if os.path.isdir(os.path.join(home, d))]


def kimi_dirs():
    return sorted({os.path.realpath(d) for d in glob.glob(os.path.join(HOME, ".kimi*", "sessions")) if os.path.isdir(d)})


def walk(root, keep):
    for folder, _dirs, files in os.walk(root):
        for name in files:
            if keep(name):
                yield os.path.join(folder, name)


def sources():
    """(provider, path) of every log file, newest first."""
    found = {}
    for root in claude_dirs():
        for p in walk(root, lambda f: f.endswith(".jsonl")):
            found[p] = "claude"
    for root in codex_dirs():
        for p in walk(root, lambda f: f.startswith("rollout-") and f.endswith(".jsonl")):
            found[p] = "codex"
    for root in kimi_dirs():
        for p in walk(root, lambda f: f == "wire.jsonl"):
            found[p] = "kimi"
    out = []
    for p, provider in found.items():
        try:
            st = os.stat(p)
        except OSError:
            continue
        out.append((provider, p, st))
    out.sort(key=lambda x: x[2].st_mtime, reverse=True)
    return out


# --- Reading one line ------------------------------------------------------------------------------
# Each returns the row for UPSERT, or None. `ctx` is the file's carried state (model, ledger).


def claude_line(line, _ctx):
    if b'"usage"' not in line:
        return None
    d = json.loads(line)
    msg = d.get("message")
    usage = msg.get("usage") if isinstance(msg, dict) else None
    if not isinstance(usage, dict):
        return None
    model = msg.get("model") or "unknown"
    if model == "<synthetic>":
        return None
    ts = iso_seconds(d.get("timestamp"))
    if ts is None:
        return None
    mid, rid = msg.get("id"), d.get("requestId")
    key = f"c:{mid}:{rid}" if (mid or rid) else f"c:{d.get('uuid')}"
    one_hour = n((usage.get("cache_creation") or {}).get("ephemeral_1h_input_tokens"))
    thinking = n((usage.get("output_tokens_details") or {}).get("thinking_tokens"))
    tier = usage.get("speed") or "standard"
    return (key, "claude", model, tier, ts, n(usage.get("input_tokens")), n(usage.get("cache_read_input_tokens")),
            n(usage.get("cache_creation_input_tokens")), one_hour, n(usage.get("output_tokens")), thinking)


def codex_row(key, ctx, ts, u):
    # Codex's input_tokens include the cached reads and the cache writes.
    cached, written = n(u.get("cached_input_tokens")), n(u.get("cache_write_input_tokens"))
    fresh = max(0, n(u.get("input_tokens")) - cached - written)
    return (key, "codex", ctx.get("model") or "unknown", ctx.get("tier") or "standard", ts, fresh, cached, written, 0,
            n(u.get("output_tokens")), n(u.get("reasoning_output_tokens")))


def codex_line(line, ctx):
    if b'"token_usage_record"' in line:
        d = json.loads(line)
        if d.get("type") != "token_usage_record":
            return None
        p = d.get("payload") or {}
        u = p.get("usage")
        ts = iso_seconds(d.get("timestamp"))
        if not isinstance(u, dict) or ts is None:
            return None
        ctx["ledger"] = True
        rid = p.get("response_id") or f"{p.get('turn_id')}:{json.dumps(p.get('thread_token_usage'), sort_keys=True)}"
        return codex_row(f"x:{rid}", ctx, ts, u)
    if b'"turn_context"' in line:
        d = json.loads(line)
        if d.get("type") == "turn_context":
            p = d.get("payload") or {}
            if p.get("model"):
                ctx["model"] = p["model"]
            if p.get("service_tier"):
                ctx["tier"] = p["service_tier"]
        return None
    if b'"token_count"' in line and not ctx.get("ledger"):
        d = json.loads(line)
        p = d.get("payload") or {}
        info = p.get("info") if p.get("type") == "token_count" else None
        if not isinstance(info, dict):
            return None
        last, total = info.get("last_token_usage") or {}, info.get("total_token_usage") or {}
        ts = iso_seconds(d.get("timestamp"))
        if not n(last.get("total_tokens")) or ts is None:
            return None
        counters = ",".join(str(n(total.get(k))) for k in
                            ("input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"))
        return codex_row(f"xc:{counters}", ctx, ts, last)
    return None


def kimi_line(line, _ctx):
    if b'"usage.record"' not in line:
        return None
    d = json.loads(line)
    u = d.get("usage")
    if d.get("type") != "usage.record" or not isinstance(u, dict) or not isinstance(d.get("time"), (int, float)):
        return None
    model = str(d.get("model") or "unknown")
    values = (n(u.get("inputOther")), n(u.get("inputCacheRead")), n(u.get("inputCacheCreation")), n(u.get("output")))
    key = f"k:{d['time']}:{model}:{d.get('agentId')}:{values}"
    return (key, "kimi", model, "standard", int(d["time"] / 1000), values[0], values[1], values[2], 0, values[3], 0)


READERS = {"claude": claude_line, "codex": codex_line, "kimi": kimi_line}


# --- Scanning --------------------------------------------------------------------------------------


def scan_file(db, provider, path, st, row, deadline):
    """Reads what was added to one file. Returns False when the time ran out inside it."""
    offset, ctx = 0, {}
    if row and st.st_size >= row[0]:
        offset, ctx = row[0], json.loads(row[1])
    reader = READERS[provider]
    done = True
    with open(path, "rb") as f:
        f.seek(offset)
        count = 0
        for line in f:
            if not line.endswith(b"\n"):
                break  # still being written: read it next time
            offset += len(line)
            try:
                r = reader(line, ctx)
            except (ValueError, TypeError, AttributeError, KeyError):
                r = None
            if r:
                db.execute(UPSERT, r)
            count += 1
            if count % COMMIT_EVERY == 0:
                save(db, path, offset, st, ctx, partial=True)
                db.commit()
                if time.monotonic() > deadline:
                    done = False
                    break
    save(db, path, offset, st, ctx, partial=not done)
    db.commit()
    return done


def save(db, path, offset, st, ctx, partial):
    # A partly read file keeps size -1, so the next run doesn't take it as unchanged.
    db.execute("INSERT OR REPLACE INTO files (path, offset, size, mtime, ctx) VALUES (?, ?, ?, ?, ?)",
               (path, offset, -1 if partial else st.st_size, st.st_mtime, json.dumps(ctx)))


def scan(db, budget):
    deadline = time.monotonic() + budget
    known = {p: (o, c, s, m) for p, o, s, m, c in db.execute("SELECT path, offset, size, mtime, ctx FROM files")}
    files = sources()
    left = 0
    for provider, path, st in files:
        row = known.get(path)
        if row and row[2] == st.st_size and row[3] == st.st_mtime:
            continue
        if time.monotonic() > deadline:
            left += st.st_size - (row[0] if row and st.st_size >= row[0] else 0)
            continue
        try:
            if not scan_file(db, provider, path, st, row, deadline):
                read = db.execute("SELECT offset FROM files WHERE path = ?", (path,)).fetchone()[0]
                left += st.st_size - read
        except OSError:
            continue
    return {"files": len(files), "left": left}


def locked():
    """Takes the scan lock, or returns None when another run holds it."""
    try:
        if time.time() - os.stat(LOCK).st_mtime > LOCK_STALE:
            os.remove(LOCK)
    except OSError:
        pass
    try:
        fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return None
    os.write(fd, str(os.getpid()).encode())
    os.close(fd)
    return LOCK


# --- Summary ---------------------------------------------------------------------------------------

COLUMNS = "count(*), sum(input), sum(cache_read), sum(cache_write), sum(cache_write_1h), sum(output), sum(reasoning)"


def summary(db, tz, days):
    now = int(time.time())
    since = now - days * 86400
    daily = [list(r) for r in db.execute(
        f"SELECT date(ts + ?, 'unixepoch') AS day, provider, model, tier, {COLUMNS} FROM req WHERE ts >= ? "
        "GROUP BY day, provider, model, tier ORDER BY day", (tz, since))]
    total = [list(r) for r in db.execute(
        f"SELECT provider, model, tier, {COLUMNS} FROM req GROUP BY provider, model, tier")]
    recent = [list(r) for r in db.execute(
        f"SELECT provider, {COLUMNS} FROM req WHERE ts >= ? GROUP BY provider", (now - 5 * 3600,))]
    first = db.execute("SELECT min(ts) FROM req").fetchone()[0]
    return {
        "today": datetime.fromtimestamp(now + tz, timezone.utc).strftime("%Y-%m-%d"),
        "daily": daily,
        "total": total,
        "recent": recent,
        "first": first,
        "sources": {"claude": claude_dirs(), "codex": codex_dirs(), "kimi": kimi_dirs()},
    }


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    os.makedirs(STATE, exist_ok=True)
    if cmd == "reset":
        for p in (DB, DB + "-wal", DB + "-shm", LOCK):
            if os.path.exists(p):
                os.remove(p)
        print(json.dumps({"reset": True}))
        return
    db = sqlite3.connect(DB, timeout=60)
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript(SCHEMA)
    started = time.monotonic()
    lock = locked()
    if lock:
        try:
            state = scan(db, float(args.get("budget", 20)))
        finally:
            os.remove(lock)
    else:
        state = {"busy": True}
    out = summary(db, int(args.get("tz", 0)), int(args.get("days", 90)))
    out.update(state)
    out["machine"] = socket.gethostname()
    out["seconds"] = round(time.monotonic() - started, 2)
    print(json.dumps(out, separators=(",", ":")))


if __name__ == "__main__":
    main()
