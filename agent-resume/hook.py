#!/usr/bin/env python3
"""Records which agent session runs in a Herdr app terminal.

When the terminal comes back without its agent (a reboot, a lost herdr-core), herdr-core gives
it a fresh shell, and shell.sh resumes the session recorded here, as the herdr TUI does.

The agents' SessionStart hooks call it: `hook.py claude|codex|kimi`, with the hook's JSON on
stdin. It prints nothing (Claude adds a SessionStart hook's output to the conversation) and
always exits 0, so it never gets in the agent's way.
"""

import json
import os
import shlex
import shutil
import subprocess
import sys
import time

# Processes that may sit between an agent and herdr-core: the terminal's shell, and whatever runs
# the hook. Anything else above the agent (another agent, tmux) means it isn't the terminal's own.
SHELLS = {"sh", "bash", "dash", "zsh", "fish", "ksh", "env", "timeout", "nohup"}
CORE = "herdr-core"

# Options worth keeping on resume (model, permissions): True when one takes a value.
KEEP = {
    "claude": {
        "--model": True, "--permission-mode": True, "--effort": True, "--agent": True,
        "--add-dir": True, "--dangerously-skip-permissions": False,
        "--allow-dangerously-skip-permissions": False, "--chrome": False,
    },
    "codex": {
        "-m": True, "--model": True, "-p": True, "--profile": True, "-s": True, "--sandbox": True,
        "-a": True, "--ask-for-approval": True, "-c": True, "--config": True, "--add-dir": True,
        "--enable": True, "--disable": True, "--search": False, "--no-alt-screen": False,
        "--dangerously-bypass-approvals-and-sandbox": False, "--approve-for-me": False,
    },
    "kimi": {
        "-m": True, "--model": True, "--agent": True, "--agent-file": True, "--add-dir": True,
        "--skills-dir": True, "-y": False, "--yolo": False, "--auto": False,
    },
}


def kept_options(agent, argv):
    """The options from the agent's command line that a resume should repeat."""
    table = KEEP[agent]
    out = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        name = arg.split("=", 1)[0]
        if name in table:
            if table[name] and "=" not in arg:
                if i + 1 < len(argv):
                    out += [arg, argv[i + 1]]
                i += 2
                continue
            out.append(arg)
        i += 1
    return out


def resume_command(agent, session, argv):
    """The shell command that resumes `session` with the options it was started with."""
    keep = kept_options(agent, argv[1:])
    if agent == "claude":
        words = ["claude", "--resume", session, *keep]
    elif agent == "codex":
        # --no-daemon keeps Codex's commands in this terminal, under herdr-core.
        words = ["codex", "resume", "--no-daemon", *keep, session]
    else:
        words = ["kimi", "-S", session, *keep]
    return shlex.join(words)


def stat(pid):
    """(comm, ppid, start time) of a process, from /proc."""
    with open(f"/proc/{pid}/stat") as f:
        s = f.read()
    rest = s[s.rindex(")") + 2:].split()
    return s[s.index("(") + 1:s.rindex(")")], int(rest[1]), rest[19]


def agent_process():
    """(pid, start, main pid, core pid) of the agent running this hook, when it is the program of
    a herdr-core terminal; main is the terminal's own process (its shell, or the agent itself)."""
    chain = []
    pid = os.getppid()
    while pid > 1:
        comm, ppid, start = stat(pid)
        if comm == CORE:
            break
        chain.append((pid, comm, start))
        pid = ppid
    else:
        return None  # not under herdr-core, e.g. Codex's daemon
    agents = [i for i, (_, comm, _) in enumerate(chain) if comm not in SHELLS]
    if len(agents) != 1:
        return None  # an agent inside another agent, or inside tmux
    agent, _, start = chain[agents[0]]
    return agent, start, chain[-1][0], pid


def chain():
    out, pid = [], os.getppid()
    while pid > 1:
        try:
            comm, ppid, _ = stat(pid)
        except OSError:
            break
        out.append(f"{pid}:{comm}")
        if comm == CORE:
            break
        pid = ppid
    return out


HC = None


def hc(*args):
    r = subprocess.run([HC, *args], capture_output=True, text=True, timeout=5)
    return r.stdout if r.returncode == 0 else None


def find_hc(core):
    """hc from PATH, else beside herdr-core: a terminal started without a login shell may not
    have ~/.local/bin on its PATH."""
    found = shutil.which("hc")
    if found:
        return found
    beside = os.path.join(os.path.dirname(os.readlink(f"/proc/{core}/exe")), "hc")
    return beside if os.access(beside, os.X_OK) else None


def state_file(terminal):
    base = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
    safe = "".join(c if c.isalnum() or c in "_.-" else "_" for c in terminal)
    return os.path.join(base, "herdr-agent-resume", safe)


