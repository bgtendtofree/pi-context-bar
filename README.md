# pi-context-bar

Rounded editor with Pac-Man context chrome fused into its border for [pi](https://pi.dev).

Model, cache hit, cost, and Git metadata live in the rounded editor border — zero extra chrome rows. The Pac-Man lane auto-fits the window width across the top border.
Slash-command autocomplete stays above the rounded editor instead of expanding inside it.

```
╭─ 󰮯 • • • o • • • ~42.3t/s ─────────────────────────────────────────╮
│ ›                                                                            │
╰─ gpt-5.6-sol · medium ────────────────── 15.7%   CH98%  $1.61 ── ⎇ main ?1 ──╯
```

Pac-Man moves left → right using Pi's native context usage. Eaten pellets become empty space; cream pellets ahead are remaining capacity. While the agent runs, a phase-colored ghost chases the boundary (red startup, orange thinking, cyan response, blue tools) and Pac-Man chomps; both rest when idle.

## Why

`nano-context` has a great segmented bar, but its custom footer drops default pi stats (especially **cache hit `CH%`**) and stacks 3 chrome lines total.

`pi-context-bar` turns context into a compact Pac-Man lane, restores `CH%` / cost, and separates stable environment metadata from live health. Default footer is replaced with an empty footer, model/Git move into the rounded editor border, and the redundant built-in streaming working row is hidden while the extension is active.

## Layout

| Zone | Content |
|------|---------|
| Editor border left | model · thinking |
| Editor border right | Git branch plus staged `+`, unstaged `*`, untracked `?`, ahead `↑`, behind `↓` |
| Pac-Man lane | empty consumed space → phase ghost while running → yellow Pac-Man → cream remaining pellets |
| Right-aligned metrics | native `%` · `CH` · optional token speed `t/s` · optional `$` |

Healthy text stays dim; only warning/error thresholds gain color. Pac-Man, pellets, and the active ghost keep classic arcade colors. Git branch stays dim, with color limited to meaningful dirty/sync markers. Git is local-only and omitted outside repositories.

Token speed appears as estimated `~Nt/s` while output streams, then uses provider-reported output tokens for the completed turn's `Nt/s`. Timing starts at the first output delta and excludes tool-execution gaps.

Width cascade compresses Git details, cost, and model details while preserving model, branch, `%`, and `CH` longest. The lane stretches with the window, so the rounded border never gaps.

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
npm run smoke          # load package manifest in Pi 0.82.0
npm run smoke:package  # npm production-install smoke
npm run package:check  # verify published files
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
- Pi core packages stay `*` peers; development and CI test exact Pi `0.82.0`

## License

MIT.
