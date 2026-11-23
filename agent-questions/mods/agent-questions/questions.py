"""Finds the questions coding agents asked and are still waiting on.

The agent-questions mod runs this with `python3 -I -c <this file> list '<terminals json>'` on the
machine where the agents run, so nothing has to be installed there. It prints JSON:
[{key, agent, terminal, asked, turn, questions: [{index, title, options}], answerable}]

Codex: `request_user_input_async` questions from the session's rollout. Codex closes their card
when its turn ends, but the question stays here until it is answered (a
`<send_user_message_question_reply>` naming it) or the person sends another message.
Claude Code: `AskUserQuestion` calls without a result yet (they wait in the terminal).

Rollouts grow to hundreds of MB, so each file is read from where the last run stopped; what was
found so far is kept in ~/.local/state/herdr-agent-questions/cache.json.
"""

import glob
import json
import os
import re
import sys
import time

HOME = os.path.expanduser("~")
STATE = os.path.join(os.environ.get("XDG_STATE_HOME") or os.path.join(HOME, ".local", "state"), "herdr-agent-questions")
CACHE = os.path.join(STATE, "cache.json")
VERSION = 1
FIRST_READ = 32 * 1024 * 1024  # a file seen for the first time is read from its last 32 MB
MAX_AGE = 3 * 24 * 3600  # older questions are dropped
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
REPLY = re.compile(r"<send_user_message_question_reply>(.*?)</send_user_message_question_reply>", re.S)


