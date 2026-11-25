// btop in the top bar: a small recap of the machine's resources (CPU with its recent history,
// memory, network), and btop itself in a popup over the window when clicked, like lazygit.
//
// Three copies of the same mod:
// - the recap (a block in the layout, props.block = its id): every few seconds, the resources
//   of the focused terminal's machine. Linux machines: /proc. This computer when the app runs on
//   Windows: PowerShell (CIM), every 5 s because it is slower; props.windows: false turns that
//   off and shows the last Linux machine instead. The machine's name shows beside the numbers
//   when the app knows several machines, or when the numbers aren't the focused machine's.
//   Clicking it runs `mod.open:btop`.
// - the launcher (mod.open:btop, an invisible overlay): starts btop on the machine the recap
//   shows with `hc run --rm`, opens the popup and closes itself. Never draws anything. On
//   Windows it uses btop4win or btop when installed, else opens Task Manager.
// - the popup's bar (props.bar): where btop runs, and ✕, which ends btop. Quitting btop (q),
//   or a click beside the popup, ends it too.

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import {
  props, focused, terminals, machines, exec, hc, run, theme, shared, setShared, openOverlay, closeOverlay, notify,
  checking, window as appWindow,
} from "herdr";

const EVERY = 2000;
const WIN_EVERY = 5000; // a PowerShell read takes 1-2 s
const HISTORY = 14; // CPU samples in the sparkline
const WIDTH = 500, WIDTH_NARROW = 270; // px of the recap's block
const AMBER = "#ffb347", RED = "#ff5d6c";
const LAST = "btop.machine"; // the machine the recap shows: { on }
const LINUX = "btop.linux"; // the last Linux machine that answered: { on }
const POPUP = "btop.popup"; // the open popup's btop terminal
const LABEL = "herdr-mod-btop"; // marks the btop terminals this mod starts
const READ = "head -1 /proc/stat; cat /proc/meminfo /proc/net/dev";
// Windows: CPU load, available memory, paging file and network rates, as one JSON line.
const WIN_READ = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$c=(Get-CimInstance Win32_Processor -Property LoadPercentage | Measure-Object LoadPercentage -Average).Average",
  "$m=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -Property AvailableBytes",
  "$o=Get-CimInstance Win32_OperatingSystem -Property TotalVisibleMemorySize,SizeStoredInPagingFiles,FreeSpaceInPagingFiles",
  "$n=Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface -Property BytesReceivedPersec,BytesSentPersec | Measure-Object BytesReceivedPersec,BytesSentPersec -Sum",
  "ConvertTo-Json -Compress @{cpu=[int]$c; memTotal=[double]$o.TotalVisibleMemorySize*1024; memAvailable=[double]$m.AvailableBytes; swapTotal=[double]$o.SizeStoredInPagingFiles*1024; swapFree=[double]$o.FreeSpaceInPagingFiles*1024; down=[double]$n[0].Sum; up=[double]$n[1].Sum}",
].join("; ");

const machineOf = (address) => (address?.includes("/") ? address.split("/")[0] : null);
const keyOf = (on) => on ?? "";
/** This computer, when the app runs on Windows: no /proc there. */
const isWindows = (on) => on === null && appWindow()?.platform === "windows";
const nameOf = (on) => on ?? (isWindows(null) ? "windows" : "local");

/** The machine to watch: the focused terminal's, else the one shown last. */
function target() {
  const f = focused();
  if (f?.terminal) return machineOf(f.terminal);
  return shared(LAST)?.on ?? null;
}

// --- Reading -----------------------------------------------------------------------------------

async function readLinux(on) {
  const r = await exec("sh", ["-c", READ], { on, timeout: 5000 }).catch(() => null);
  if (r?.code !== 0) return null;
  try {
    return parse(r.stdout);
  } catch {
    return null;
  }
}

async function readWindows() {
  const r = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_READ], { timeout: 15000 })
    .catch(() => null);
  if (r?.code !== 0) return null;
  try {
    const d = JSON.parse(r.stdout.trim());
    return Number.isFinite(d.memTotal) && d.memTotal > 0 ? d : null;
  } catch {
    return null;
  }
}

