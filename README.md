# herdr-mods

Small additions to [Herdr](https://herdr.dev), made while using the Herdr app every day.

| Folder | What it does | Install |
| --- | --- | --- |
| [`agent-resume`](agent-resume) | Brings Claude Code, Codex and Kimi Code back into their terminals after a reboot, as the herdr TUI does | `bash agent-resume/install.sh` |
| [`lazygit`](lazygit) | Lazygit in a popup over the window, on the focused terminal's folder and machine (`ctrl-shift-g`) | Mod Manager → install from `https://github.com/l1ego/herdr-mods` |

They work with any layout, including [herdr-omarchy](https://github.com/l1ego/herdr-omarchy).

## Tests

```sh
python3 tests/test_agent_resume.py
herdr-app check lazygit/mods/lazygit
herdr-app check lazygit/mods/lazygit-bar
```

MIT licensed.
