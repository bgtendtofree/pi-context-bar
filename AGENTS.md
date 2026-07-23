# pi-context-bar

Rounded editor + single-line context chrome for pi: model/Git border + Pac-Man lane + dominant mix + CH% + cost.

## Goal

Rounded input shell plus one quiet health row below editor. No multi-line footer. Environment in border; health in lane + numbers.

## Rules

- Keep health chrome height = 1 always; rounded editor may wrap naturally with input
- Empty footer via `setFooter` → `render: () => []` so default footer dies
- Editor bottom border: model/thinking left; local Git branch/status right; never path or provider quota
- Health metrics: `%` · readable dominant `≈ tools/reply/...` · `CH` · optional live `t/s` · optional `$`
- Classic palette: cream pellets, yellow solid Nerd Font Pac-Man, phase-colored ghost
- Lane runs left → right: empty consumed space, Pac-Man boundary, remaining pellets
- No background color blocks; healthy text and segment mix stay dim; only warning/error states gain color
- Cap lane width on ultra-wide terminals; metrics align to editor inner right edge
- Animate Pac-Man mouth only while agent runs; clear timer on end/shutdown
- Keep token speed dim: `~Nt/s` while estimated live, provider-calibrated `Nt/s` after turn
- High CH stays quiet; low CH warns. Git branch stays dim; only dirty/sync markers gain color
- Functional style, no `any`, immutable snapshots
- Pure logic in `lib/chrome.ts`; keep `index.ts` thin

## Layout

- `lib/context.ts` — token estimation, segment allocation, session usage
- `lib/chrome.ts` — Pac-Man lane, dominant metrics, health-row composition
- `lib/git.ts` — pure local Git parsing / label cascade
- `lib/border.ts` — pure model/Git border fitting
- `lib/text.ts` — ANSI-safe text helpers
- `ui/rounded-editor.ts` — Pi/TUI editor adapter
- `index.ts` — extension state, I/O, lifecycle wiring only
- `lib/*.test.ts` — mirrored Node.js `node:test` suites

## Stack

Node.js 24 LTS runtime + ES2024 + Bun 1.3.14 + TypeScript 7 + Biome. Extension loads as `.ts` source.

## Tests

`bun run test` uses `node:test`. `bun run test:coverage` enforces Node coverage thresholds. `bun run smoke` loads the package manifest in Pi; `bun run smoke:package` verifies an npm production install. Keep pure logic in `lib/`; do not grow untested math in `index.ts`.
