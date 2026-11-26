"""python3 -m unittest discover tests"""

import importlib.util
import json
import os
import pathlib
import sqlite3
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("tokens", ROOT / "token-usage" / "mods" / "token-usage" / "tokens.py")
tokens = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tokens)


def jl(*objs):
    return "".join(json.dumps(o, separators=(",", ":")) + "\n" for o in objs)


def claude(mid, out, ts="2026-11-26T10:00:00Z", model="claude-opus-5-5"):
    return {"type": "assistant", "timestamp": ts, "requestId": f"req_{mid}", "message": {
        "id": f"msg_{mid}", "model": model,
        "usage": {"input_tokens": 3, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 50,
                  "cache_creation": {"ephemeral_1h_input_tokens": 50}, "output_tokens": out}}}


def codex_ctx(model):
    return {"timestamp": "2026-11-26T10:00:00Z", "type": "turn_context", "payload": {"model": model}}


def codex_record(rid, ts="2026-11-26T10:00:01Z"):
    usage = {"input_tokens": 1000, "cached_input_tokens": 800, "cache_write_input_tokens": 0,
             "output_tokens": 20, "reasoning_output_tokens": 5, "total_tokens": 1020}
    return {"timestamp": ts, "type": "token_usage_record", "payload": {"response_id": rid, "usage": usage}}


def codex_count(total, last):
    def u(v):
        return {"input_tokens": v, "cached_input_tokens": 0, "output_tokens": 1, "reasoning_output_tokens": 0, "total_tokens": v + 1}
    return {"timestamp": "2026-11-26T10:00:02Z", "type": "event_msg",
            "payload": {"type": "token_count", "info": {"total_token_usage": u(total), "last_token_usage": u(last)}}}


def kimi(time_ms, out=7):
    return {"type": "usage.record", "agentId": "main", "model": "kimi-code/k3.1-pro", "time": time_ms,
            "usage": {"inputOther": 10, "output": out, "inputCacheRead": 90, "inputCacheCreation": 0}}


class Scan(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self.dir.name)
        for var in ("CLAUDE_CONFIG_DIR", "CODEX_HOME"):
            os.environ.pop(var, None)
        tokens.HOME = str(self.home)
        self.db = sqlite3.connect(":memory:")
        self.db.executescript(tokens.SCHEMA)

    def tearDown(self):
        self.db.close()
        self.dir.cleanup()

    def write(self, rel, text, mode="w"):
        p = self.home / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, mode) as f:
            f.write(text)
        return p

    def rows(self, provider):
        return self.db.execute("SELECT model, input, cache_read, cache_write, cache_write_1h, output, reasoning FROM req "
                               "WHERE provider = ? ORDER BY key", (provider,)).fetchall()

    def test_claude_counts_a_message_once_and_keeps_its_final_usage(self):
        # One message written per content block (the first with a partial count), then copied
        # into a resumed session's file.
        self.write(".claude/projects/p/a.jsonl", jl(claude("1", 0), claude("1", 40), claude("2", 9)))
        self.write(".claude/projects/p/b.jsonl", jl(claude("1", 40), {"type": "user", "message": {"content": "hi"}}))
        tokens.scan(self.db, 10)
        self.assertEqual(self.rows("claude"), [("claude-opus-5-5", 3, 100, 50, 50, 40, 0), ("claude-opus-5-5", 3, 100, 50, 50, 9, 0)])

    def test_claude_skips_synthetic_messages(self):
        self.write(".claude/projects/p/a.jsonl", jl(claude("1", 5, model="<synthetic>")))
        tokens.scan(self.db, 10)
        self.assertEqual(self.rows("claude"), [])

    def test_codex_ledger_once_per_response_with_the_turn_model(self):
        self.write(".codex/sessions/2026/11/26/rollout-a.jsonl", jl(codex_ctx("gpt-6.1-sol"), codex_record("r1"),
                                                                    codex_count(1000, 1000)))
        # A fork copies its parent's history, then works on its own.
        self.write(".codex/sessions/2026/11/26/rollout-b.jsonl", jl(codex_ctx("gpt-6.1-sol"), codex_record("r1"),
                                                                    codex_ctx("gpt-6.2-sol"), codex_record("r2")))
        tokens.scan(self.db, 10)
        # input_tokens include the cached ones: 1000 - 800 fresh. The snapshot isn't counted again.
        self.assertEqual(self.rows("codex"), [("gpt-6.1-sol", 200, 800, 0, 0, 20, 5), ("gpt-6.2-sol", 200, 800, 0, 0, 20, 5)])

    def test_old_codex_snapshots_count_once_per_total(self):
        self.write(".codex/sessions/rollout-a.jsonl", jl(codex_ctx("gpt-5.6-sol"), codex_count(100, 100), codex_count(150, 50)))
        self.write(".codex/archived_sessions/rollout-b.jsonl", jl(codex_ctx("gpt-5.6-sol"), codex_count(100, 100),
                                                                 codex_count(150, 50), codex_count(180, 30)))
        tokens.scan(self.db, 10)
        self.assertEqual(sorted(r[1] for r in self.rows("codex")), [30, 50, 100])

    def test_kimi_copied_records_count_once(self):
        self.write(".kimi-code/sessions/wd/s1/agents/main/wire.jsonl", jl(kimi(1794318083288), kimi(1794318090000)))
        self.write(".kimi-code/sessions/wd/s2/agents/main/wire.jsonl", jl(kimi(1794318083288)))
        tokens.scan(self.db, 10)
        self.assertEqual(self.rows("kimi"), [("kimi-code/k3.1-pro", 10, 90, 0, 0, 7, 0)] * 2)

    def test_reads_only_what_was_added_and_waits_for_a_whole_line(self):
        p = self.write(".claude/projects/p/a.jsonl", jl(claude("1", 5)) + jl(claude("2", 6))[:-20])
        self.assertEqual(tokens.scan(self.db, 10)["left"], 0)
        self.assertEqual(len(self.rows("claude")), 1)
        self.write(".claude/projects/p/a.jsonl", jl(claude("2", 6))[-20:] + jl(claude("3", 7)), mode="a")
        os.utime(p, (1, 1))  # a new mtime, even within the clock's resolution
        tokens.scan(self.db, 10)
        self.assertEqual([r[5] for r in self.rows("claude")], [5, 6, 7])

    def test_a_shorter_file_is_read_again_from_the_start(self):
        p = self.write(".claude/projects/p/a.jsonl", jl(claude("1", 5), claude("2", 6)))
        tokens.scan(self.db, 10)
        self.write(".claude/projects/p/a.jsonl", jl(claude("9", 1)))
        os.utime(p, (2, 2))
        tokens.scan(self.db, 10)
        self.assertEqual(len(self.rows("claude")), 3)

    def test_summary_groups_by_local_day(self):
        self.write(".claude/projects/p/a.jsonl", jl(claude("1", 5, ts="2026-11-25T23:30:00Z")))
        tokens.scan(self.db, 10)
        utc = tokens.summary(self.db, 0, 10**6)
        rome = tokens.summary(self.db, 3600, 10**6)
        self.assertEqual(utc["daily"][0][:3], ["2026-11-25", "claude", "claude-opus-5-5"])
        self.assertEqual(rome["daily"][0][0], "2026-11-26")
        self.assertEqual(rome["total"][0][:4], ["claude", "claude-opus-5-5", "standard", 1])


if __name__ == "__main__":
    unittest.main()