def read_record(path):
    """The record's lines as {name: value}."""
    out = {}
    with open(path) as f:
        for line in f:
            name, _, value = line.rstrip("\n").partition("=")
            words = shlex.split(value)
            out[name] = words[0] if words else ""
    return out


def write_record(path, lines):
    tmp = f"{path}.{os.getpid()}"
    with open(tmp, "w") as f:
        f.writelines(f"{k}={shlex.quote(v)}\n" for k, v in lines.items())
    os.replace(tmp, path)


def adopt(terminal, shell):
    """After shell.sh typed a resume command: point the record at the agent once it runs.
    Codex reports SessionStart only with its first message, so a resumed session left alone
    would otherwise have no record, and the next reboot would lose it."""
    path = state_file(terminal)
    try:
        pending = read_record(path).get("herdr_resume_proc")
    except OSError:
        return
    with open("/proc/sys/kernel/random/boot_id") as f:
        boot = f.read().strip()
    deadline = time.time() + 60
    while time.time() < deadline:
        time.sleep(0.3)
        try:
            lines = read_record(path)
        except OSError:
            return
        if lines.get("herdr_resume_proc") != pending:
            return  # the agent's own hook recorded it
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            try:
                comm, ppid, start = stat(int(entry))
            except (OSError, ValueError):
                continue
            if ppid == shell and comm not in SHELLS:
                lines["herdr_resume_proc"] = f"{boot}:{entry}:{start}"
                write_record(path, lines)
                log("adopted", terminal, entry, comm)
                return
    # The agent never started: nothing runs here to resume.
    log("adopt gave up", terminal)
    os.remove(path)


def log(*parts):
    """With a `.debug` file in the records' folder, says why each call did or didn't record."""
    folder = os.path.dirname(state_file("x"))
    if os.path.exists(os.path.join(folder, ".debug")):
        with open(os.path.join(folder, "debug.log"), "a") as f:
            f.write(" ".join(str(p) for p in (time.strftime("%m-%d %H:%M:%S"), *sys.argv[1:2], *parts)) + "\n")


def main():
    agent = sys.argv[1] if len(sys.argv) > 1 else ""
    terminal = os.environ.get("HC_TERMINAL_ID")
    log("start", terminal, "CODEX_THREAD_ID=" + str(os.environ.get("CODEX_THREAD_ID")))
    if agent not in KEEP or not terminal:
        return
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return
    log("payload", {k: v for k, v in payload.items() if k != "prompt"} if isinstance(payload, dict) else payload)
    if not isinstance(payload, dict) or payload.get("agent_id"):
        return  # a Claude subagent
    session = payload.get("session_id")
    if not isinstance(session, str) or not session:
        return
    if agent == "codex":
        # As herdr's own hook: no transcript means nothing to resume, and a thread inherited
        # from a parent Codex isn't this terminal's session.
        if not str(payload.get("transcript_path") or "").strip():
            return
        inherited = os.environ.get("CODEX_THREAD_ID")
        if inherited and inherited != session:
            return

    found = agent_process()
    if not found:
        log("skip: not the terminal's own agent", chain())
        return
    pid, start, main_pid, core = found
    global HC
    HC = find_hc(core)
    if not HC:
        return
    info = json.loads(hc("get", terminal, "--json") or "null")
    if not isinstance(info, dict) or info.get("pid") != main_pid:
        log("skip: terminal pid", info.get("pid") if isinstance(info, dict) else None, "!=", main_pid)
        return  # HC_TERMINAL_ID names another terminal than the one this agent runs in

    with open(f"/proc/{pid}/cmdline", "rb") as f:
        argv = [a.decode(errors="replace") for a in f.read().split(b"\0") if a]
    cmd = resume_command(agent, session, argv)
    cwd = payload.get("cwd") if isinstance(payload.get("cwd"), str) else os.readlink(f"/proc/{pid}/cwd")
    with open("/proc/sys/kernel/random/boot_id") as f:
        boot = f.read().strip()

    path = state_file(terminal)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    lines = {
        "herdr_resume_proc": f"{boot}:{pid}:{start}",
        "herdr_resume_created": str(info.get("created_ms") or ""),
        "herdr_resume_cwd": cwd,
        "herdr_resume_cmd": cmd,
        "herdr_resume_time": str(int(time.time())),
    }
    write_record(path, lines)
    # Shown by `hc get`, so people and agents can see what would resume here.
    hc("label", terminal, f"resume={cmd}")
    log("recorded", terminal, cmd)


if __name__ == "__main__":
    try:
        if sys.argv[1:2] == ["adopt"]:
            adopt(sys.argv[2], int(sys.argv[3]))
        else:
            main()
    except Exception as e:
        try:
            log("error", repr(e))
        except Exception:
            pass
