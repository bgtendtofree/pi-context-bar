# pi-context-bar

Single-line context chrome for [pi](https://pi.dev).

One quiet row under the editor: Pac-Man context lane, usage %, approximate segment mix, cache hit, optional cost, model.

```
          󰮯 • • • • •   45.2% · mix~ S8k/P11k/A38k/T21k/X12k · CH92.3% · $0.042  opus · high
```

Pac-Man moves left → right as context fills. Eaten pellets become empty space; cream pellets ahead are remaining capacity. Segment analytics move beside the numeric metrics as `mix~` because their allocation is estimated: system (`S`), prompt (`P`), assistant (`A`), thinking (`T`), and tools (`X`). While the agent runs, a phase-colored ghost chases the boundary (red startup, orange thinking, cyan response, blue tools) and Pac-Man chomps; both rest when idle.

## Why

`nano-context` has a great segmented bar, but its custom footer drops default pi stats (especially **cache hit `CH%`**) and stacks 3 chrome lines total.

`pi-context-bar` turns context into a compact Pac-Man lane, restores `CH%` / cost / model, and collapses everything into **one line**. Default footer is replaced with an empty footer, and the redundant built-in streaming working row is hidden while the extension is active.

## Layout

| Zone | Content |
|------|---------|
| Pac-Man lane | empty consumed space → phase ghost while running → yellow Pac-Man → cream remaining pellets |
| Metrics | `%` · approximate `mix~ S/P/A/T/X` · `CH` · optional `$` (no path, no ↑↓RW) |
| Far right | model · thinking (provider if multi) |

Segment labels use classic ghost colors: red system, pink prompt, cyan assistant, orange thinking, blue tools. Only the one-letter labels are colored; values stay dim and no background blocks are used.

Width cascade drops cost and segment mix before core `%` + `CH`, then shortens model details. Ultra-wide terminals cap the lane at 96 columns and keep a quiet flexible gap before right-aligned metrics.

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
