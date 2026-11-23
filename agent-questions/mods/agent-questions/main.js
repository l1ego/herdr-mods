// Questions coding agents asked you, in one popup (ctrl-shift-q), like the lazygit popup.
//
// Codex asks with `request_user_input_async` and closes the question's card when its turn
// ends, even if nobody answered. This mod finds those questions in the agents' session files
// (questions.py, run on the agents' machine) and answers them by typing Codex's own reply
// format into its terminal, so Codex reads it as the card's answer. Claude Code's
// `AskUserQuestion` waits in its terminal: it is listed with a jump to it.
//
// Two copies of the same mod:
// - props.badge: a small "? 2" in the bar. It checks every few seconds, shares what it found
//   (`shared("agent-questions")`), posts a toast when a Codex turn ends with a question
//   unanswered, and opens the popup when clicked. It shrinks its block to nothing when there
//   are no questions (props.block: the block's id in the layout).
// - the popup (mod.open:agent-questions): the list, with the options as buttons, "Altro…" for
//   a written answer, "Vai" to the agent's terminal and "Ignora".

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  props, run, theme, terminals, agents, exec, hc, readTextFile, appHome, notify, shared, setShared,
  closeOverlay, checking,
} from "herdr";

const SHARED = "agent-questions";
const DISMISSED = "agent-questions.dismissed";
const BADGE_EVERY = 6000;
const POPUP_EVERY = 3000;
const BADGE_WIDTH = 46;

// --- Finding questions -------------------------------------------------------------------------

let script = null;

function machineOf(address) {
  return address.includes("/") ? address.split("/")[0] : null;
}

function bare(address) {
  return address.includes("/") ? address.split("/").pop() : address;
}

/** Every question the agents are waiting on, newest first, on every machine with agents. */
async function scan() {
  script ??= await readTextFile(`${appHome()}/mods/agent-questions/questions.py`);
  if (!script) throw new Error("questions.py is missing");
  const machines = new Map();
  for (const t of terminals()) {
    const app = [t.report?.app, t.program?.key, t.name].filter(Boolean).join(" ").toLowerCase();
    if (!/codex|claude/.test(app) || t.state === "finished") continue;
    const on = machineOf(t.address);
    if (!machines.has(on)) machines.set(on, []);
    machines.get(on).push({ address: bare(t.address), app, labels: t.labels ?? {} });
  }
  const found = [];
  for (const [on, list] of machines) {
    const r = await exec("python3", ["-I", "-c", script, "list", JSON.stringify(list)], { on, timeout: 60000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || "questions.py failed").trim().slice(0, 300));
    for (const q of JSON.parse(r.stdout || "[]")) {
      found.push({ ...q, terminal: on ? `${on}/${q.terminal}` : q.terminal, key: `${on ?? ""}:${q.key}` });
    }
  }
  return found.sort((a, b) => b.asked - a.asked);
}

function dismissed() {
  return new Set(shared(DISMISSED) ?? []);
}

function visible() {
  const gone = dismissed();
  return (shared(SHARED)?.list ?? []).filter((q) => !gone.has(q.key));
}

// --- Answering ---------------------------------------------------------------------------------

/** Codex's reply to an async question card, the text its own card sends. */
function codexReply(q, question, answer) {
  const item = {
    answer,
    question: question.title.slice(0, 400),
    questionItemId: JSON.stringify(["request_user_input_async", q.call, question.index]),
  };
  return `<send_user_message_question_reply>\n${JSON.stringify([item])}\n</send_user_message_question_reply>`;
}

function where(address) {
  const a = agents().find((x) => x.address === address);
  return a ? [a.space_name, a.tab_name].filter(Boolean).join(" · ") : address;
}

function ago(seconds) {
  const s = Math.max(0, Date.now() / 1000 - seconds);
  if (s < 60) return "ora";
  if (s < 3600) return `${Math.floor(s / 60)} min fa`;
  if (s < 86400) return `${Math.floor(s / 3600)} h fa`;
  return `${Math.floor(s / 86400)} g fa`;
}