function parse(text) {
  const lines = text.split("\n");
  const cpu = lines[0].trim().split(/\s+/).slice(1).map(Number);
  if (lines[0].split(/\s+/)[0] !== "cpu" || cpu.length < 4) throw new Error("no /proc/stat");
  const idle = cpu[3] + (cpu[4] ?? 0); // idle + iowait
  const total = cpu.slice(0, 8).reduce((a, b) => a + b, 0); // guest time is already in user
  const mem = {};
  let rx = 0, tx = 0;
  for (const line of lines.slice(1)) {
    const m = line.match(/^(\w+):\s+(\d+) kB/);
    if (m) { mem[m[1]] = Number(m[2]) * 1024; continue; }
    const n = line.match(/^\s*([^:\s]+):\s*(.*)$/);
    // An interface has 16 counters; meminfo lines without "kB" (HugePages_Total: 0) have one.
    const f = n && n[1] !== "lo" ? n[2].trim().split(/\s+/).map(Number) : [];
    if (f.length >= 16 && f.every(Number.isFinite)) {
      rx += f[0];
      tx += f[8];
    }
  }
  return { idle, total, mem, rx, tx, at: Date.now() };
}

// --- Formatting --------------------------------------------------------------------------------

function bytes(v) {
  const units = ["B", "K", "M", "G", "T"];
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

function level(pct, t) {
  if (pct >= 90) return RED;
  if (pct >= 70) return AMBER;
  return t.accent;
}

// --- The mod -----------------------------------------------------------------------------------

export default class Btop extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.bar) return;
    if (p.overlay) {
      if (checking()) return;
      cx.spawn(async (cx) => {
        try {
          await this.launch(cx);
        } finally {
          closeOverlay(p.overlay);
        }
      });
      return;
    }
    this.prev = new Map(); // machine -> last /proc sample, for the deltas
    this.history = new Map(); // machine -> CPU percents, oldest first
    this.stats = null; // what the bar shows: { on, cpu, mem, memUsed, memTotal, swap, down, up }
    this.winAt = 0; // when Windows was last read
    this.error = null;
    if (checking()) return;
    this.sample(cx);
    cx.timer.every(EVERY, (cx) => this.sample(cx));
  }

  sample(cx) {
    if (this.busy || appWindow()?.visible === false) return;
    const want = target();
    const windows = isWindows(want) && props()?.windows !== false;
    if (windows && this.stats?.on === want && Date.now() - this.winAt < WIN_EVERY) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        let on = want;
        let done = false;
        if (windows) {
          const d = await readWindows();
          this.winAt = Date.now();
          if (d) {
            this.updateWindows(on, d);
            done = true;
          }
        }
        if (!done) {
          const linux = shared(LINUX);
          let s = isWindows(on) ? null : await readLinux(on);
          // No /proc where the focus is: show the last Linux machine that answered.
          if (!s && linux && linux.on !== on) {
            on = linux.on;
            s = await readLinux(on);
          }
          if (!s) throw new Error(isWindows(want) ? "no reading from Windows" : `no /proc on ${nameOf(on)}`);
          this.update(on, s);
          if (!linux || linux.on !== on) setShared(LINUX, { on });
        }
        if (!shared(LAST) || shared(LAST).on !== on) setShared(LAST, { on });
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  update(on, s) {
    const p = this.prev.get(keyOf(on));
    this.prev.set(keyOf(on), s);
    const memTotal = s.mem.MemTotal ?? 0;
    const swapTotal = s.mem.SwapTotal ?? 0;
    let cpu = this.stats?.on === on ? this.stats.cpu : null;
    let down = null, up = null;
    if (p) {
      const dt = s.total - p.total;
      if (dt > 0) cpu = Math.round(100 * (1 - (s.idle - p.idle) / dt));
      const secs = (s.at - p.at) / 1000;
      if (secs > 0) {
        down = Math.max(0, (s.rx - p.rx) / secs);
        up = Math.max(0, (s.tx - p.tx) / secs);
      }
    }
    this.show(on, {
      cpu,
      memTotal,
      memUsed: memTotal - (s.mem.MemAvailable ?? s.mem.MemFree ?? 0),
      swapTotal,
      swapUsed: swapTotal - (s.mem.SwapFree ?? 0),
      down,
      up,
    });
  }

  updateWindows(on, d) {
    this.show(on, {
      cpu: d.cpu,
      memTotal: d.memTotal,
      memUsed: d.memTotal - d.memAvailable,
      swapTotal: d.swapTotal,
      swapUsed: d.swapTotal - d.swapFree,
      down: d.down,
      up: d.up,
    });
  }

  show(on, v) {
    if (v.cpu !== null) {
      const h = this.history.get(keyOf(on)) ?? [];
      h.push(v.cpu);
      this.history.set(keyOf(on), h.slice(-HISTORY));
    }
    this.stats = {
      on,
      cpu: v.cpu,
      mem: v.memTotal ? Math.round((100 * v.memUsed) / v.memTotal) : null,
      memUsed: v.memUsed,
      memTotal: v.memTotal,
      swap: v.swapTotal ? Math.round((100 * v.swapUsed) / v.swapTotal) : 0,
      down: v.down,
      up: v.up,
    };
  }

  /** The popup's bar closes with the popup: end btop if it still runs. */
  async close() {
    const p = props() ?? {};
    if (p.bar && p.terminal && terminals().some((x) => x.address === p.terminal)) run("terminal.kill", { terminal: p.terminal });
  }

  // --- Launcher ---

  async launch(cx) {
    // The popup is already open when its btop has the keyboard (ctrl-shift-r inside it).
    if (focused()?.terminal && focused().terminal === shared(POPUP)?.terminal) return;
    // A btop of ours still running has lost its popup (an app or mod reload closed it without
    // ending btop): end it rather than leave it running unseen.
    for (const x of terminals()) {
      if (x.labels?.[LABEL] && x.state !== "finished") run("terminal.kill", { terminal: x.address });
    }
    const last = shared(LAST);
    const on = last ? last.on : target(); // the machine the recap shows
    let program = "btop";
    if (isWindows(on)) {
      program = await this.windowsProgram();
      if (!program) {
        // No btop on Windows: its own Task Manager shows the same things. Start-Process, not
        // `cmd /c start`: a program started that way keeps exec's output open until it quits.
        await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Start-Process taskmgr.exe"], { timeout: 10000 })
          .catch(() => null);
        return;
      }
    } else {
      const has = await exec("sh", ["-c", "command -v btop"], { on }).catch(() => null);
      if (has?.code !== 0) {
        notify({ title: "btop isn't installed", body: `on ${nameOf(on)}`, level: "warning" });
        return;
      }
    }
    const args = ["run", "--json", "--bg", "--no-parent", "--rm", "--name", `btop-${Date.now() % 1e6}`, "--label", `${LABEL}=1`];
    if (on) args.push("--on", on);
    args.push("--", program);
    const r = await hc(args).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
    let address = null;
    try {
      address = r.code === 0 ? JSON.parse(r.stdout).address : null;
    } catch {}
    if (!address) {
      notify({ title: "btop didn't start", body: (r.stderr || r.stdout || "").trim().slice(0, 300), level: "error" });
      return;
    }
    if (on && !address.includes("/")) address = `${on}/${address}`;
    setShared(POPUP, { terminal: address });

    openOverlay({
      // Not modal: a click beside the popup closes it, and close() ends btop.
      kind: "dialog",
      width: 0.92,
      height: 0.92,
      layout: {
        type: "column",
        children: [
          { type: "block", size: { px: 28 }, content: { mod: "btop", props: { bar: true, terminal: address, machine: nameOf(on) } } },
          { type: "block", content: { terminal: address } },
        ],
      },
    });
    // The dialog gives its terminal the keyboard by itself. pane.focus can't reach a terminal in
    // an overlay by another machine's address ("no such pane"): only a fallback, if it didn't.
    await cx.sleep(500);
    const f = focused();
    if (f?.terminal !== address && terminals().some((x) => x.address === address)) {
      run("pane.focus", { terminal: address });
    }
  }

  /** btop4win or btop on this Windows computer, or null. */
  async windowsProgram() {
    for (const name of ["btop4win", "btop"]) {
      const r = await exec("where.exe", [name]).catch(() => null);
      if (r?.code === 0 && r.stdout.trim()) return name;
    }
    return null;
  }

  render() {
    const p = props() ?? {};
    if (p.bar) return this.renderBar(p);
    if (p.overlay) return div().size_full();
    return this.renderRecap();
  }

  // --- Recap in the top bar ---

  renderRecap() {
    const t = theme();
    const s = this.stats;
    const shell = h_flex().id("btop-root").size_full().items_center().justify_center().bg(t.chrome).overflow_hidden()
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - (this.width ?? -1)) < 1) return;
        this.width = size.width;
        cx.notify();
      });
    if (!s) {
      return shell.child(div().text_size(11).text_color(t.dim).child(this.error ? "btop: —" : "…"));
    }
    const narrow = globalThis.window.viewport_size().width < 1100;
    // Its block (props.block: the block's id) is as wide as what it shows. Checked against its
    // real width, since a layout reload (an Omarchy update) puts the block back at 0 px; asked
    // once per width, so a zoom that scales the result doesn't loop.
    const block = props()?.block;
    const want = narrow ? WIDTH_NARROW : WIDTH;
    const ask = `${want}@${Math.round(this.width ?? -1)}`;
    if (block && (this.width === undefined || Math.abs(this.width - want) > 2) && this.asked !== ask) {
      this.asked = ask;
      run("layout.resize", { id: block, px: want });
    }
    const sep = (i) => div().id(`btop-sep-${i}`).flex_none().text_color(t.border).child("│");
    const label = (text) => div().flex_none().whitespace_nowrap().text_color(t.dim).child(text);
    const pct = (v, color) => div().flex_none().w(30).whitespace_nowrap().text_color(v >= 70 ? color : t.muted).child(v === null ? "…" : `${v}%`);

    const h = this.history.get(s.on ?? "") ?? [];
    const cpuColor = level(s.cpu ?? 0, t);
    const spark = h_flex().flex_none().h(14).items_end().gap(1)
      .children(Array.from({ length: HISTORY }, (_, i) => {
        const v = h[i - (HISTORY - h.length)];
        return div().w(3).h(v === undefined ? 1 : Math.max(1, Math.round((v / 100) * 14))).bg(v === undefined ? t.border : level(v, t));
      }));
    const cpu = h_flex().gap(5).items_center().flex_none()
      .child(label("cpu"))
      .when(!narrow, (el) => el.child(spark))
      .child(pct(s.cpu, cpuColor));

    const memColor = level(s.mem ?? 0, t);
    const mem = h_flex().gap(5).items_center().flex_none()
      .child(label("mem"))
      .when(!narrow, (el) => el.child(div().relative().w(40).h(6).bg(t.border)
        .child(div().absolute().left(0).top(0).h_full().w(`${s.mem ?? 0}%`).bg(memColor))))
      .child(div().flex_none().whitespace_nowrap().text_color(s.mem >= 70 ? memColor : t.muted)
        .child(`${bytes(s.memUsed)}/${bytes(s.memTotal)}`))
      .when(s.swap >= 10, (el) => el.child(div().flex_none().whitespace_nowrap().text_color(s.swap >= 50 ? AMBER : t.dim).child(`swap ${s.swap}%`)));

    const net = h_flex().gap(5).items_center().flex_none().whitespace_nowrap().text_color(t.muted)
      .child(div().child(`↓${s.down === null ? "…" : bytes(s.down)}`))
      .child(div().child(`↑${s.up === null ? "…" : bytes(s.up)}`));

    // Whose numbers: shown when the app knows several machines, or when they aren't the
    // focused terminal's machine (a Windows terminal with props.windows: false).
    const focus = target();
    const other = s.on !== focus;
    const machine = machines().length > 1 || other
      ? div().flex_none().whitespace_nowrap().text_color(other ? AMBER : t.dim).child(nameOf(s.on))
      : null;
    const parts = [machine, cpu, mem, narrow ? null : net].filter(Boolean);
    const where = ` di ${nameOf(s.on)}${other ? ` (il terminale col focus è su ${nameOf(focus)})` : ""}`;
    return shell.child(h_flex().id("btop-recap").h_full().px(10).gap(10).items_center().text_size(11)
      .cursor_pointer().hover((st) => st.bg(t.hover))
      .tooltip(this.error ? `Risorse${where} (ultimo dato): ${this.error}` : `Risorse${where} · clic per btop`)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => run("mod.open", { name: "btop" }))
      .children(parts.flatMap((el, i) => (i ? [sep(i), el] : [el]))));
  }

  // --- Bar on top of the popup ---

  renderBar(p) {
    const t = theme();
    return h_flex()
      .id("btop-bar")
      .size_full()
      .px(12)
      .gap(8)
      .items_center()
      .bg(t.surface)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .child(div().flex_none().font_semibold().text_color(t.foreground).child("btop"))
      .child(div().truncate().text_color(t.dim).child(p.machine ?? ""))
      .child(div().flex_1())
      .child(div().flex_none().text_color(t.dim).child("q or click outside to quit"))
      .child(
        div()
          .id("btop-close")
          .px(8)
          .py(2)
          .rounded(5)
          .text_color(t.muted)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => closeOverlay(p.overlay))
          .child("✕"),
      );
  }
}
