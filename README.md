# pi-context-bar

Single-line context chrome for [pi](https://pi.dev).

One quiet row under the editor: monochrome segment bar, usage %, cache hit, optional cost, model.

```
[░░░░▒▒▓▓··]  45.2% · CH92.3% · $0.042     opus · high
```

## Why

`nano-context` has a great segmented bar, but its custom footer drops default pi stats (especially **cache hit `CH%`**) and stacks 3 chrome lines total.

`pi-context-bar` keeps the bar idea, restores `CH%` / cost / model, and collapses everything into **one line**. Default footer is replaced with an empty footer so chrome never doubles up.

## Layout

| Zone | Content |
|------|---------|
| Used blocks | cool-slate ramp: system → prompt → assistant → think → tools |
| Free zone | `%` · `CH` · optional `$` (no path, no ↑↓RW) |
| Far right | model · thinking (provider if multi) |

Design: one hue for structure, **one accent for CH**, threshold color only on `%`. Labels appear only on wide segments.

Width cascade: cost → thinking → short model. Blocks + `%` + `CH` stay longest.

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
