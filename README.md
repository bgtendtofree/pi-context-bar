# pi-context-bar

Single-line context chrome for [pi](https://pi.dev).

One quiet row under the editor: Pac-Man context lane, usage %, cache hit, optional cost, model.

```
• • • • • ᗤ · · · · · · ·   45.2% · CH92.3% · $0.042  opus · high
```

Pac-Man moves right → left as context fills. Cream pellets are remaining capacity; ghost-colored small dots behind Pac-Man show consumed system, prompt, assistant, thinking, and tool proportions.

## Why

`nano-context` has a great segmented bar, but its custom footer drops default pi stats (especially **cache hit `CH%`**) and stacks 3 chrome lines total.

`pi-context-bar` turns context into a compact Pac-Man lane, restores `CH%` / cost / model, and collapses everything into **one line**. Default footer is replaced with an empty footer so chrome never doubles up.

## Layout

| Zone | Content |
|------|---------|
| Pac-Man lane | cream remaining pellets ← yellow Pac-Man ← ghost-colored consumed trail |
| Metrics | `%` · `CH` · optional `$` (no path, no ↑↓RW) |
| Far right | model · thinking (provider if multi) |

Consumed trail uses classic arcade colors: red system, pink prompt, cyan assistant, orange thinking, blue tools. Small foreground dots keep color quiet; no background blocks.

Width cascade: cost → thinking → short model. Pac-Man lane + `%` + `CH` stay longest.

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
