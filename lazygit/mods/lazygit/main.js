// Lazygit in a popup over the window, like the TUI's prefix+alt+g popup.
//
// A key runs `mod.open:lazygit`: this copy starts lazygit in the focused terminal's
// folder, on its machine, opens the popup and closes itself. It never draws anything.
// The popup is a modal dialog: the `lazygit-bar` mod over the terminal. Esc goes to
// lazygit; quitting it (q) ends the terminal, which closes the popup; the bar's ✕
// closes it too and ends lazygit.

import { View, div } from "gpui-kit";
import { props, focused, terminals, exec, hc, run, home, openOverlay, closeOverlay, notify, checking } from "herdr";

export default class Lazygit extends View {
  init(_props, cx) {
    // Only the copy mod.open makes (an overlay) launches, and only once.
    const self = props()?.overlay;
    if (!self || checking()) return;
    cx.spawn(async (cx) => {
      try {
        await this.launch(cx);
      } finally {
        closeOverlay(self);
      }
    });
  }

  async launch(cx) {
    const f = focused();
    const from = f?.terminal ?? "";
    const on = from.includes("/") ? from.split("/")[0] : null;
    const cwd = f?.cwd || (on ? null : home());
    // lazygit quits at once outside a repository: say so instead of flashing a popup.
    const repo = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: cwd ?? undefined, on }).catch(() => null);
    if (repo?.code !== 0) {
      notify({ title: "Not a git repository", body: cwd ?? "this folder", level: "warning" });
      return;
    }
    const args =["run", "--json", "--bg", "--no-parent", "--rm", "--name", `lazygit-${Date.now() % 1e6}`];
    if (on) args.push("--on", on);
    if (cwd) args.push("--cwd", cwd);
    args.push("--", "lazygit");

    const r = await hc(args).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
    let address = null;
    try {
      address = r.code === 0 ? JSON.parse(r.stdout).address : null;
    } catch {}
    if (!address) {
      notify({ title: "Lazygit didn't start", body: (r.stderr || r.stdout || "").trim().slice(0, 300), level: "error" });
      return;
    }
    if (on && !address.includes("/")) address = `${on}/${address}`;

    openOverlay({
      kind: "dialog",
      modal: true,
      width: 0.9,
      height: 0.9,
      layout: {
        type: "column",
        children: [
          { type: "block", size: { px: 28 }, content: { mod: "lazygit-bar", props: { terminal: address, folder: cwd, machine: on } } },
          { type: "block", content: { terminal: address } },
        ],
      },
    });
    // The dialog's terminal block exists from its next frame: give it the keyboard then.
    await cx.sleep(80);
    if (terminals().some((x) => x.address === address)) run("pane.focus", { terminal: address });
  }

  render() {
    return div().size_full();
  }
}
