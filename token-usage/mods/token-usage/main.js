// The tokens your coding agents used (Claude Code, Codex, Kimi Code), like t3code's Usage page:
// today's total in the top bar, and a popup (ctrl-shift-u) by day, provider and model, with what
// it would cost at API prices.
//
// tokens.py reads the agents' session logs on every machine the app knows (python3 -I; the
// Windows app's own machine uses `python`), keeps each request once in a SQLite file there and
// answers with totals per day and model. A first run reads the logs in steps of 20 s; after that
// it reads only what was added.
//
// Two copies of the same mod:
// - the bar (props.block: its block's id in the layout): rescans every minute, shares what it
//   found (`shared("token-usage")`), sizes its block to its text, opens the popup when clicked.
// - the popup (mod.open:token-usage): period, machine, daily chart and table. Rescans when it
//   opens and every 30 s while open.
//
// Prices: LiteLLM's public table (what t3code uses), fetched once a day. With a subscription the
// cost is only what the same tokens would cost through the API.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import {
  props, run, theme, settings, exec, machines, appHome, readTextFile, shared, setShared, closeOverlay,
  checking, window as appWindow,
} from "herdr";

const DATA = "token-usage"; // { [machine key]: { name, at, data?, error? } }
const RATES = "token-usage.rates"; // { at, rates: { "provider:model": rate | null } }
const PRICES = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const BAR_EVERY = 60000;
const POPUP_EVERY = 30000;
const AGAIN = 2000; // while a first scan still has files to read
const RATES_EVERY = 24 * 3600e3;
const RATES_RETRY = 3600e3; // a model without a price: look again at most this often
const DAYS = 90;
const BUDGET = 20; // seconds per run of tokens.py
const TIMEOUT = 90000;

const PROVIDERS = ["claude", "codex", "kimi"];
const LABEL = { claude: "Claude Code", codex: "Codex", kimi: "Kimi Code" };
// Categorical slots 2, 1, 3 of the dataviz reference palette, validated on light and dark.
const TINT = {
  light: { claude: "#f47230", codex: "#257de0", kimi: "#00b894" },
  dark: { claude: "#e76624", codex: "#338ced", kimi: "#00a888" },
};
const PERIODS = [["today", "Oggi"], ["7", "7 giorni"], ["30", "30 giorni"], ["90", "90 giorni"], ["all", "Tutto"]];

const keyOf = (on) => on ?? "";
const isWindows = (on) => on === null && appWindow()?.platform === "windows";
const nameOf = (on) => on ?? (isWindows(null) ? "windows" : "local");
const tint = (p) => (settings()?.dark === false ? TINT.light : TINT.dark)[p] ?? theme().muted;

// --- Reading -----------------------------------------------------------------------------------

/** One machine's totals from tokens.py. */
async function readMachine(on, script) {
  const args = JSON.stringify({ tz: -new Date().getTimezoneOffset() * 60, days: DAYS, budget: BUDGET });
  const r = on === null
    ? await exec(isWindows(null) ? "python" : "python3", ["-I", `${appHome()}/mods/token-usage/tokens.py`, "run", args], { timeout: TIMEOUT })
    : await exec("python3", ["-I", "-c", script, "run", args], { on, timeout: TIMEOUT });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "tokens.py failed").trim().split("\n").pop().slice(0, 300));
  return JSON.parse(r.stdout);
}

/** Rescans every machine. Returns true when one still has files to read. */
async function scanAll(cx) {
  const script = await readTextFile(`${appHome()}/mods/token-usage/tokens.py`);
  if (!script) throw new Error("tokens.py is missing");
  let more = false;
  for (const m of machines()) {
    if (m.layout === "unavailable") continue;
    const on = m.name;
    let entry;
    try {
      const data = await readMachine(on, script);
      entry = { name: nameOf(on), at: Date.now(), data };
      more ||= data.left > 0;
    } catch (e) {
      // Keep the last totals that machine gave, with the error beside them.
      entry = { ...((shared(DATA) ?? {})[keyOf(on)] ?? {}), name: nameOf(on), error: String(e?.message ?? e), errorAt: Date.now() };
    }
    setShared(DATA, { ...(shared(DATA) ?? {}), [keyOf(on)]: entry });
    cx.notify();
  }
  return more;
}

// --- Prices ------------------------------------------------------------------------------------

const NATIVE = { claude: ["anthropic/"], codex: ["openai/"], kimi: ["moonshot/", "moonshot/kimi-", "kimi-"] };
const TRUSTED = ["azure/", "azure_ai/", "vertex_ai/", "bedrock/"];