// --- The mod -----------------------------------------------------------------------------------

export default class AgentQuestions extends View {
  init(_props, cx) {
    this.badge = Boolean(props()?.badge);
    this.sent = new Map(); // "key#index" -> answer typed into the terminal
    this.error = null;
    this.other = null; // "key#index" of the open "Altro…" box
    this.input = InputState.new({ value: "" });
    this.input.on("submit", (_e, cx) => this.submitOther(cx));
    this.handle = cx.focus_handle();
    if (checking()) return;
    if (this.badge) {
      this.seen = null; // keys already announced; null until the first scan
      this.shown = null;
    }
    this.refresh(cx);
    cx.timer.every(this.badge ? BADGE_EVERY : POPUP_EVERY, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const list = await scan();
        this.error = null;
        setShared(SHARED, { list, at: Date.now() });
        if (this.badge) this.announce(list);
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  /** A toast for each Codex question whose turn ended unanswered (its card is gone). */
  announce(list) {
    const gone = dismissed();
    const lost = list.filter((q) => q.agent === "codex" && q.turn === "closed" && !gone.has(q.key));
    if (this.seen) {
      for (const q of lost) {
        if (this.seen.has(q.key)) continue;
        notify({
          title: "Codex aspetta una risposta",
          body: `${where(q.terminal)}: ${q.questions[0]?.title.slice(0, 140) ?? ""}`,
          level: "warning",
          action: { name: "mod.open", args: { name: "agent-questions" } },
        });
      }
    }
    this.seen = new Set(lost.map((q) => q.key));
  }

  async answer(q, question, text, cx) {
    const id = `${q.key}#${question.index}`;
    this.sent.set(id, text);
    this.other = null;
    cx.notify();
    const r = await hc(["send", q.terminal, codexReply(q, question, text)]).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
    if (r.code !== 0) {
      this.sent.delete(id);
      notify({ title: "Risposta non inviata", body: (r.stderr || r.stdout || "").trim().slice(0, 300), level: "error" });
    }
    cx.notify();
  }

  openOther(id, cx) {
    this.other = id;
    this.input.set_value("");
    this.input.focus();
    cx.notify();
  }

  submitOther(cx) {
    const text = this.input.value().trim();
    if (!text || !this.other) return;
    const [key, index] = this.other.split("#");
    const q = visible().find((x) => x.key === key);
    const question = q?.questions.find((x) => String(x.index) === index);
    if (q && question) cx.spawn(async (cx) => this.answer(q, question, text, cx));
  }

  dismiss(q) {
    setShared(DISMISSED, [...dismissed(), q.key].slice(-300));
  }

  go(q) {
    run("pane.focus", { terminal: q.terminal });
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
  }

  render(cx) {
    return this.badge ? this.renderBadge() : this.renderPopup();
  }

  // --- Badge ---

  renderBadge() {
    const t = theme();
    const list = visible();
    const lost = list.some((q) => q.agent === "codex" && q.turn === "closed");
    const block = props()?.block;
    const want = list.length ? BADGE_WIDTH : 0;
    if (block && this.shown !== want) {
      this.shown = want;
      run("layout.resize", { id: block, px: want });
    }
    const row = h_flex().id("aq-badge").size_full().items_center().justify_center().bg(t.chrome);
    if (!list.length) return row;
    const color = lost ? t.blocked : t.accent;
    return row.cursor_pointer().gap(4).text_size(12).font_semibold().text_color(color)
      .hover((s) => s.bg(t.hover))
      .tooltip(lost ? "Domande senza risposta degli agenti" : "Domande degli agenti")
      .on_click(() => run("mod.open", { name: "agent-questions" }))
      .child(svg("mods/agent-questions/question.svg").size(14))
      .child(div().child(String(list.length)));
  }

  // --- Popup ---

  renderPopup() {
    const t = theme();
    const list = visible();
    const overlay = props()?.overlay;
    const header = h_flex().items_center().gap(10).pb(12)
      .child(div().flex_1().text_size(15).font_semibold().child("Domande degli agenti"))
      .when(Boolean(this.error), (el) => el.child(div().text_size(11).text_color(t.blocked).max_w(360).truncate().child(this.error)))
      .child(div().text_size(11).text_color(t.dim).child("Esc"))
      .when(Boolean(overlay), (el) => el.child(div().id("aq-close").px(6).cursor_pointer().text_color(t.dim)
        .hover((s) => s.text_color(t.foreground)).on_click(() => closeOverlay(overlay)).child("✕")));
    const body = list.length
      ? v_flex().gap(10).children(list.map((q) => this.card(q, t)))
      : div().py(40).w_full().flex().justify_center().text_color(t.dim).text_size(13)
        .child(shared(SHARED) ? "Nessuna domanda in attesa" : "Cerco le domande…");
    return v_flex().id("aq-popup").track_focus(this.handle).size_full().p(18).bg(t.popover).text_color(t.foreground)
      .child(header)
      .child(v_flex().id("aq-list").flex_1().min_h(0).overflow_y_scroll().child(body));
  }

  card(q, t) {
    const codex = q.agent === "codex";
    const state = codex
      ? (q.turn === "closed" ? ["turno chiuso: la card in Codex non c'è più", t.blocked] : ["turno in corso", t.accent])
      : ["aspetta nel terminale", t.accent];
    return v_flex().id(`aq-${q.key}`).p(12).gap(8).rounded(8).border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().items_center().gap(8).text_size(11.5)
        .child(div().font_semibold().text_color(t.foreground).child(codex ? "Codex" : "Claude Code"))
        .child(div().text_color(t.muted).truncate().child(where(q.terminal)))
        .child(div().text_color(state[1]).child(state[0]))
        .child(div().flex_1())
        .child(div().text_color(t.dim).child(ago(q.asked))))
      .children(q.questions.map((question) => this.question(q, question, t)))
      .child(h_flex().gap(8).justify_end()
        .child(this.button(`aq-dismiss-${q.key}`, "Ignora", t, false, () => this.dismiss(q)))
        .child(this.button(`aq-go-${q.key}`, "Vai →", t, false, () => this.go(q))));
  }

  question(q, question, t) {
    const id = `${q.key}#${question.index}`;
    const sent = this.sent.get(id);
    const el = v_flex().gap(8)
      .child(div().text_size(13).whitespace_normal().child(question.title));
    if (sent !== undefined) {
      return el.child(div().text_size(12).text_color(t.muted).child(`Inviata: ${sent}`));
    }
    if (!q.answerable) {
      return el.when(question.options.length > 0, (e) => e.child(h_flex().flex_wrap().gap(6)
        .children(question.options.map((o, i) => div().id(`aq-o-${id}-${i}`).px(10).py(5).rounded(6).border_1()
          .border_color(t.border).text_size(12).text_color(t.muted).child(o)))));
    }
    const options = h_flex().flex_wrap().gap(6)
      .children(question.options.map((o, i) => this.button(`aq-o-${id}-${i}`, o, t, i === 0,
        (_e, cx) => cx.spawn(async (cx) => this.answer(q, question, o, cx)))))
      .child(this.button(`aq-other-${id}`, "Altro…", t, false, (_e, cx) => this.openOther(id, cx)));
    let box = el.child(options);
    if (this.other === id) {
      box = box.child(h_flex().gap(6)
        .child(Input.new(this.input).flex_1().h(32).px(10).rounded(8).border_1().border_color(t.accent).bg(t.background)
          .text_size(12.5).text_color(t.foreground))
        .child(this.button(`aq-send-${id}`, "Invia", t, true, (_e, cx) => this.submitOther(cx))));
    }
    return box;
  }

  button(id, text, t, primary, action) {
    return h_flex().id(id).min_h(28).px(12).py(4).items_center().rounded(7).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(div().whitespace_normal().child(text));
  }
}
