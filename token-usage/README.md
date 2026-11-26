# token-usage

The tokens your coding agents used, like the Usage page of [t3code](https://github.com/pingdotgg/t3code):
today's total in the top bar, and a popup (`ctrl-shift-u`) with the details.

- **Bar**: today's tokens on every machine and what they would cost through the API
  (`2.4B tok · ~$681`), with a small bar per agent. Hover it for the split by agent; click it for
  the popup.
- **Popup**: choose a period (today, 7, 30 or 90 days, everything) and a machine from two drop-down menus. It shows the
  totals (tokens, estimated cost, requests, share of input read from the cache), a chart of tokens
  per day stacked by agent, and a table by agent and model: requests, fresh input, cache reads,
  cache writes, output, total and cost.

The agents: Claude Code, Codex and Kimi Code. The totals count cache reads, which are most of an
agent's input. That's why a day reaches billions of tokens.

**About the cost**: it is what the same tokens would cost through the API, at the public prices in
[LiteLLM's table](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)
(the same table t3code uses), fetched once a day. Base prices only: no long-context or fast-mode
tiers. With a subscription, this isn't what you pay. A model missing from the table (Codex's
`codex-auto-review`, for example) shows "—" and is listed under the table.

## How it works

`tokens.py` runs on each machine the app knows. It needs only `python3` there, nothing to
install. The Windows app's own machine uses `python`. It reads the agents' own session logs:

| Agent | Logs | One request is |
| --- | --- | --- |
| Claude Code | `~/.claude*/projects/**/*.jsonl` (and `$CLAUDE_CONFIG_DIR`) | an assistant message's `usage`, once per message and request id |
| Codex | `$CODEX_HOME/sessions`, `archived_sessions` | a `token_usage_record`, once per `response_id`; older rollouts: a `token_count` snapshot, once per cumulative total. The model comes from the latest `turn_context` |
| Kimi Code | `~/.kimi*/sessions/**/wire.jsonl` | a `usage.record` |

Counting each request once matters:
- Claude Code writes a message once per content block, and a resumed session copies earlier
  messages into its new file.
- Codex forks and Kimi sessions copy their parent's records.

Each request is one row in `~/.local/state/herdr-token-usage/usage.db` (SQLite). The same file
remembers how far each log was read, so later runs read only what was added.

The first run reads every log, in 20-second steps: about 7 GB took half a minute. After that, a
run takes well under a second. The bar rescans every minute, and the popup every 30 seconds
while it is open. Days follow the app's time zone.

To start over: `python3 tokens.py reset` deletes the database.

## Install

In the app, open Mod Manager and install from `https://github.com/l1ego/herdr-mods`, then choose
the `token-usage` package. It adds `ctrl-shift-u` to `keys.json`.

For the bar, add this block to your layout's top bar:

```json
{ "id": "tokens", "type": "block", "size": { "px": 0 }, "window_drag": true,
  "content": { "mod": "token-usage", "props": { "block": "tokens" } } }
```

`block` is the block's own id: the bar resizes it to fit its text.