def stamp(text):
    """ISO time from a rollout or transcript line, as epoch seconds."""
    try:
        return time.mktime(time.strptime(text[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone
    except (TypeError, ValueError):
        return time.time()


def load_cache():
    try:
        with open(CACHE) as f:
            data = json.load(f)
        if data.get("version") == VERSION:
            return data
    except (OSError, ValueError):
        pass
    return {"version": VERSION, "files": {}}


def save_cache(cache):
    os.makedirs(STATE, exist_ok=True)
    tmp = CACHE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cache, f)
    os.replace(tmp, CACHE)


def new_lines(path, entry):
    """Complete lines added since the last read; moves entry["offset"] past them."""
    size = os.path.getsize(path)
    offset = entry.get("offset")
    if offset is None or offset > size:
        offset = max(0, size - FIRST_READ)
        entry.setdefault("pending", {}).clear()  # the same dict the scanner holds
    with open(path, "rb") as f:
        f.seek(offset)
        if offset and entry.get("offset") is None:
            f.readline()  # started mid-file: skip the partial line
        data = f.read()
        start = f.tell() - len(data)
    end = data.rfind(b"\n") + 1
    entry["offset"] = start + end
    return data[:end].decode("utf-8", "replace").splitlines()


def user_text(payload):
    parts = payload.get("content") or []
    return "".join(p.get("text", "") for p in parts if isinstance(p, dict))


# --- Codex -------------------------------------------------------------------------------------

def codex_rollout(terminal):
    """The newest rollout of the session in this terminal, from its `resume` label."""
    label = (terminal.get("labels") or {}).get("resume", "")
    ids = UUID.findall(label)
    if not ids:
        return None
    files = glob.glob(os.path.join(HOME, ".codex", "sessions", "*", "*", "*", f"rollout-*{ids[-1]}*.jsonl"))
    return max(files, key=os.path.getmtime) if files else None


def scan_codex(path, entry):
    pending = entry.setdefault("pending", {})
    for line in new_lines(path, entry):
        # Tool results don't name their tool: only parse those of a question still pending.
        is_output = '"function_call_output"' in line[:300] and any(f'"call_id":"{c}"' in line for c in pending)
        if not is_output and not any(k in line for k in ("request_user_input_async", '"task_complete"', '"turn_aborted"', '"role":"user"')):
            continue
        try:
            o = json.loads(line)
        except ValueError:
            continue
        p = o.get("payload") or {}
        kind = p.get("type")
        if kind == "function_call" and p.get("name") == "request_user_input_async":
            try:
                qs = json.loads(p.get("arguments") or "{}").get("questions") or []
            except ValueError:
                continue
            questions = [
                {"index": i, "title": str(q.get("title") or q.get("question") or ""), "options": [str(x) for x in q.get("options") or []]}
                for i, q in enumerate(qs) if isinstance(q, dict)
            ]
            if questions:
                pending[p.get("call_id")] = {"asked": stamp(o.get("timestamp")), "turn": "open", "questions": questions}
        elif kind == "function_call_output" and p.get("call_id") in pending:
            if "accepted" not in str(p.get("output")):
                del pending[p["call_id"]]  # rejected or failed: never shown to the person
        elif o.get("type") == "event_msg" and kind in ("task_complete", "turn_aborted"):
            for q in pending.values():
                q["turn"] = "closed"
        elif kind == "message" and p.get("role") == "user":
            text = user_text(p)
            replies = REPLY.findall(text)
            for raw in replies:
                try:
                    items = json.loads(raw)
                except ValueError:
                    continue
                for item in items if isinstance(items, list) else []:
                    try:
                        _tool, call, index = json.loads(item.get("questionItemId") or "")
                    except (ValueError, TypeError):
                        continue
                    q = pending.get(call)
                    if q:
                        q["questions"] = [x for x in q["questions"] if x["index"] != index]
                        if not q["questions"]:
                            del pending[call]
            if not replies and not text.lstrip().startswith("<"):
                # The person wrote something else: questions whose turn already ended are moot.
                for call in [c for c, q in pending.items() if q["turn"] == "closed"]:
                    del pending[call]


# --- Claude Code -------------------------------------------------------------------------------

def claude_transcript(terminal):
    label = (terminal.get("labels") or {}).get("resume", "")
    ids = UUID.findall(label)
    if not ids:
        return None
    files = glob.glob(os.path.join(HOME, ".claude", "projects", "*", f"{ids[-1]}.jsonl"))
    return max(files, key=os.path.getmtime) if files else None


def scan_claude(path, entry):
    pending = entry.setdefault("pending", {})
    for line in new_lines(path, entry):
        if "AskUserQuestion" not in line and '"tool_result"' not in line:
            continue
        try:
            o = json.loads(line)
        except ValueError:
            continue
        message = o.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        for c in content if isinstance(content, list) else []:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "tool_use" and c.get("name") == "AskUserQuestion":
                qs = (c.get("input") or {}).get("questions") or []
                questions = [
                    {
                        "index": i,
                        "title": str(q.get("question") or ""),
                        "options": [str(x.get("label") if isinstance(x, dict) else x) for x in q.get("options") or []],
                    }
                    for i, q in enumerate(qs) if isinstance(q, dict)
                ]
                if questions:
                    pending[c.get("id")] = {"asked": stamp(o.get("timestamp")), "turn": "open", "questions": questions}
            elif c.get("type") == "tool_result":
                pending.pop(c.get("tool_use_id"), None)


# --- Main --------------------------------------------------------------------------------------

AGENTS = {
    "codex": (codex_rollout, scan_codex, True),
    "claude": (claude_transcript, scan_claude, False),
}


def agent_of(terminal):
    name = " ".join(str(terminal.get(k) or "") for k in ("app", "agent")).lower()
    return next((a for a in AGENTS if a in name), None)


def list_questions(terminals):
    cache = load_cache()
    files = cache["files"]
    now = time.time()
    found = []
    used = set()
    for t in terminals:
        agent = agent_of(t)
        if not agent:
            continue
        locate, scan, answerable = AGENTS[agent]
        path = locate(t)
        if not path:
            continue
        used.add(path)
        entry = files.setdefault(path, {})
        try:
            scan(path, entry)
        except OSError:
            continue
        for call, q in entry.get("pending", {}).items():
            if now - q["asked"] > MAX_AGE:
                continue
            found.append({
                "key": f"{agent}:{call}",
                "call": call,
                "agent": agent,
                "terminal": t.get("address"),
                "asked": q["asked"],
                "turn": q["turn"],
                "questions": q["questions"],
                "answerable": answerable,
            })
    cache["files"] = {k: v for k, v in files.items() if k in used}
    save_cache(cache)
    found.sort(key=lambda q: q["asked"], reverse=True)
    return found


def main(argv):
    if len(argv) >= 2 and argv[0] == "list":
        print(json.dumps(list_questions(json.loads(argv[1])), ensure_ascii=False))
        return 0
    print("usage: questions.py list '<terminals json>'", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
