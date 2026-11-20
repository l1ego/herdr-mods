# agent-resume

Brings your coding agents back after a reboot, the way the herdr TUI does, in the Herdr app.

The Herdr app keeps its terminals (`keep: true`). When the machine reboots or herdr-core is lost,
each one comes back in the same tab and folder, but with a fresh shell instead of the agent you
had open. agent-resume puts the agent back. On the next start, each such terminal runs, for example:

```
herdr: resuming claude --resume 0b1c…
```

It works with Claude Code, Codex and Kimi Code, on Linux and WSL machines (the Windows app too,
when its agents run in WSL), in bash or zsh.

## How it works

- **`hook.py`** runs from each agent's `SessionStart` hook. In a Herdr terminal
  (`$HC_TERMINAL_ID`), it records the session in `~/.local/state/herdr-agent-resume/<terminal>`
  and labels the terminal `resume=<command>` (see `hc get <terminal>`). The record holds:
  - the command that resumes the session, with the options that matter, such as model and
    permission mode;
  - the folder;
  - which process ran it.

  It only records an agent that is the terminal's own program. An agent started inside another
  agent, or inside tmux, is left out.
- **`shell.sh`** is sourced at the end of `~/.bashrc` / `~/.zshrc`.
  - Back at a prompt, the agent has ended, so its record is removed.
  - When herdr-core starts a terminal's shell and that terminal's record names an agent that no
    longer runs, it resumes the session, in that folder. It is also put in the shell history.

Resume commands:

| Agent | Command |
| --- | --- |
| Claude Code | `claude --resume <id>` |
| Codex | `codex resume --no-daemon <id>` |
| Kimi Code | `kimi -S <id>` |

## Install

```sh
git clone https://github.com/l1ego/herdr-mods
bash herdr-mods/agent-resume/install.sh
```

The installer does this:

- copies `hook.py` and `shell.sh` to `~/.local/share/herdr-agent-resume`;
- adds the hook for each agent that is set up:
  - `~/.claude/settings.json`
  - `~/.codex/hooks.json`
  - `~/.kimi-code/config.toml`
- sources `shell.sh` from `~/.bashrc` (and `~/.zshrc` if you have one).

Every file it changes is backed up first as `<file>.bak-agent-resume`. Run it again after
pulling an update.

It needs `python3`. Agents already running are recorded from their next session start, so
restart them once.

## Turn it off

- `export HERDR_AGENT_RESUME=off` before `shell.sh` runs: sessions are still recorded, nothing
  resumes.
- `bash install.sh --uninstall` takes out the hooks, the shell lines and the copied files.

## Limits

- Codex must run with `--no-daemon`. Otherwise its hooks run in the daemon, outside the terminal,
  and nothing is recorded.
- Only a terminal whose shell herdr-core restarts is resumed. A terminal you closed is gone, and so
  is its session.
