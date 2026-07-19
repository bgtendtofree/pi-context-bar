# pi-context-bar

Rounded editor + single-line context chrome for pi: model/Git border + Pac-Man lane + dominant mix + CH% + cost.

## Goal

Rounded input shell plus one quiet health row below editor. No multi-line footer. Environment in border; health in lane + numbers.

## Rules

- Keep health chrome height = 1 always; rounded editor may wrap naturally with input
- Empty footer via `setFooter` → `render: () => []` so default footer dies
- Editor bottom border: model/thinking left; local Git branch/status right; never path or provider quota
- Health metrics: `%` · approximate dominant `≈ S/P/A/T/X` · `CH` · optional `$`
- Classic palette: cream pellets, yellow solid Nerd Font Pac-Man, phase-colored ghost
- Lane runs left → right: empty consumed space, Pac-Man boundary, remaining pellets
- No background color blocks; only visible dominant segment labels colored
- Cap lane width on ultra-wide terminals; metrics align to editor inner right edge
- Animate Pac-Man mouth only while agent runs; clear timer on end/shutdown
- CH remains metrics accent; Git stays quiet and local-only
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