/** LiteLLM's rates for a model as the agents name it, or null. */
function rateFor(table, provider, model) {
  const bare = model.replace(/^(kimi-code|moonshot-ai|anthropic|openai)\//, "").replace(/\[[^\]]*\]$/, "");
  const priced = (k) => typeof table[k]?.input_cost_per_token === "number" && typeof table[k]?.output_cost_per_token === "number";
  let key = [model, bare, ...(NATIVE[provider] ?? []).map((p) => p + bare), ...TRUSTED.map((p) => p + bare)].find(priced);
  if (!key) {
    key = Object.keys(table)
      .filter((k) => (k.endsWith(`/${bare}`) || k.endsWith(`.${bare}`) || k.endsWith(`/kimi-${bare}`)) && priced(k))
      .sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  }
  if (!key) return null;
  const e = table[key];
  const write = e.cache_creation_input_token_cost ?? e.input_cost_per_token;
  return {
    key,
    input: e.input_cost_per_token,
    output: e.output_cost_per_token,
    read: e.cache_read_input_token_cost ?? e.input_cost_per_token,
    write,
    write1h: e.cache_creation_input_token_cost_above_1hr ?? write,
  };
}

/** Every "provider:model" the machines reported. */
function modelsSeen() {
  const seen = new Set();
  for (const m of Object.values(shared(DATA) ?? {})) {
    for (const r of m.data?.total ?? []) seen.add(`${r[0]}:${r[1]}`);
  }
  return seen;
}

async function refreshRates() {
  const have = shared(RATES);
  const seen = modelsSeen();
  const missing = [...seen].some((k) => !(k in (have?.rates ?? {})));
  const age = Date.now() - (have?.at ?? 0);
  if (!seen.size || (age < RATES_EVERY && !(missing && age > RATES_RETRY))) return;
  const res = await fetch(PRICES);
  if (!res.ok) throw new Error(`LiteLLM prices: HTTP ${res.status}`);
  const table = await res.json();
  const rates = {};
  for (const k of seen) {
    const [provider, ...rest] = k.split(":");
    rates[k] = rateFor(table, provider, rest.join(":"));
  }
  setShared(RATES, { at: Date.now(), rates });
}

// --- Totals ------------------------------------------------------------------------------------

const EMPTY = () => ({ count: 0, input: 0, read: 0, write: 0, write1h: 0, output: 0, reasoning: 0, cost: 0, unpriced: 0 });

function add(into, r, rate) {
  into.count += r.count;
  into.input += r.input;
  into.read += r.read;
  into.write += r.write;
  into.write1h += r.write1h;
  into.output += r.output;
  into.reasoning += r.reasoning;
  if (rate) {
    into.cost += r.input * rate.input + r.read * rate.read + (r.write - r.write1h) * rate.write
      + r.write1h * rate.write1h + r.output * rate.output;
  } else {
    into.unpriced += r.input + r.read + r.write + r.output;
  }
  return into;
}

const tokens = (t) => t.input + t.read + t.write + t.output;

function shiftDay(day, by) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

/** The rows of the chosen machines and period: { day?, provider, model, count, input, … }. */
function rows(machine, period) {
  const out = [];
  for (const [key, m] of Object.entries(shared(DATA) ?? {})) {
    if (machine !== null && key !== machine) continue;
    const d = m.data;
    if (!d) continue;
    if (period === "all") {
      for (const r of d.total) out.push(row(null, r[0], r[1], r.slice(3)));
    } else {
      const from = period === "today" ? d.today : shiftDay(d.today, 1 - Number(period));
      for (const r of d.daily) if (r[0] >= from) out.push(row(r[0], r[1], r[2], r.slice(4)));
    }
  }
  return out;
}

function row(day, provider, model, v) {
  return { day, provider, model, count: v[0], input: v[1], read: v[2], write: v[3], write1h: v[4], output: v[5], reasoning: v[6] };
}

function rateOf(r) {
  return shared(RATES)?.rates?.[`${r.provider}:${r.model}`] ?? null;
}

/** Today, every machine: { total, by: { provider: totals } }. */
function today() {
  const total = EMPTY();
  const by = {};
  for (const r of rows(null, "today")) {
    add(total, r, rateOf(r));
    add((by[r.provider] ??= EMPTY()), r, rateOf(r));
  }
  return { total, by };
}

// --- Formatting --------------------------------------------------------------------------------

function count(v) {
  const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "k"]];
  for (const [size, unit] of units) {
    if (v >= size) {
      const x = v / size;
      return `${x >= 100 ? Math.round(x) : x.toFixed(1)}${unit}`;
    }
  }
  return String(Math.round(v));
}

