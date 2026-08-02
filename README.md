# pi-context-bar

Rounded editor with Pac-Man context chrome fused into its border for [pi](https://pi.dev).

Model, cache hit, and cost live in the rounded editor border — zero extra chrome rows. The Pac-Man lane auto-fits the window width across the top border.
Slash-command autocomplete stays above the rounded editor instead of expanding inside it.

```
╭─ 󰮯 • • • o • • • 15.7%  ~42.3t/s ────────────────────────────────╮
│ ›                                                                            │
╰─ gpt-5.6-sol · medium ─────────────────────────────── CH98%  $1.61 ──╯
```

Pac-Man moves left → right using Pi's native context usage. Eaten pellets become empty space; cream pellets ahead are remaining capacity. While the agent runs, a phase-colored ghost chases the boundary (red startup, orange thinking, cyan response, blue tools) and Pac-Man chomps; both rest when idle. While the agent works, the rounded border itself breathes — a slow grayscale sine on the frame — so slow turns still read as alive; the border returns to the theme color the moment the agent goes idle.

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

Healthy text stays dim; only warning/error thresholds gain color. Pac-Man, pellets, and the active ghost keep classic arcade colors.

## Subscription quota

When the active model belongs to a subscription provider, its quota sits beside the model label:

- **Kimi Code (Coding Plan)**: weekly `W%` plus rolling rate-limit windows (`5h%`, `1d%`) from `/v1/usages`
- **OpenAI Codex (ChatGPT Plus/Pro)**: `5h%` and `7d%` windows from `/wham/usage`, plus a dim `R<n>` count when banked usage-limit resets are available

Quota is advisory chrome: polls every 5 minutes, failures keep the last good snapshot, and everything hides when a non-subscription model is active.

### `/openai-codex-reset`

Redeems one banked OpenAI usage-limit reset (resets the current 5h/weekly window). This is an **intentional, user-requested feature** — the command calls the same `/wham/rate-limit-reset-credits` endpoints the official Codex CLI `/usage` redeem flow uses, with an explicit confirm dialog before the mutating POST and an idempotency key on every consume. Audits should not flag it as removable bloat; the passive `R<n>` display and the active redeem command are a pair by design.

Token speed appears as estimated `~Nt/s` while output streams, then uses provider-reported output tokens for the completed turn's `Nt/s`. Timing starts at the first output delta and excludes tool-execution gaps.

Top border carries context consumption (lane, `%`, `t/s`); bottom left carries session identity (model · thinking); bottom right carries session health (`CH`, cost). The lane stretches with the window, so the rounded border never gaps.

## Startup

On session start, Pac-Man sweeps the header lane once (eating every pellet in ~0.6s), then a quiet welcome header stays: bold `pi` + version on one row, resolved keybinding hints (`esc interrupt · ctrl+c exit · / commands · ! bash · …`) on the next. Keys are read from your actual keybindings, so remaps show correctly, and the expand keybinding toggles a full hint list. No model or cwd repeats — those already live in the editor border and your shell. The sweep plays on `startup` and `/new` only, never on reload.

Pairs well with `"quietStartup": true` in `~/.pi/agent/settings.json`, which hides pi's `[Context] [Skills] [Extensions]` loaded-resources rows; resource details remain available via `/status`.

## Font requirement

Pac-Man `󰮯` and Ghost `󰊠` are Nerd Font Material Design glyphs. Configure your terminal profile to use a **Nerd Font v3+**; installing the font without selecting it in the terminal is not enough. **JetBrainsMono Nerd Font Mono** is recommended because its icons stay single-cell and keep the lane aligned. Without a compatible Nerd Font, the characters may render as empty boxes or fallback symbols; metrics and context calculations still work.

## Install

```bash
pi install git:github.com/bgtendtofree/pi-context-bar
# local checkout
pi install -l file:./
```

Remove with `pi remove pi-context-bar`.

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

- Node.js 24.18.0 via mise, ES2024, TypeScript 7, Biome
- Tests use built-in `node:test` and Node coverage
- Runtime source and tests use separate TypeScript configs
- Loads as `.ts` via jiti (no build step)
- Pi core packages stay `*` peers; development and CI test exact Pi `0.83.0`

## License

MIT.
