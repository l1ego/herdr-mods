# agent-questions

The questions your coding agents asked you, in one popup over the Herdr app window
(`ctrl-shift-q`), like the lazygit popup.

Codex asks with `request_user_input_async`, which returns at once, and its question card closes
when the turn ends, answered or not. The maintainers say this is intended
([openai/codex#49146](https://github.com/openai/codex/issues/49146)), so a question asked just
before the end of a turn is easy to miss. This popup keeps it:

- Each question shows the agent, its space and tab, how long ago it was asked, and whether the
  Codex card is still there ("turno in corso") or gone ("turno chiuso").
- Click an option, or "Altro…" to write the answer. It is typed into the agent's terminal in
  Codex's own reply format, so Codex shows it as `↪ Re: <question>` and reads it as the card's
  answer, even after the turn ended.
- "Vai →" goes to the agent's terminal; "Ignora" hides the question.
- A Codex question leaves the list once it is answered, or once you send that agent another
  message after its turn ended.
- Claude Code's `AskUserQuestion` waits in its terminal: it is listed with its options and
  "Vai →" (answer it there).

An optional badge for the bar ("? 2") checks every 6 seconds, posts a toast when a Codex turn ends
with a question unanswered, and opens the popup when clicked. It takes no room when there are no
questions.

## How it works

`questions.py` runs on the machine where the agents run (`python3 -I -c`, nothing to install
there). It finds each agent's session from its terminal's `resume` label, written by
[agent-resume](../agent-resume), reads the Codex rollout or the Claude Code transcript from where
it stopped last time (rollouts reach hundreds of MB; a new one is read from its last 32 MB), and
keeps what it found in `~/.local/state/herdr-agent-questions/cache.json`. Questions older than
3 days are dropped.

Needs: `python3` on the agents' machine, and agent-resume installed (agents started before it
have no `resume` label and are not seen).

## Install

In the app, open Mod Manager and install from `https://github.com/l1ego/herdr-mods`, then choose
the `agent-questions` package; it adds `ctrl-shift-q` to `keys.json`.

For the badge, add this block to your layout's top bar (herdr-omarchy already has it):

```json
{ "id": "questions", "type": "block", "size": { "px": 0 },
  "content": { "mod": "agent-questions", "props": { "badge": true, "block": "questions" } } }
```

`block` is the block's own id: the badge resizes it to 46 px when there are questions and back to 0.
