# pi-context-bar

Open-sided editor with a full-width Pac-Man top row and a bottom information rule for [pi](https://pi.dev).

Model, cache hit, and cost live in the editor frame — zero extra chrome rows. The Pac-Man strip owns the full top row, without short rule caps at either end.
Slash-command autocomplete stays above the framed editor instead of expanding inside it.

Scope is editor chrome, not conversation rendering: assistant messages, thinking content,
tool calls/results, and compaction notices stay native Pi. The extension wraps the editor,
replaces the welcome header/footer, and hides the redundant working row through Pi's UI APIs;
it does not patch Pi core or replace conversation renderers. If a Pi update changes the editor's
render shape, the extension stops framing, restores Pi's footer and working row, and keeps Pi's own
editor, reporting it once per session rather than framing rows it cannot identify.

```
      󰮯 • • • • • • ○ • • ○ • • • • • • 15.7% (200K) 󰓅 ~42.3t/s
❯ hello
── gpt-5.6-sol · medium ───────────────────────────── 󰆼 98%  $1.61 ─────
```

Without a Nerd Font, the same frame uses `C` / `O`, plain pellets, `CH`, and `t/s`:

```
     C . . . . . . o . . . o . . 15.7% (200K) ~42.3t/s
> hello
── gpt-5.6-sol · medium ────────────────── CH98%  $1.61 ───
```

See the [real PTY demo](docs/demo.cast), recorded against an offline fixture with **simulated usage**,
not a live provider benchmark. Replay with `asciinema play docs/demo.cast`; the recording includes
native debug-snapshot notices from the smoke test.

Pac-Man moves left → right using Pi's native context usage. Eaten pellets become empty space; pellets ahead are remaining capacity. While the agent runs, a state-colored ghost chases the boundary and Pac-Man chomps; both rest when idle. The chomping mouth and the ghost carry activity, and chomp speed is driven by live token throughput, so a slow turn is directly visible as slow chomping. When Pi reports no usable reading (right after compaction, before the next usable response), the frame shows a dim `?%` and a neutral lane instead of a false `0.0%`, and Pac-Man never rewinds to zero on an unknown reading.

Every element uses Pi's active theme tokens, including truecolor/256-color capability overrides. Pac-Man is `text`, pellets are `dim`, power pellets are `muted`, and the ghost carries three states: `muted` while work has started but nothing is streamed yet, `accent` while the model is generating (reasoning or tool-call arguments), `success` while the answer itself streams. Reasoning and tool calls share a color on purpose: Omarchy's palette offers exactly one hue that is neither identity nor a state, so a fourth phase color would have to borrow a markdown or syntax role that some themes map onto the accent or onto red. `warning` and `error` stay reserved for crossed thresholds and failure, the way Omarchy keeps `urgent` for attention alone, so an active phase never reads as a problem. The frame is `borderMuted`, switching to `bashMode` while the input starts with `!`. Semantic border and metric colors follow live theme changes. The ghost rests at `agent_settled`, not an intermediate `agent_end` that may still retry or continue.

## Why

More conversation, less dashboard. Model identity and health share the editor's existing borders,
instead of adding persistent footer rows. Position shows context, token-driven motion shows activity,
and quiet numbers show cache, cost and throughput. Conversation and tool rendering remain native Pi.

This is an opinionated editor frame, not a general-purpose statusline builder. It deliberately omits
Git, paths, multi-line tool dashboards, and layout presets. Other plugins already offer cache/cost
metrics and richer context breakdowns; the distinction here is the compact layout and visual language.

## Layout

| Zone | Content |
|------|---------|
| Editor border left | model id (accent) · dim thinking level |
| Editor body | `❯` prompt (accent) · typed input |
| Editor border right | cache database · optional `$` |
| Pac-Man lane | empty consumed space → phase ghost while running → text Pac-Man → dim remaining pellets |
| Right-aligned metrics | native `%` · optional token speed `t/s` |

Healthy metrics stay dim; accent marks the model and ready prompt, and warning/error colors mark thresholds and failure only. The Pac-Man strip spans the top row without `─` caps or filler; only the bottom keeps a horizontal rule. No side borders, corners, background fills, or extra rows. The prompt is flush left, followed by one space; continuation rows align with typed text. The right gutter and bottom metric positions stay unchanged; scroll counts remain visible.

## Icons

Nerd Font icons decorate information that is already in the frame; they never add a metric. Each drops back to plain text (or disappears) before any useful model, quota, cache, cost, context-window, or speed reading is lost.

| Information | Nerd Font icon | ASCII fallback |
|---|---|---|
| Cache hit | `md-database` `󰆼` replaces the `CH` label (`󰆼 98/94%`) | `CH98/94%` |
| Token speed | dim `md-speedometer` `󰓅` before `t/s` (`󰓅 ~218t/s`) | `~218t/s` |
| Remaining pellets | dim `•`, muted power pellet `○` at the 70% / 90% ratios | dim `.`, muted power pellet `o` |

Thinking levels stay plain dim text (`· high`, routed thinking included); there is no thinking icon. When the icon itself does not fit, the Nerd cache label keeps the bare percent (`98/94%`) because that is two columns narrower than the `CH` label, and the number matters more than the label. The cache latest/average math and threshold colors are unchanged.

The model id is accent and plain, with thinking dim after it. When the latest completed turn ends in a provider error the prompt becomes `✗` in the error token, until a turn finishes without error; user aborts keep the previous state. Context-window size stays dim even when usage warns. Wide lanes (80+ columns) space cells three columns apart instead of two, without capping the track; in Nerd mode circular `○` power pellets mark the 70% / 90% thresholds, and ASCII uses `o`.

With a virtual model selected, the bottom border shows `auto · high → physical-model · medium` for the latest successful response on the active branch. Narrow borders drop thinking and route detail before the selected model. Context limits still come directly from Pi, which accounts for the routed physical model.

Session cost includes standalone usage entries (such as cache warming) and nested model work reported by tool results. New OpenAI ChatGPT assistant turns record their request-time billing identity in non-context custom entries, so switching between OpenAI API keys and ChatGPT login never reclassifies earlier bills. Legacy `openai-codex` and `ln` reference costs remain excluded. Other providers keep their existing cost semantics, since subscription OAuth can include billed extra usage. Older untagged turns and tool/summary usage retain their reported costs; these are catalog estimates, not provider invoices.

## Subscription quota

OpenAI Codex subscription quota sits beside the model label:

- **OpenAI Codex (ChatGPT Plus/Pro)**: windows such as `5h 53%` and `7d 43%` from provider metadata or `/wham/usage`. Healthy windows stay quiet with just their label and used percent, matching the editor's warning threshold. A window above 70% shows a dim `󰦛 2h 30m` countdown to its reset (ASCII `r2h 30m`) next to that window only; exactly 70% is still quiet, and a healthy sibling window is never expanded. A dim `󰔖 <n>` count (ASCII `R<n>`) appears only while any reported quota (including the weekly percent) is above 70%; zero or unknown credits stay hidden. The border first fits the model, window percentages, and cache/cost, then spends only spare width on countdowns and credits, so optional detail never pushes out a useful number; on narrow borders those optional fields drop before any window percentage.

Quota has two read paths:

- **Passive response metadata first:** physical `openai-responses` and `openai-codex-responses`
  models can publish `x-codex-{primary,secondary}-{used-percent,reset-at,window-minutes}` response
  headers or `codex.rate_limits` stream events. This path performs no quota credential lookup or
  network request, including with new `/login openai` authentication and compatible proxies.
  The provider/transport must actually forward the metadata; compatibility is not inferred from login.
- **Legacy official fallback:** physical `openai-codex` models on the official ChatGPT endpoint still
  query `/wham/usage` at startup and on activity, at most once a minute. Fresh passive windows
  suppress activity queries. A failed official query keeps its last good snapshot. Proxy endpoints,
  new OpenAI authentication and virtual models never receive this legacy query.

Passive snapshots replace both windows rather than merging different upstream credentials. They are
cleared before the next request and on model/endpoint changes; delayed replies cannot overwrite a
newer passive snapshot. Missing, malformed and expired windows are hidden, including on the next
render after expiry; real 0% stays visible. Labels use reported durations, not guessed 5h/7d defaults.
There is no idle quota timer. These are the responding upstream's limits, **not a proxy-pool total**.
Banked reset credits come only from the official query; passive metadata never inherits an older
response's credits. `/context-bar status` shows the source, timestamp and availability reason.

Virtual selections keep quota and reset disabled. Reset redemption remains legacy official-only;
passive quota support does not make different credentials or proxy endpoints safe for reset calls.

### `/openai-codex-reset`

Redeems one banked OpenAI usage-limit reset (refreshes eligible 5h/weekly windows). It selects soonest-expiring reset first and lists every banked reset with its remaining time and absolute expiry (marking the selected one) before confirmation, then refreshes quota immediately after the consume response.

**Compatibility caveat:** this uses ChatGPT's internal `/wham/rate-limit-reset-credits` endpoints, not a public stable API; OpenAI may change them. Requests are limited to the official `https://chatgpt.com` origin, reject redirects, time out after 15 seconds, and cap response bodies at 64 KiB. Before consuming a reset, the command re-resolves Pi's OAuth token and cancels if account changed. Confirmation precedes the mutating POST. If outcome is uncertain, a pending record stores selected credit and idempotency key under Pi's agent directory; rerunning the command retries the same request. Use `/openai-codex-reset forget-pending` only after checking usage—forgetting an applied request can allow another reset to be spent.

Reset and `forget-pending` commands share an exclusive filesystem lock, held through confirmation and the consume response. Other terminals fail without touching the record. A crash leaves `pi-context-bar-reset-pending.json.lock` behind: stop **all Pi processes sharing that agent directory** before removing only this empty lock directory. Keep the pending JSON and retry its same request. Locks never expire automatically; removing a live lock or deleting an uncertain pending record can spend another credit. Expired credits are excluded and the selected credit is checked again after confirmation.

Only the exact known completed consume codes `reset` and `already_redeemed` allow automatic pending cleanup. Every other code (including unfamiliar future codes, case variants, and malformed values) is treated as `unknown`, as is every HTTP failure, whose error body is never read; the pending credit and request ID remain unchanged for a confirmed retry. If the reset is confirmed but that cleanup fails, the command reports it as applied (not uncertain) and warns that the saved request may already be gone; check usage before rerunning, because a new run can select a new credit.

Token speed appears as estimated `~Nt/s` while output streams, then uses provider-reported output tokens for the completed turn's `Nt/s`. Timing starts at the first output delta and excludes tool-execution gaps.

Top row carries context consumption (lane, `%` with the model's context-window size, `t/s`); bottom left carries session identity (model · thinking); bottom right carries session health (`CH`, cost). The lane stretches with the window, using the columns previously reserved for short rule caps.

`CH` shows the latest turn's cache hit rate (pi's built-in footer semantics). When the session's token-weighted average diverges from it by more than 5 points, the average joins the label as `CH98/94%` (latest/average), so a quietly drifting hit rate cannot mislead; the average is dim and the latest turn keeps the warning/error coloring.

## Startup

A quiet welcome header appears immediately: pi's mark drawn as half blocks (`▀▀█` / `█▀ █`) in accent with the version dim beside it, then the resolved keybinding hints (`esc interrupt · ctrl+c exit · / commands · ! bash · …`) on the mark's second row. Rows align with the editor's prompt column, with keys in accent and descriptions dim. The mark is single-color silhouette art, the way Omarchy prints its own logo, so it inherits whatever theme is active instead of carrying brand colors. Keys are read from your actual keybindings, so remaps show correctly, and the expand keybinding toggles a full hint list. On terminals that misalign half blocks or cannot fit the mark, the header falls back to the plain `pi vX` wordmark; Apple Terminal triggers that fallback automatically, matching Pi's own logo check. In ASCII mode the wordmark is chosen up front. No model or cwd repeats — those already live in the editor border and your shell.

`"quietStartup": true` in `~/.pi/agent/settings.json` hides this header too, leaving Pi's loaded-resources rows out and the startup output empty as the setting intends; `"header"` keeps the header and drops the resource details. Resource details remain available via `/status`.

## Font requirement

Pac-Man `󰮯` (open mouth), `󰝥` (`md-circle`, closed mouth), Ghost `󰊠`, and the `md-*` chrome icons (reset `󰦛`, reset credits `󰔖`, database `󰆼`, speedometer `󰓅`) are Material Design glyphs present since Nerd Font **v3.0.0**. Configure your terminal profile to use a **Nerd Font** for the full chrome; installing the font without selecting it in the terminal is not enough. **JetBrainsMono Nerd Font Mono** is recommended because its icons stay single-cell and keep the lane aligned.

Terminals without a Nerd Font (SSH into a remote box, a locked-down corporate profile) fall back to ASCII glyphs via one config file — see [Config](#config).

## Other chrome extensions

`pi-context-bar` claims Pi's editor slot plus the header and footer slots: the header, an empty footer, and the framed editor component. Pi keeps exactly one owner per slot and the **last extension to install wins**, so a second chrome extension silently replaces part of this one rather than merging with it:

| Extension | Claims | Running it with `pi-context-bar` |
|-----------|--------|----------------------------------|
| [`pi-footer-minimal`](https://github.com/kaushikgopal/pi-kaush/tree/main/extensions/pi-footer-minimal) | footer | replaces the empty footer row; Pi's native stats return, and this extension's decisions about where health lives no longer hold |
| [`pi-welcome-screen`](https://github.com/kaushikgopal/pi-kaush/tree/main/extensions/pi-welcome-screen) | header | replaces the quiet mark + hints header with its centered resource panel |

Install order decides the winner, so pick one chrome extension per slot instead of relying on it.

### Inspect hidden extension statuses

`/context-bar status` shows a read-only diagnostic notification: model, glyph mode, config path,
native context estimate, latest/weighted cache hit, cost/speed semantics, quota source/time/reason,
and current statuses published by other extensions through `ctx.ui.setStatus()`.

The normal footer stays empty. Status inspection never dispatches a slash command, opens another
extension, sends a model message, or fetches quota. External status text has terminal controls and
bidirectional overrides removed; inspection is bounded to 64 entries and 4096 characters per field.
If another extension replaced our footer, or the editor fell back to native layout, that status
source is unavailable rather than a retained stale snapshot.

## Install

```bash
pi install git:github.com/bgtendtofree/pi-context-bar
# local checkout
pi install -l file:./
```

Remove with `pi remove pi-context-bar`.

## Config

Write `~/.pi/agent/pi-context-bar.json` as strict JSON (no comments):

```json
{
	"asciiFallback": true
}
```

`asciiFallback: true` uses C / O / 0 icons, `.` / `o` pellets, and the `> / x` prompt for terminals without a Nerd Font. The `•` and `○` pellets are ambiguous-width glyphs that some CJK fonts draw two columns wide; ASCII's `.` and `o` are always single-cell, so the lane budget holds without a font change.

The file is read once at startup; a missing or corrupt file silently uses defaults.

`/context-bar ascii-fallback [on|off|toggle]` switches the same glyph set for the rest of the session (an omitted mode toggles), so a terminal can be checked without editing the file. The switch is runtime only: nothing is written, and the next session start reads the file again — the file stays the single source of truth, and this command never has to rewrite keys it does not own.

## Dev

```bash
mise install
npm ci
npm run quality        # Biome CI check
npm run typecheck      # TypeScript 7
npm test               # node:test
npm run test:coverage  # Node coverage with 90% gates
npm run smoke:package  # npm production-install smoke
npm run smoke:tui      # offline POSIX PTY smoke; Python 3 required
npm run ci             # full CI pipeline
```

Coverage gates every runtime module: `commands/`, `lib/`, and the Pi/TUI adapter in `ui/` at ≥90% lines/functions/branches, and `index.ts` separately at ≥80% lines/functions/branches.

The PTY smoke starts an isolated Pi against a loopback-only fake Responses service, using a dummy
key and temporary agent directory. It exercises regular/fullscreen modes, both glyph sets, Chinese
drafts and prompts, 100→36→100-column resizes, autocomplete above the frame, runtime glyph switching,
passive quota, hidden extension status inspection, and clean shutdown. Native `/debug` render
snapshots assert widths and the absence of extra footer rows. It tests terminal output/layout, not
font rasterization or real provider authentication. CI runs it through `mise run ci` on Ubuntu.

Re-record the demo without external API calls:

```bash
python3 scripts/smoke-tui.py docs/demo.cast
```

Smoke:

```bash
pi --no-extensions -e ./index.ts --no-session --no-tools -p "Reply ok"
```

## Stack

- Node.js 24.19.0 via mise, ES2024, TypeScript 7, Biome
- Tests use built-in `node:test` and Node coverage
- Runtime source and tests use separate TypeScript configs
- Loads as `.ts` via jiti (no build step)
- Pi core packages stay `*` peers per Pi's package guidance; development and CI test exact Pi `1.4.0`. Older API compatibility is not verified.

### Pi 1.4.0 compatibility

- Editor, theme-token, context usage, model registry, and session entry APIs used here remain compatible; no runtime shim is needed. The zero-padding override and theme-cache invalidation remain necessary.
- Pi now stacks concurrent extension dialogs instead of replacing an earlier dialog and leaving its promise pending. Reset confirmations use the unchanged `ctx.ui.confirm()` API and benefit without local dialog handling.
- Compaction and branch summaries now use the model's output limit, and split-turn summaries honor custom instructions. Native context readings and persisted summary usage still feed the existing lane and session-cost accounting; no local output cap or compaction logic is added.
- Rex terminal support and terminal-exit cleanup are handled by Pi. Classifier image input, codemode worker queuing, provider attribution headers, and model catalog changes need no editor-chrome adaptation.
- Pi's native editor still recurses on wide characters at widths of one or two columns. This extension keeps its existing native fallback there; the framed path remains protected from inherited padding.

See the [Pi 1.4.0 changelog](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/CHANGELOG.md).

### Pi 1.3.0 compatibility

- Editor, theme-token, context usage, model registry, and session entry APIs used here are unchanged; no runtime shim is needed. The `ctx.ui.custom({ overlay: true })` handle fix affects dialogs, and this extension opens none.
- `openai-codex/gpt-6.1-sol` now reports its 500K context window from Pi's catalog. The lane and `CH%` read `ctx.getContextUsage()` per render, so no local window constant needs changing.
- New `sessionShareDestination` setting, `supportsMidConvoEffort` model capability, and the exported `formatReadLineRange` helper are outside editor chrome. This extension uses none of them.
- Kimi Code Chat Completions caching, mid-session thinking-level cache preservation, dropping another model's thinking on switch, and resumed-session tool restoration are handled inside Pi and need no chrome change.

See the [Pi 1.3.0 changelog](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/CHANGELOG.md).

### Pi 1.2.0 compatibility

- Editor, theme-token, context usage, model registry, and session entry APIs used here remain compatible; no runtime shim is needed.
- `before_agent_start` now also fires for extension-triggered custom-message runs and uses a `messageType: "user" | "custom"` union. This extension does not handle that event or send messages; its activity lifecycle still follows `agent_start` through `agent_settled`.
- `showHardwareCursor` now uses only the terminal cursor. The framed editor delegates input and cursor rendering to Pi's `CustomEditor`, preserving its native cursor marker while adding frame and prompt indentation.
- Theme files are now schema-validated at startup as well as reload. External themes (including generated `omarchy-system` files) must use the documented fields, put reusable colors in `vars`, and remove unsupported metadata/custom color keys. The published schema is `https://pi.dev/schemas/theme.schema.json`; this package ships no theme files and continues using semantic tokens only.
- OpenRouter's per-key model lists provide key-specific context limits and prices; the existing native context snapshots and provider-reported usage costs need no local override. Router placeholder prices now resolve to zero rather than negative estimates.
- New tool-definition `reachesTools`, namespace `aliases`, codemode timing/constraints, and MCP changes do not require editor chrome changes. Tool and conversation renderers stay native; tool elapsed time is not token speed.
- OSC 52 clipboard support (`PI_CLIPBOARD_OSC52=1`) and compaction/terminal fixes remain Pi's responsibility; no duplicate clipboard, compaction, or terminal handling is added.

See the [Pi 1.2.0 changelog](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/CHANGELOG.md).

### Pi 1.1.0 compatibility

- Editor, theme, context usage, model registry, and session entry APIs used here are unchanged from Pi 1.0.4; no runtime shim is needed.
- `agent_settled` now includes `aborted`. The ghost rests on both completion and cancellation; regression coverage checks both payloads without treating an intermediate `agent_end` as idle.
- Pi reports program status through OSC 7501 independently of the hidden working row, including blocked extension dialogs and login. No extra chrome or duplicate status reporter is needed. Reporting is capability-detected; `PI_PROGRAM_STATUS=1|0` overrides detection.
- New tool render context fields `durationMs` and `outputPad`, plus `tool_execution_end.durationMs`, concern tool output, not editor borders. Tool duration is not model token speed; existing `t/s` timing already excludes tool gaps.
- Pi's long-prompt pricing-tier fixes flow into the provider-reported costs already summed here; no local pricing calculation is needed.
- Codemode classifier/image usage already reaches session cost through tool-result usage. No separate image-cost accounting is needed.
- Pi 1.0.3 renamed the Azure provider from `azure-openai-responses` to `azure` (the API identifier remains unchanged). Azure users must update their auth/model/settings provider keys or log in again; this extension needs no Azure-specific migration.

## License

MIT.
