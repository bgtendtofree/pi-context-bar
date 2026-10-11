# pi-context-bar

Square editor with Pac-Man context chrome fused into its frame for [pi](https://pi.dev).

Model, cache hit, and cost live in the editor frame — zero extra chrome rows. The Pac-Man lane auto-fits the window width across the top border.
Slash-command autocomplete stays above the framed editor instead of expanding inside it.

Scope is editor chrome, not conversation rendering: assistant messages, thinking content,
tool calls/results, and compaction notices stay native Pi. The extension wraps the editor,
replaces the welcome header/footer, and hides the redundant working row through Pi's UI APIs;
it does not patch Pi core or replace conversation renderers.

```
┌─ 󰮯 • • • ○ • • • 15.7% (200K)  󰓅 ~42.3t/s ───────────────────────────┐
│  ❯ hello                                                             │
└─  gpt-5.6-sol · medium ─────────────────────────── 󰆼 98%  $1.61 ────┘
```

Pac-Man moves left → right using Pi's native context usage. Eaten pellets become empty space; pellets ahead are remaining capacity. While the agent runs, a state-colored ghost chases the boundary and Pac-Man chomps; both rest when idle. The chomping mouth and the ghost carry activity, and chomp speed is driven by live token throughput, so a slow turn is directly visible as slow chomping.

Every element uses Pi's active theme tokens, including truecolor/256-color capability overrides. Pac-Man is `text`, pellets are `dim`, power pellets are `muted`, and the ghost carries three states: `muted` while work has started but nothing is streamed yet, `accent` while the model is generating (reasoning or tool-call arguments), `success` while the answer itself streams. Reasoning and tool calls share a color on purpose: Omarchy's palette offers exactly one hue that is neither identity nor a state, so a fourth phase color would have to borrow a markdown or syntax role that some themes map onto the accent or onto red. `warning` and `error` stay reserved for crossed thresholds and failure, the way Omarchy keeps `urgent` for attention alone, so an active phase never reads as a problem. The frame is `borderMuted`, switching to `bashMode` while the input starts with `!`. Semantic border and metric colors follow live theme changes. The ghost rests at `agent_settled`, not an intermediate `agent_end` that may still retry or continue.

## Why

`nano-context` has a great segmented bar, but its custom footer drops default pi stats (especially **cache hit `CH%`**) and stacks 3 chrome lines total.

`pi-context-bar` turns context into a compact Pac-Man lane, restores `CH%` / cost, and separates stable environment metadata from live health. Default footer is replaced with an empty footer, model and health metrics move into the framed editor, and the redundant built-in streaming working row is hidden while the extension is active.

## Layout

| Zone | Content |
|------|---------|
| Editor border left | provider badge · model id (accent) · dim thinking level |
| Editor body | `❯` prompt (accent) · typed input |
| Editor border right | cache database · optional `$` |
| Pac-Man lane | empty consumed space → phase ghost while running → text Pac-Man → dim remaining pellets |
| Right-aligned metrics | native `%` · optional token speed `t/s` |

Healthy metrics stay dim; accent marks the model and ready prompt, and warning/error colors mark thresholds and failure only. The frame is square (`┌ ┐ └ ┘`, `─ │`) with no background fills.

## Icons

Nerd Font icons decorate information that is already in the frame; they never add a metric. Each drops back to plain text (or disappears) before any useful model, quota, cache, cost, context-window, or speed reading is lost.

| Information | Nerd Font icon | ASCII fallback |
|---|---|---|
| Selected provider | accent `cod-openai` `` / `cod-claude` `` before the model id | no badge |
| Cache hit | `md-database` `󰆼` replaces the `CH` label (`󰆼 98/94%`) | `CH98/94%` |
| Token speed | dim `md-speedometer` `󰓅` before `t/s` (`󰓅 ~218t/s`) | `~218t/s` |

Thinking levels stay plain dim text (`· high`, routed thinking included); there is no thinking icon. When the icon itself does not fit, the Nerd cache label keeps the bare percent (`98/94%`) because that is two columns narrower than the `CH` label, and the number matters more than the label. Only the exact known non-virtual providers `openai`, `openai-codex`, and `anthropic` get a badge; virtual selections and other providers show the model id alone. Provider badges are never inferred from a model id or from the routed physical model. The cache latest/average math and threshold colors are unchanged.

The model id is accent and plain, with thinking dim after it. When the latest completed turn ends in a provider error the prompt becomes `✗` in the error token, until a turn finishes without error; user aborts keep the previous state. Context-window size stays dim even when usage warns. Wide lanes (80+ columns) space cells three columns apart instead of two, without capping the track; circular `○` power pellets mark the 70% / 90% thresholds.

With a virtual model selected, the bottom border shows `auto · high → physical-model · medium` for the latest successful response on the active branch. Narrow borders drop thinking and route detail before the selected model. Context limits still come directly from Pi, which accounts for the routed physical model.

Session cost includes standalone usage entries (such as cache warming) and nested model work reported by tool results. New OpenAI ChatGPT assistant turns record their request-time billing identity in non-context custom entries, so switching between OpenAI API keys and ChatGPT login never reclassifies earlier bills. Legacy `openai-codex` and `ln` reference costs remain excluded. Other providers keep their existing cost semantics, since subscription OAuth can include billed extra usage. Older untagged turns and tool/summary usage retain their reported costs; these are catalog estimates, not provider invoices.

## Subscription quota

OpenAI Codex subscription quota sits beside the model label:

- **OpenAI Codex (ChatGPT Plus/Pro)**: `5h 53%` and `7d 43%` windows from `/wham/usage`. Healthy windows stay quiet with just their label and used percent, matching the editor's warning threshold. A window above 70% shows a dim `󰦛 2h 30m` countdown to its reset (ASCII `r2h 30m`) next to that window only; exactly 70% is still quiet, and a healthy sibling window is never expanded. A dim `󰔖 <n>` count (ASCII `R<n>`) appears only while any reported quota (including the weekly percent) is above 70%; zero or unknown credits stay hidden. The border first fits the model, window percentages, and cache/cost, then spends only spare width on countdowns and credits, so optional detail never pushes out a useful number; on narrow borders those optional fields drop before any window percentage.

Quota is advisory chrome: refreshed on activity (`turn_end`, `model_select`) at most once a minute, failures keep the last good snapshot, and it hides unless a physical legacy `openai-codex` model is active. Pi's new `/login openai` ChatGPT authentication uses different API credentials; quota and reset support are not assumed compatible with it. Virtual selections also keep legacy quota/reset disabled.

### `/openai-codex-reset`

Redeems one banked OpenAI usage-limit reset (refreshes eligible 5h/weekly windows). It selects soonest-expiring reset first and lists every banked reset with its remaining time and absolute expiry (marking the selected one) before confirmation, then refreshes quota immediately after the consume response.

**Compatibility caveat:** this uses ChatGPT's internal `/wham/rate-limit-reset-credits` endpoints, not a public stable API; OpenAI may change them. Requests are limited to the official `https://chatgpt.com` origin, reject redirects, time out after 15 seconds, and cap response bodies at 64 KiB. Before consuming a reset, the command re-resolves Pi's OAuth token and cancels if account changed. Confirmation precedes the mutating POST. If outcome is uncertain, a pending record stores selected credit and idempotency key under Pi's agent directory; rerunning the command retries the same request. Use `/openai-codex-reset forget-pending` only after checking usage—forgetting an applied request can allow another reset to be spent.

Reset and `forget-pending` commands share an exclusive filesystem lock, held through confirmation and the consume response. Other terminals fail without touching the record. A crash leaves `pi-context-bar-reset-pending.json.lock` behind: stop **all Pi processes sharing that agent directory** before removing only this empty lock directory. Keep the pending JSON and retry its same request. Locks never expire automatically; removing a live lock or deleting an uncertain pending record can spend another credit. Expired credits are excluded and the selected credit is checked again after confirmation.

Only the exact known completed consume codes `reset` and `already_redeemed` allow automatic pending cleanup. Every other code (including unfamiliar future codes, case variants, and malformed values) is treated as `unknown`; the pending credit and request ID remain unchanged for a confirmed retry.

Token speed appears as estimated `~Nt/s` while output streams, then uses provider-reported output tokens for the completed turn's `Nt/s`. Timing starts at the first output delta and excludes tool-execution gaps.

Top border carries context consumption (lane, `%` with the model's context-window size, `t/s`); bottom left carries session identity (model · thinking); bottom right carries session health (`CH`, cost). The lane stretches with the window, so the frame never gaps.

`CH` shows the latest turn's cache hit rate (pi's built-in footer semantics). When the session's token-weighted average diverges from it by more than 5 points, the average joins the label as `CH98/94%` (latest/average), so a quietly drifting hit rate cannot mislead; the average is dim and the latest turn keeps the warning/error coloring.

## Startup

A quiet welcome header appears immediately: pi's mark drawn as half blocks (`▀▀█` / `█▀ █`) in accent with the version dim beside it, then the resolved keybinding hints (`esc interrupt · ctrl+c exit · / commands · ! bash · …`) on the mark's second row. Rows align with the editor's prompt column, with keys in accent and descriptions dim. The mark is single-color silhouette art, the way Omarchy prints its own logo, so it inherits whatever theme is active instead of carrying brand colors. Keys are read from your actual keybindings, so remaps show correctly, and the expand keybinding toggles a full hint list. On terminals that misalign half blocks, in ASCII mode, or when the width cannot fit the mark, the header falls back to the plain `pi vX` wordmark. No model or cwd repeats — those already live in the editor border and your shell.

`"quietStartup": true` in `~/.pi/agent/settings.json` hides this header too, leaving Pi's loaded-resources rows out and the startup output empty as the setting intends; `"header"` keeps the header and drops the resource details. Resource details remain available via `/status`.

## Font requirement

Pac-Man `󰮯`, Ghost `󰊠`, and the `md-*` chrome icons (reset `󰦛`, reset credits `󰔖`, database `󰆼`, speedometer `󰓅`) are Material Design glyphs present since Nerd Font **v3.0.0**. The provider badges `cod-openai` `` and `cod-claude` `` are Codicons first shipped in Nerd Font **v3.5.0** (they are absent from v3.4.0 and earlier). Configure your terminal profile to use a **Nerd Font v3.5.0+** for the full chrome; installing the font without selecting it in the terminal is not enough. **JetBrainsMono Nerd Font Mono** is recommended because its icons stay single-cell and keep the lane aligned. There is no font detection: on an older release the badge codepoints have no glyph and may render as tofu or a terminal fallback, so upgrade to v3.5.0+ or set `asciiFallback` to omit them.

Terminals without a Nerd Font (SSH into a remote box, a locked-down corporate profile) fall back to ASCII glyphs via one config file — see [Config](#config).

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

`asciiFallback: true` uses C / O / 0 icons and the `> / x` prompt for terminals without a Nerd Font. It also covers terminals that draw ambiguous-width cells two columns wide (common with CJK fonts): those render the pellet and power-pellet glyphs wider than the single cell the lane budgets for them.

The file is read once at startup; a missing or corrupt file silently uses defaults.

## Dev

```bash
mise install
npm ci
npm run quality        # Biome CI check
npm run typecheck      # TypeScript 7
npm test               # node:test
npm run test:coverage  # Node coverage with 90% gates
npm run smoke:package  # npm production-install smoke
npm run ci             # full CI pipeline
```

Coverage targets all pure modules in `lib/` (≥90% lines/functions/branches). Extension wiring in `index.ts` and the Pi/TUI adapter in `ui/` are excluded from the gate.

Smoke:

```bash
pi --no-extensions -e ./index.ts --no-session --no-tools -p "Reply ok"
```

## Stack

- Node.js 24.19.0 via mise, ES2024, TypeScript 7, Biome
- Tests use built-in `node:test` and Node coverage
- Runtime source and tests use separate TypeScript configs
- Loads as `.ts` via jiti (no build step)
- Pi core packages stay `*` peers per Pi's package guidance; development and CI test exact Pi `1.1.0`. Older API compatibility is not verified.

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
