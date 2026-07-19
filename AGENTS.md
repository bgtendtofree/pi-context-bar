# pi-context-bar

Single-line context chrome for pi: Pac-Man context lane + segment mix + CH% + cost + model.

## Goal

One quiet row under the editor. No multi-line footer. Structure via bar; health via few numbers.

## Rules

- Keep chrome height = 1 always
- Empty footer via `setFooter` → `render: () => []` so default footer dies
- Free metrics: `%` · approximate segment `mix~` · `CH` · optional `$` — never path / ↑↓ / R / W
- Classic palette: cream pellets, yellow solid Nerd Font Pac-Man, phase-colored ghost
- Lane runs left → right: empty consumed space, Pac-Man boundary, remaining pellets
- No background color blocks; segment mix lives in metrics with only `S/P/A/T/X` labels colored
- Cap lane width on ultra-wide terminals; preserve flexible gap before right-side metrics
- Animate Pac-Man mouth only while agent runs; clear timer on end/shutdown
- CH remains metrics accent; segment colors stay limited to one-letter metric labels
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
