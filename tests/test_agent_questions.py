"""python3 -m unittest discover tests"""

import importlib.util
import json
import pathlib
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("questions", ROOT / "agent-questions" / "mods" / "agent-questions" / "questions.py")
questions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(questions)


def line(kind, payload, ts="2026-11-23T10:00:00Z"):
    return json.dumps({"timestamp": ts, "type": kind, "payload": payload}, separators=(",", ":")) + "\n"


def ask(call, title="Colore?", options=("Rosso", "Blu")):
    args = json.dumps({"questions": [{"title": title, "options": list(options)}]})
    return (line("response_item", {"type": "function_call", "name": "request_user_input_async", "arguments": args, "call_id": call})
            + line("response_item", {"type": "function_call_output", "call_id": call, "output": '{"accepted":true}'}))


def user(text):
    return line("response_item", {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]})


def reply(call, index=0, answer="Blu"):
    item = {"answer": answer, "question": "Colore?", "questionItemId": json.dumps(["request_user_input_async", call, index])}
    return user("<send_user_message_question_reply>\n" + json.dumps([item]) + "\n</send_user_message_question_reply>")


END = line("event_msg", {"type": "task_complete"})


class CodexQuestions(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.rollout = pathlib.Path(self.dir.name) / "rollout.jsonl"
        self.rollout.write_text("")
        questions.CACHE = str(pathlib.Path(self.dir.name) / "cache.json")
        questions.STATE = self.dir.name
        questions.MAX_AGE = 10**10
        questions.AGENTS["codex"] = (lambda _t: str(self.rollout), questions.scan_codex, True)

    def tearDown(self):
        self.dir.cleanup()

    def add(self, text):
        with open(self.rollout, "a") as f:
            f.write(text)

    def listed(self):
        return questions.list_questions([{"address": "t1", "app": "codex", "labels": {}}])

    def test_question_stays_after_its_turn_ends(self):
        self.add(user("ciao") + ask("call_1") + END)
        [q] = self.listed()
        self.assertEqual((q["call"], q["turn"], q["questions"][0]["options"]), ("call_1", "closed", ["Rosso", "Blu"]))

    def test_reply_removes_it_on_a_later_read(self):
        self.add(ask("call_1") + END)
        self.assertEqual(len(self.listed()), 1)
        self.add(reply("call_1"))
        self.assertEqual(self.listed(), [])

    def test_another_message_after_the_turn_makes_it_moot(self):
        self.add(ask("call_1") + END + user("lascia stare, fai altro"))
        self.assertEqual(self.listed(), [])

    def test_a_message_during_the_turn_keeps_it(self):
        self.add(ask("call_1") + user("intanto controlla i test"))
        [q] = self.listed()
        self.assertEqual(q["turn"], "open")

    def test_messages_from_other_agents_keep_it(self):
        self.add(ask("call_1") + END + user('<hc from="t5w">fatto</hc>'))
        self.assertEqual(len(self.listed()), 1)

    def test_rejected_call_is_not_listed(self):
        args = json.dumps({"questions": [{"title": "x", "options": []}]})
        self.add(line("response_item", {"type": "function_call", "name": "request_user_input_async", "arguments": args, "call_id": "c"})
                 + line("response_item", {"type": "function_call_output", "call_id": "c", "output": "failed to parse"}))
        self.assertEqual(self.listed(), [])

    def test_partial_last_line_waits_for_the_rest(self):
        text = ask("call_1") + END
        self.add(text[:-30])
        self.listed()
        self.add(text[-30:])
        self.assertEqual(len(self.listed()), 1)


class ClaudeQuestions(unittest.TestCase):
    def test_pending_until_its_result(self):
        with tempfile.TemporaryDirectory() as d:
            path = pathlib.Path(d) / "t.jsonl"
            use = {"type": "assistant", "timestamp": "2026-11-23T10:00:00Z", "message": {"content": [
                {"type": "tool_use", "id": "toolu_1", "name": "AskUserQuestion",
                 "input": {"questions": [{"question": "Quale?", "options": [{"label": "A"}, {"label": "B"}]}]}}]}}
            path.write_text(json.dumps(use) + "\n")
            questions.CACHE = str(pathlib.Path(d) / "cache.json")
            questions.STATE = d
            questions.MAX_AGE = 10**10
            questions.AGENTS["claude"] = (lambda _t: str(path), questions.scan_claude, False)
            t = [{"address": "t2", "app": "claude-code", "labels": {}}]
            [q] = questions.list_questions(t)
            self.assertEqual((q["agent"], q["questions"][0]["options"], q["answerable"]), ("claude", ["A", "B"], False))
            result = {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "ok"}]}}
            with open(path, "a") as f:
                f.write(json.dumps(result) + "\n")
            self.assertEqual(questions.list_questions(t), [])


if __name__ == "__main__":
    unittest.main()