function money(v) {
  if (v >= 1000) return `$${Math.round(v).toLocaleString("en-US")}`;
  if (v >= 10) return `$${Math.round(v)}`;
  return `$${v.toFixed(2)}`;
}

function clock(at) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function dayLabel(day) {
  const [, m, d] = day.split("-");
  return `${Number(d)}/${Number(m)}`;
}

// --- The mod -----------------------------------------------------------------------------------

export default class TokenUsage extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.bar = !p.overlay;
    this.period = "today";
    this.machine = null; // a machine key, or null for all
    this.error = null;
    this.handle = cx.focus_handle();
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(this.bar ? BAR_EVERY : POPUP_EVERY, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (this.busy || (this.bar && appWindow()?.visible === false)) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      let more = false;
      try {
        more = await scanAll(cx);
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      try {
        await refreshRates();
      } catch (e) {
        this.ratesError = String(e?.message ?? e);
      }
      this.busy = false;
      cx.notify();
      if (more) {
        await cx.sleep(AGAIN);
        this.refresh(cx);
      }
    });
  }

  render() {
    return this.bar ? this.renderBar() : this.renderPopup();
  }

  // --- Bar ---

  renderBar() {
    const t = theme();
    const data = shared(DATA) ?? {};
    const known = Object.values(data).some((m) => m.data);
    const scanning = Object.values(data).some((m) => m.data?.left > 0);
    const { total, by } = today();
    const priced = shared(RATES) && total.cost > 0;
    const text = known ? `${count(tokens(total))} tok${priced ? ` · ~${money(total.cost)}` : ""}` : "tok …";
    const block = props()?.block;
    const want = Math.round(text.length * 7.2 + 26);
    if (block && this.shown !== want) {
      this.shown = want;
      run("layout.resize", { id: block, px: want });
    }
    const lines = PROVIDERS.filter((p) => by[p]).map((p) => `${LABEL[p]} ${count(tokens(by[p]))}${by[p].cost ? ` (~${money(by[p].cost)})` : ""}`);
    const tip = known
      ? `Token di oggi${scanning ? " (prima lettura dei log in corso)" : ""}: ${lines.join(" · ") || "nessuno"} · clic per il dettaglio`
      : this.error ?? "Leggo i log degli agenti…";
    return h_flex().id("tu-bar").size_full().px(8).gap(6).items_center().justify_center().bg(t.chrome)
      .text_size(11).whitespace_nowrap().cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => run("mod.open", { name: "token-usage" }))
      .child(h_flex().flex_none().h(12).items_end().gap(1)
        .children(PROVIDERS.map((p) => div().w(3).h(by[p] ? Math.max(2, Math.round(12 * tokens(by[p]) / Math.max(1, tokens(total)))) : 1)
          .bg(by[p] ? tint(p) : t.border))))
      .child(div().flex_none().text_color(this.error && !known ? t.blocked : t.muted).child(text));
  }

  // --- Popup ---

  renderPopup() {
    const t = theme();
    const overlay = props()?.overlay;
    const data = shared(DATA) ?? {};
    const keys = Object.keys(data);
    if (this.machine !== null && !keys.includes(this.machine)) this.machine = null;
    const list = rows(this.machine, this.period);

    const header = h_flex().items_center().gap(10).pb(10)
      .child(div().text_size(15).font_semibold().child("Token usati"))
      .child(div().flex_1().text_size(11).text_color(t.dim).truncate().child(this.status(data)))
      .child(div().text_size(11).text_color(t.dim).child("Esc"))
      .when(Boolean(overlay), (el) => el.child(div().id("tu-close").px(6).cursor_pointer().text_color(t.dim)
        .hover((s) => s.text_color(t.foreground)).on_click(() => closeOverlay(overlay)).child("✕")));

    const filters = h_flex().gap(16).pb(12).items_center()
      .child(this.chips("tu-period", PERIODS, this.period, (v) => { this.period = v; }, t))
      .when(keys.length > 1, (el) => el.child(this.chips("tu-machine",
        [[null, "Tutte le macchine"], ...keys.map((k) => [k, data[k].name])], this.machine, (v) => { this.machine = v; }, t)));

    const body = Object.values(data).some((m) => m.data)
      ? v_flex().gap(16).child(this.tiles(list, t)).child(this.chart(t)).child(this.table(list, t)).child(this.notes(list, t))
      : div().py(40).w_full().flex().justify_center().text_color(this.error ? t.blocked : t.dim).text_size(13)
        .child(this.error ?? "Leggo i log degli agenti… (la prima volta può volerci un minuto)");

    return v_flex().id("tu-popup").track_focus(this.handle).size_full().p(18).bg(t.popover).text_color(t.foreground)
      .child(header)
      .child(filters)
      .child(v_flex().id("tu-scroll").flex_1().min_h(0).overflow_y_scroll().child(body));
  }

  status(data) {
    const parts = [];
    for (const m of Object.values(data)) {
      if (m.data?.left > 0) parts.push(`${m.name}: lettura dei log, ${count(m.data.left)}B ancora`);
      else if (m.error && (!m.at || m.errorAt > m.at)) parts.push(`${m.name}: ${m.error}`);
    }
    const last = Math.max(0, ...Object.values(data).map((m) => m.at ?? 0));
    if (last) parts.push(`aggiornato alle ${clock(last)}`);
    if (this.busy) parts.push("aggiorno…");
    return parts.join(" · ");
  }

  chips(id, options, value, set, t) {
    return h_flex().gap(4).children(options.map(([v, text]) => {
      const on = v === value;
      return div().id(`${id}-${v ?? "all"}`).px(10).py(3).rounded(6).text_size(12).cursor_pointer()
        .bg(on ? t.selected : t.raised).text_color(on ? t.foreground : t.muted).border_1().border_color(on ? t.input : t.border)
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { set(v); cx.notify(); })
        .child(text);
    }));
  }

  tiles(list, t) {
    const total = EMPTY();
    for (const r of list) add(total, r, rateOf(r));
    const input = total.input + total.read + total.write;
    const cached = input ? Math.round((100 * total.read) / input) : 0;
    const tile = (id, label, value, sub) => v_flex().id(id).flex_1().p(12).gap(2).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(div().text_size(11).text_color(t.muted).child(label))
      .child(div().text_size(22).font_semibold().child(value))
      .child(div().text_size(11).text_color(t.dim).truncate().child(sub));
    return h_flex().gap(10)
      .child(tile("tu-t-tokens", "Token", count(tokens(total)), `${count(input)} in · ${count(total.output)} out`))
      .child(tile("tu-t-cost", "Costo API stimato", shared(RATES) ? money(total.cost) : "…",
        total.unpriced ? `${count(total.unpriced)} token senza prezzo` : "prezzi LiteLLM"))
      .child(tile("tu-t-req", "Richieste", count(total.count), `${count(total.reasoning)} token di ragionamento`))
      .child(tile("tu-t-cache", "Letti dalla cache", `${cached}%`, `${count(total.read)} su ${count(input)} in ingresso`));
  }

  /** Tokens per day, stacked by provider: the period, or the last 30 days for Oggi and Tutto. */
  chart(t) {
    const n = this.period === "today" || this.period === "all" ? 30 : Number(this.period);
    const data = shared(DATA) ?? {};
    const end = Object.values(data).map((m) => m.data?.today).filter(Boolean).sort().pop();
    if (!end) return div();
    const days = Array.from({ length: n }, (_, i) => shiftDay(end, i - n + 1));
    const per = new Map(days.map((d) => [d, {}]));
    for (const r of rows(this.machine, String(n))) {
      const at = per.get(r.day);
      if (at) at[r.provider] = (at[r.provider] ?? 0) + tokens(r);
    }
    const sum = (d) => PROVIDERS.reduce((a, p) => a + (per.get(d)[p] ?? 0), 0);
    const max = Math.max(1, ...days.map(sum));
    const H = 120;
    const present = PROVIDERS.filter((p) => days.some((d) => per.get(d)[p]));
    const legend = h_flex().gap(14).text_size(11).text_color(t.muted)
      .child(div().flex_1().text_color(t.foreground).font_medium().child(`Token al giorno · ultimi ${n} giorni`))
      .children(present.map((p) => h_flex().gap(5).items_center()
        .child(div().w(8).h(8).rounded(2).bg(tint(p))).child(LABEL[p])));
    const bars = h_flex().h(H).items_end().gap(2).children(days.map((d) => {
      const parts = PROVIDERS.filter((p) => per.get(d)[p]).reverse();
      const total = sum(d);
      const tip = total
        ? `${dayLabel(d)}: ${count(total)} · ${PROVIDERS.filter((p) => per.get(d)[p]).map((p) => `${LABEL[p]} ${count(per.get(d)[p])}`).join(" · ")}`
        : `${dayLabel(d)}: nessun token`;
      return v_flex().id(`tu-bar-${d}`).flex_1().h_full().justify_end().gap(2).tooltip(tip)
        .hover((s) => s.opacity(0.8))
        .children(total ? parts.map((p, i) => {
          const h = Math.max(1, Math.round(((per.get(d)[p] ?? 0) / max) * (H - 4)));
          const seg = div().w_full().h(h).bg(tint(p));
          return i === 0 ? seg.rounded_t(3) : seg;
        }) : [div().w_full().h(1).bg(t.border)]);
    }));
    const axis = h_flex().text_size(10).text_color(t.dim)
      .child(div().flex_1().child(dayLabel(days[0])))
      .child(div().flex_1().text_center().child(dayLabel(days[Math.floor(n / 2)])))
      .child(div().flex_1().text_right().child(dayLabel(days[n - 1])));
    return v_flex().gap(8).p(12).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(legend)
      .child(h_flex().gap(8).items_end()
        .child(v_flex().h(H).justify_between().text_size(10).text_color(t.dim).w(36).text_right()
          .child(count(max)).child(count(max / 2)).child("0"))
        .child(v_flex().flex_1().gap(4).child(bars).child(axis)));
  }

  table(list, t) {
    const by = new Map(); // provider -> { total, models: Map(model -> totals) }
    for (const r of list) {
      const rate = rateOf(r);
      const p = by.get(r.provider) ?? { total: EMPTY(), models: new Map() };
      by.set(r.provider, p);
      add(p.total, r, rate);
      const m = p.models.get(r.model) ?? EMPTY();
      p.models.set(r.model, add(m, r, rate));
      m.priced = Boolean(rate);
    }
    const cols = [["Richieste", 70], ["Input", 70], ["Cache lett.", 84], ["Cache scr.", 84], ["Output", 70], ["Totale", 76], ["Costo", 72]];
    const cells = (v, priced) => [count(v.count), count(v.input), count(v.read), count(v.write), count(v.output), count(tokens(v)),
      priced === false ? "—" : (shared(RATES) ? money(v.cost) : "…")];
    const line = (id, name, values, opts) => h_flex().id(id).py(opts.head ? 6 : 4).px(8).gap(4).items_center().text_size(12)
      .when(Boolean(opts.head), (el) => el.bg(t.raised).rounded(6).font_semibold())
      .child(h_flex().flex_1().min_w(0).gap(6).items_center()
        .when(Boolean(opts.color), (el) => el.child(div().flex_none().w(8).h(8).rounded(2).bg(opts.color)))
        .child(div().truncate().pl(opts.indent ? 14 : 0).text_color(opts.dim ? t.muted : t.foreground).child(name)))
      .children(values.map((v, i) => div().flex_none().w(cols[i][1]).text_right().whitespace_nowrap()
        .text_color(opts.label ? t.dim : (opts.dim ? t.muted : t.foreground)).child(v)));
    const providers = PROVIDERS.filter((p) => by.has(p));
    if (!providers.length) {
      return div().py(20).w_full().flex().justify_center().text_color(t.dim).text_size(12).child("Nessun token in questo periodo");
    }
    return v_flex().gap(2)
      .child(line("tu-h", "Modello", cols.map((c) => c[0]), { label: true, dim: true }))
      .children(providers.flatMap((p) => {
        const v = by.get(p);
        const models = [...v.models.entries()].sort((a, b) => tokens(b[1]) - tokens(a[1]));
        return [
          line(`tu-p-${p}`, LABEL[p], cells(v.total), { head: true, color: tint(p) }),
          ...models.map(([m, mv]) => line(`tu-m-${p}-${m}`, m, cells(mv, mv.priced), { indent: true, dim: true })),
        ];
      }));
  }

  notes(list, t) {
    const unpriced = [...new Set(list.filter((r) => !rateOf(r)).map((r) => r.model))];
    const rates = shared(RATES);
    const text = [
      "Costo: quanto costerebbero gli stessi token con l'API, ai prezzi pubblici LiteLLM (base, senza fasce long-context o fast). Con un abbonamento non è quanto paghi.",
      unpriced.length && rates ? `Senza prezzo: ${unpriced.join(", ")}.` : null,
      this.ratesError ? `Prezzi non aggiornati: ${this.ratesError}` : null,
    ].filter(Boolean).join(" ");
    return div().text_size(11).text_color(t.dim).whitespace_normal().child(text);
  }
}
