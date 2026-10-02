# pi-context-bar

Rounded editor with Pac-Man context chrome fused into its border for [pi](https://pi.dev).

Model, cache hit, and cost live in the rounded editor border — zero extra chrome rows. The Pac-Man lane auto-fits the window width across the top border.
Slash-command autocomplete stays above the rounded editor instead of expanding inside it.

```
╭─ 󰮯 • • • o • • • 15.7% (200K)  ~42.3t/s ──────────────────────────╮
│ ›                                                                            │
╰─ gpt-5.6-sol · medium ─────────────────────────────── CH98%  $1.61 ──╯
```

Pac-Man moves left → right using Pi's native context usage. Eaten pellets become empty space; cream pellets ahead are remaining capacity. While the agent runs, a phase-colored ghost chases the boundary (red startup, orange thinking, cyan response, blue tools) and Pac-Man chomps; both rest when idle. The border stays static theme-colored throughout — the chomping mouth and the ghost carry activity, and chomp speed is driven by live token throughput, so a slow turn is directly visible as slow chomping.

Arcade colors use Pi's active theme renderer, including truecolor/256-color capability overrides. Classic hues stay unchanged, with no background blocks. Semantic border and metric colors follow live theme changes. The ghost rests at `agent_settled`, not an intermediate `agent_end` that may still retry or continue.

## Why

`nano-context` has a great segmented bar, but its custom footer drops default pi stats (especially **cache hit `CH%`**) and stacks 3 chrome lines total.

`pi-context-bar` turns context into a compact Pac-Man lane, restores `CH%` / cost, and separates stable environment metadata from live health. Default footer is replaced with an empty footer, model and health metrics move into the rounded editor border, and the redundant built-in streaming working row is hidden while the extension is active.

## Layout

| Zone | Content |
|------|---------|
| Editor border left | model · thinking |
| Editor border right | `CH` · optional `$` |
| Pac-Man lane | empty consumed space → phase ghost while running → yellow Pac-Man → cream remaining pellets |
| Right-aligned metrics | native `%` · optional token speed `t/s` |

Healthy text stays dim; only warning/error thresholds gain color. Pac-Man, pellets, and the active ghost keep classic arcade colors on dark terminals; on light terminals the palette darkens (goldenrod Pac-Man, sienna pellets, muted ghost phases) from the theme's `appearance` so the warm hues stay readable.

With a virtual model selected, the bottom border shows `auto · high → physical-model · medium` for the latest successful response on the active branch. Narrow borders drop thinking and route detail before the selected model. Context limits still come directly from Pi, which accounts for the routed physical model.

Session cost includes standalone usage entries (such as cache warming) and nested model work reported by tool results. New OpenAI ChatGPT assistant turns record their request-time billing identity in non-context custom entries, so switching between OpenAI API keys and ChatGPT login never reclassifies earlier bills. Legacy `openai-codex` and `ln` reference costs remain excluded. Other providers keep their existing cost semantics, since subscription OAuth can include billed extra usage. Older untagged turns and tool/summary usage retain their reported costs; these are catalog estimates, not provider invoices.

## Subscription quota

OpenAI Codex subscription quota sits beside the model label:

- **OpenAI Codex (ChatGPT Plus/Pro)**: `5h%` and `7d%` windows from `/wham/usage`, plus a dim `R<n>` count when banked usage-limit resets are available

Quota is advisory chrome: refreshed on activity (`turn_end`, `model_select`) at most once a minute, failures keep the last good snapshot, and it hides unless a physical legacy `openai-codex` model is active. Pi's new `/login openai` ChatGPT authentication uses different API credentials; quota and reset support are not assumed compatible with it. Virtual selections also keep legacy quota/reset disabled.

### `/openai-codex-reset`

Redeems one banked OpenAI usage-limit reset (refreshes eligible 5h/weekly windows). It selects soonest-expiring reset first and lists every banked reset with its remaining time and absolute expiry (marking the selected one) before confirmation, then refreshes quota immediately after the consume response.

**Compatibility caveat:** this uses ChatGPT's internal `/wham/rate-limit-reset-credits` endpoints, not a public stable API; OpenAI may change them. Requests are limited to the official `https://chatgpt.com` origin, reject redirects, time out after 15 seconds, and cap response bodies at 64 KiB. Before consuming a reset, the command re-resolves Pi's OAuth token and cancels if account changed. Confirmation precedes the mutating POST. If outcome is uncertain, a pending record stores selected credit and idempotency key under Pi's agent directory; rerunning the command retries the same request. Use `/openai-codex-reset forget-pending` only after checking usage—forgetting an applied request can allow another reset to be spent.

Token speed appears as estimated `~Nt/s` while output streams, then uses provider-reported output tokens for the completed turn's `Nt/s`. Timing starts at the first output delta and excludes tool-execution gaps.

Top border carries context consumption (lane, `%` with the model's context-window size, `t/s`); bottom left carries session identity (model · thinking); bottom right carries session health (`CH`, cost). The lane stretches with the window, so the rounded border never gaps.

`CH` shows the latest turn's cache hit rate (pi's built-in footer semantics). When the session's token-weighted average diverges from it by more than 5 points, the average joins the label as `CH98/94%` (latest/average), so a quietly drifting hit rate cannot mislead; the average is dim and the latest turn keeps the warning/error coloring.

## Startup

A quiet welcome header appears immediately: bold `pi` + version on one row, resolved keybinding hints (`esc interrupt · ctrl+c exit · / commands · ! bash · …`) on the next. Keys are read from your actual keybindings, so remaps show correctly, and the expand keybinding toggles a full hint list. No model or cwd repeats — those already live in the editor border and your shell.

Pairs well with `"quietStartup": true` in `~/.pi/agent/settings.json`, which hides pi's `[Context] [Skills] [Extensions]` loaded-resources rows; resource details remain available via `/status`.

## Font requirement

Pac-Man `󰮯` and Ghost `󰊠` are Nerd Font Material Design glyphs. Configure your terminal profile to use a **Nerd Font v3+**; installing the font without selecting it in the terminal is not enough. **JetBrainsMono Nerd Font Mono** is recommended because its icons stay single-cell and keep the lane aligned.

Terminals without a Nerd Font (SSH into a remote box, a locked-down corporate profile) fall back to ASCII glyphs via one config file — see [Config](#config).

## Install

```bash
pi install git:github.com/bgtendtofree/pi-context-bar
# local checkout
pi install -l file:./
```

Remove with `pi remove pi-context-bar`.

## Config

One optional file, one optional key — the default is the intended setup:

```jsonc
// ~/.pi/agent/pi-context-bar.json
{
	"asciiFallback": true // terminals without a Nerd Font: C / O / 0 instead of the icons
}
```

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
- Pi core packages stay `*` peers; development and CI test exact Pi `0.99.1`

## License

MIT.
