# btop

A recap of the machine's resources in the Herdr app's top bar, and
[btop](https://github.com/aristocratos/btop) in a popup over the window when you click it
(`ctrl-shift-r`), like the lazygit popup.

```
wsl │ cpu ▁▂▅▃▂ 17% │ mem ▬▬▬ 5.8G/15G swap 22% │ ↓38K ↑48K
```

- **The recap** shows the focused terminal's machine: CPU with its last ~30 seconds, memory
  (and swap once it passes 10%) and network down/up. It updates every 2 seconds. Amber from 70%,
  red from 90%. In a window narrower than 1100 px it keeps CPU and memory only.
- The machine's name shows beside the numbers when the app knows more than one machine. It turns
  amber when the numbers aren't the focused terminal's machine.
- **The popup** runs btop on that machine with `hc run --rm`. `q`, a click beside the popup, or
  its ✕ end btop and close it.

## Machines

- **Linux** (this computer or one added to Herdr): read from `/proc`. Nothing to install for the
  recap. The popup needs `btop` there, otherwise a toast says it is missing.
- **Windows** (the Windows app's own machine): read with PowerShell (CIM) every 5 seconds, since
  a reading takes 1–2 seconds. The popup uses `btop4win` or `btop` when installed
  (`winget install aristocratos.btop4win`), otherwise it opens Task Manager.
  Add `"windows": false` to the block's props to skip PowerShell and keep showing the last Linux
  machine instead.
- macOS has no `/proc`: the recap shows the last Linux machine.

## Install

In the app, open Mod Manager and install from `https://github.com/l1ego/herdr-mods`, then choose
the `btop` package; it adds `ctrl-shift-r` to `keys.json`.

For the recap, add this block to your layout's top bar (herdr-omarchy already has it):

```json
{ "id": "btop", "type": "block", "size": { "px": 0 }, "window_drag": true,
  "content": { "mod": "btop", "props": { "block": "btop" } } }
```

`block` is the block's own id: the recap widens it to fit (500 px, 270 px in a narrow window); without the mod it stays empty.
