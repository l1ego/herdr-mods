"""python3 -m unittest discover tests"""

import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("hook", ROOT / "agent-resume" / "hook.py")
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


class ResumeCommand(unittest.TestCase):
    def test_claude_keeps_model_and_permissions(self):
        argv = ["claude", "--model", "opus", "--dangerously-skip-permissions", "fix the bug", "--resume", "old"]
        self.assertEqual(hook.resume_command("claude", "abc", argv),
                         "claude --resume abc --model opus --dangerously-skip-permissions")

    def test_codex_resumes_without_the_daemon(self):
        argv = ["codex", "--no-daemon", "-m", "gpt-6.1-terra", "-c", "model_reasoning_effort=high", "resume", "old"]
        self.assertEqual(hook.resume_command("codex", "019a", argv),
                         "codex resume --no-daemon -m gpt-6.1-terra -c model_reasoning_effort=high 019a")

    def test_kimi_with_equals_form(self):
        self.assertEqual(hook.resume_command("kimi", "session_1", ["kimi-code", "--model=k3", "--yolo", "-p", "hi"]),
                         "kimi -S session_1 --model=k3 --yolo")

    def test_values_are_quoted(self):
        self.assertEqual(hook.resume_command("claude", "a b", ["claude", "--add-dir", "/x y"]),
                         "claude --resume 'a b' --add-dir '/x y'")


class Install(unittest.TestCase):
    def run_install(self, home, *args):
        env = {**os.environ, "HOME": home, "XDG_DATA_HOME": f"{home}/.local/share"}
        return subprocess.run(["bash", str(ROOT / "agent-resume" / "install.sh"), *args],
                              env=env, capture_output=True, text=True, check=True).stdout

    def test_install_twice_then_uninstall(self):
        with tempfile.TemporaryDirectory() as home:
            os.makedirs(f"{home}/.claude")
            os.makedirs(f"{home}/.kimi-code")
            mine = {"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "mine"}]}]}, "model": "x"}
            pathlib.Path(f"{home}/.claude/settings.json").write_text(json.dumps(mine))
            pathlib.Path(f"{home}/.kimi-code/config.toml").write_text('model = "k"\n')
            pathlib.Path(f"{home}/.bashrc").write_text("export A=1\n")

            out = self.run_install(home)
            self.assertIn("codex: not set up here", out)
            self.run_install(home)
            settings = json.loads(pathlib.Path(f"{home}/.claude/settings.json").read_text())
            commands = [h["command"] for g in settings["hooks"]["SessionStart"] for h in g["hooks"]]
            self.assertEqual(commands, ["mine", f"python3 '{home}/.local/share/herdr-agent-resume/hook.py' claude"])
            self.assertEqual(pathlib.Path(f"{home}/.kimi-code/config.toml").read_text().count("[[hooks]]"), 1)
            self.assertEqual(pathlib.Path(f"{home}/.bashrc").read_text().count("# BEGIN herdr agent-resume"), 1)
            self.assertTrue(os.path.exists(f"{home}/.local/share/herdr-agent-resume/hook.py"))

            self.run_install(home, "--uninstall")
            self.assertEqual(json.loads(pathlib.Path(f"{home}/.claude/settings.json").read_text()), mine)
            self.assertEqual(pathlib.Path(f"{home}/.kimi-code/config.toml").read_text(), 'model = "k"\n')
            self.assertEqual(pathlib.Path(f"{home}/.bashrc").read_text(), "export A=1\n")
            self.assertFalse(os.path.exists(f"{home}/.local/share/herdr-agent-resume"))


class Shell(unittest.TestCase):
    def test_alive_matches_boot_pid_and_start(self):
        boot = pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        _, _, start = hook.stat(os.getpid())
        script = f"""
            HC_TERMINAL_ID=t0 PS1=x; hc() {{ :; }}; __herdr_resume_start() {{ :; }}
            . '{ROOT}/agent-resume/shell.sh'
            __herdr_resume_alive '{boot}:{os.getpid()}:{start}' && echo alive
            __herdr_resume_alive '{boot}:{os.getpid()}:1' || echo restarted
            __herdr_resume_alive 'other:{os.getpid()}:{start}' || echo rebooted
        """
        out = subprocess.run(["bash", "-c", script], capture_output=True, text=True).stdout.split()
        self.assertEqual(out, ["alive", "restarted", "rebooted"])


if __name__ == "__main__":
    unittest.main()
