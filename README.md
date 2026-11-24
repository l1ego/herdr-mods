# herdr-mods

Small additions to [Herdr](https://herdr.dev), made while using the Herdr app every day.

| Folder | What it does | Install |
| --- | --- | --- |
| [`agent-resume`](agent-resume) | Brings Claude Code, Codex and Kimi Code back into their terminals after a reboot, as the herdr TUI does | `bash agent-resume/install.sh` |
| [`lazygit`](lazygit) | Lazygit in a popup over the window, on the focused terminal's folder and machine (`ctrl-shift-g`) | Mod Manager → install from `https://github.com/l1ego/herdr-mods` |
| [`agent-questions`](agent-questions) | The questions agents asked you (Codex closes its question card when its turn ends), in a popup you can answer from (`ctrl-shift-q`), plus a badge for the bar | Mod Manager → install from `https://github.com/l1ego/herdr-mods` |
| [`btop`](btop) | A recap of CPU, memory and network in the top bar, and btop in a popup when clicked (`ctrl-shift-r`); Linux machines and the Windows app's own machine | Mod Manager → install from `https://github.com/l1ego/herdr-mods` |

They work with any layout, including [herdr-omarchy](https://github.com/l1ego/herdr-omarchy).

## Tests

```sh
python3 -m unittest discover tests
herdr-app check lazygit/mods/lazygit
herdr-app check lazygit/mods/lazygit-bar
herdr-app check agent-questions/mods/agent-questions
herdr-app check btop/mods/btop
```

MIT licensed.
