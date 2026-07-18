# pi-context-bar

Single-line context chrome for pi: segmented bar + CH% + cost + model.

## Goal

One quiet row under the editor. No multi-line footer. Structure via bar; health via few numbers.

## Rules

- Keep chrome height = 1 always
- Empty footer via `setFooter` → `render: () => []` so default footer dies
- Free metrics: only `%` · `CH` · optional `$` — never path / ↑↓ / R / W
- Monochrome slate ramp for segments; CH is the sole free-zone accent
- Labels only when segment width ≥ `LABEL_MIN_WIDTH`
- Functional style, no `any`, immutable snapshots
- Pure logic in `lib/chrome.ts`; keep `index.ts` thin

## Layout

- `lib/chrome.ts` — pure formatting / segment math (unit-tested)
- `index.ts` — pi extension wiring only
- `lib/chrome.test.ts` — Node.js built-in `node:test`

## Stack

Node.js 24 LTS runtime + ES2024 + Bun 1.3.14 + TypeScript 7 + Biome. Extension loads as `.ts` source.

## Tests

`bun run test` uses `node:test`. `bun run test:coverage` enforces Node coverage thresholds. `bun run smoke` loads the package manifest in Pi; `bun run smoke:package` verifies an npm production install. Keep pure logic in `lib/`; do not grow untested math in `index.ts`.
