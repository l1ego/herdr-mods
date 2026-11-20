// The bar on top of the lazygit popup (opened by the `lazygit` mod): where it runs,
// and ✕ to close it. Closing the popup ends lazygit if it still runs.
// Props: { terminal, folder, machine, overlay }.

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, terminals, run, theme, home, closeOverlay } from "herdr";

export default class LazygitBar extends View {
  async close() {
    const t = props()?.terminal;
    if (t && terminals().some((x) => x.address === t)) run("terminal.kill", { terminal: t });
  }

  render() {
    const t = theme();
    const { overlay, folder, machine } = props() ?? {};
    const h = home();
    const where = folder ? (folder === h || folder.startsWith(`${h}/`) ? `~${folder.slice(h.length)}` : folder) : "";
    return h_flex()
      .id("lazygit-bar")
      .size_full()
      .px(12)
      .gap(8)
      .items_center()
      .bg(t.surface)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .child(div().flex_none().font_semibold().text_color(t.foreground).child("lazygit"))
      .child(div().truncate().text_color(t.dim).child(machine ? `${machine}:${where}` : where))
      .child(div().flex_1())
      .child(div().flex_none().text_color(t.dim).child("q to quit"))
      .child(
        div()
          .id("lazygit-close")
          .px(8)
          .py(2)
          .rounded(5)
          .text_color(t.muted)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => closeOverlay(overlay))
          .child("✕"),
      );
  }
}
