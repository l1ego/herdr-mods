# lazygit

[Lazygit](https://github.com/jesseduffield/lazygit) in a popup over the Herdr app window, like the
herdr TUI's lazygit popup.

To open it, press `ctrl-shift-g`. That key runs `mod.open:lazygit`, and the installer adds it to
`keys.json`.

- Lazygit starts in the focused terminal's folder, on that terminal's machine, so a WSL or SSH
  space opens lazygit there.
- Outside a git repository, you get a notice instead of the popup.
- The bar on top shows where lazygit runs. Its ✕ closes the popup and ends lazygit, and so does
  quitting lazygit with `q`.

It needs `lazygit` on the machine where it runs.

## Install

In the app, open Mod Manager and install from `https://github.com/l1ego/herdr-mods`, then choose
the `lazygit` package. It installs two mods:

- `lazygit`: starts lazygit and opens the popup;
- `lazygit-bar`: the bar on top of the popup.
