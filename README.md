# pi-context-bar

Rounded editor + single-line context chrome for [pi](https://pi.dev).

Model and Git metadata live in the editor border; one quiet row below carries Pac-Man context health.

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ ›                                                                            │
╰─ gpt-5.6-sol · medium ──────────────────────────────────── ⎇ main ?1 ─────────╯
  󰮯 • • • • •                         15.7%   ≈ X74 A19 S6   CH98%  $1.61
```

Pac-Man moves left → right as context fills. Eaten pellets become empty space; cream pellets ahead are remaining capacity. Approximate segment analytics show only the three dominant shares: system (`S`), prompt (`P`), assistant (`A`), thinking (`T`), and tools (`X`). While the agent runs, a phase-colored ghost chases the boundary (red startup, orange thinking, cyan response, blue tools) and Pac-Man chomps; both rest when idle.

## Why

`nano-context` has a great segmented bar, but its custom footer drops default pi stats (especially **cache hit `CH%`**) and stacks 3 chrome lines total.

`pi-context-bar` turns context into a compact Pac-Man lane, restores `CH%` / cost, and separates stable environment metadata from live health. Default footer is replaced with an empty footer, model/Git move into the rounded editor border, and the redundant built-in streaming working row is hidden while the extension is active.

## Layout

| Zone | Content |
|------|---------|
| Editor border left | model · thinking |
| Editor border right | Git branch plus staged `+`, unstaged `*`, untracked `?`, ahead `↑`, behind `↓` |
| Pac-Man lane | empty consumed space → phase ghost while running → yellow Pac-Man → cream remaining pellets |
| Right-aligned metrics | `%` · approximate dominant `≈ S/P/A/T/X` · `CH` · optional `$` |

Segment labels use classic ghost colors: red system, pink prompt, cyan assistant, orange thinking, blue tools. Only visible one-letter labels are colored; values stay dim and no background blocks are used. Git is local-only and omitted outside repositories.

Width cascade compresses Git details, segment mix, cost, and model details while preserving model, branch, `%`, and `CH` longest. Ultra-wide terminals cap the lane at 96 columns and keep a flexible gap before metrics aligned to the editor's inner right edge.

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
bun install
bun run quality        # Biome CI check
bun run typecheck      # TypeScript 7
bun run test           # node:test
bun run test:coverage  # Node coverage with 90% gates
bun run smoke          # load package manifest in Pi 0.80.10
bun run smoke:package  # npm production-install smoke
bun run package:check  # verify published files
bun run ci             # full CI pipeline
```

Coverage targets pure chrome math in `lib/chrome.ts` (≥90% lines/functions/branches). Extension wiring in `index.ts` is excluded from the gate.

Smoke:

```bash
pi --no-extensions -e ./index.ts --no-session --no-tools -p "Reply ok"
```

## Stack

- Node.js 24 LTS, ES2024, TypeScript 7, Biome
- Tests use built-in `node:test` and Node coverage
- Loads as `.ts` via jiti (no build step)
- Pi core packages stay `*` peers; CI tests exact Pi `0.80.10`

## License

MIT.
