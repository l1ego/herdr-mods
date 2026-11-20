#!/usr/bin/env bash
# Installs agent-resume for this user: copies hook.py and shell.sh to
# ~/.local/share/herdr-agent-resume, adds the SessionStart hook to the agents that are set up
# here (Claude Code, Codex, Kimi Code) and sources shell.sh from ~/.bashrc (and ~/.zshrc).
# Run it again after an update. `install.sh --uninstall` takes it all out.
# Files it changes are backed up first as <file>.bak-agent-resume.
set -euo pipefail

src=$(cd "$(dirname "$0")" && pwd)
dest="${XDG_DATA_HOME:-$HOME/.local/share}/herdr-agent-resume"
mode=${1:-install}
case $mode in install | --uninstall) ;; *) echo "usage: $0 [--uninstall]" >&2; exit 2 ;; esac

if [ "$mode" = install ]; then
  command -v python3 >/dev/null || { echo "agent-resume needs python3" >&2; exit 1; }
  mkdir -p "$dest"
  cp "$src/hook.py" "$src/shell.sh" "$dest/"
fi

python3 -I - "$mode" "$dest" <<'PY'
import json, os, re, shutil, sys

mode, dest = sys.argv[1], sys.argv[2]
install = mode == "install"
home = os.path.expanduser("~")
mark = "herdr-agent-resume/hook.py"
hook = lambda agent: f"python3 '{dest}/hook.py' {agent}"

def backup(path):
    if os.path.exists(path) and not os.path.exists(path + ".bak-agent-resume"):
        shutil.copy2(path, path + ".bak-agent-resume")

def write(path, text, old):
    if text == old:
        return False
    backup(path)
    with open(path, "w") as f:
        f.write(text)
    return True

# Claude Code and Codex: hooks.SessionStart in a JSON file.
def json_hook(path, agent):
    if not os.path.isdir(os.path.dirname(path)):
        return f"{agent}: not set up here, skipped"
    raw = open(path).read() if os.path.exists(path) else ""
    data = json.loads(raw) if raw.strip() else {}
    groups = data.setdefault("hooks", {}).setdefault("SessionStart", [])
    groups[:] = [g for g in groups if not any(mark in str(h.get("command", "")) for h in g.get("hooks", []))]
    if install:
        groups.append({"hooks": [{"type": "command", "command": hook(agent), "timeout": 10}]})
    if not groups:
        del data["hooks"]["SessionStart"]
    changed = write(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n", raw)
    return f"{agent}: {path} {'updated' if changed else 'already set'}"

# Kimi Code: a [[hooks]] table in config.toml, between markers.
def kimi_hook(path):
    if not os.path.isdir(os.path.dirname(path)):
        return "kimi: not set up here, skipped"
    raw = open(path).read() if os.path.exists(path) else ""
    text = re.sub(r"\n?# BEGIN herdr agent-resume\n.*?# END herdr agent-resume\n", "", raw, flags=re.S)
    if install:
        text = text.rstrip("\n") + "\n\n# BEGIN herdr agent-resume\n[[hooks]]\nevent = \"SessionStart\"\n" \
            f"command = \"{hook('kimi')}\"\ntimeout = 10\n# END herdr agent-resume\n"
    changed = write(path, text, raw)
    return f"kimi: {path} {'updated' if changed else 'already set'}"

# Shells: source shell.sh last, after PATH is set.
def rc(path, always):
    if not os.path.exists(path) and not always:
        return None
    raw = open(path).read() if os.path.exists(path) else ""
    text = re.sub(r"\n?# BEGIN herdr agent-resume\n.*?# END herdr agent-resume\n", "", raw, flags=re.S)
    if install:
        text = text.rstrip("\n") + f"\n\n# BEGIN herdr agent-resume\n[ -r '{dest}/shell.sh' ] && . '{dest}/shell.sh'\n# END herdr agent-resume\n"
    changed = write(path, text, raw)
    return f"shell: {path} {'updated' if changed else 'already set'}"

for line in [
    json_hook(f"{home}/.claude/settings.json", "claude"),
    json_hook(f"{home}/.codex/hooks.json", "codex"),
    kimi_hook(f"{home}/.kimi-code/config.toml"),
    rc(f"{home}/.bashrc", True),
    rc(f"{home}/.zshrc", False),
]:
    if line:
        print(line)
PY

if [ "$mode" = --uninstall ]; then
  rm -rf "$dest"
  echo "removed $dest (records stay in ${XDG_STATE_HOME:-$HOME/.local/state}/herdr-agent-resume)"
else
  echo "installed in $dest: new shells and agent sessions use it"
fi
