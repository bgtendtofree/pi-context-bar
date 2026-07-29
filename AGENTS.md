# pi-context-bar

Rounded editor + single-line context chrome for pi: model/Git border + Pac-Man lane + CH% + cost.

## Goal

Rounded input shell plus one quiet health row below editor. No multi-line footer. Environment in border; health in lane + numbers.

## Rules

- Health chrome lives inside the editor borders; no extra rows
- Empty footer via `setFooter` → `render: () => []` so default footer dies
- Editor top border: Pac-Man lane (auto-fits window width, no cap) + context `%` beside lane + quiet live `t/s` at the right end
- Editor bottom border: model/thinking left with `CH`/`$` beside it; local Git branch/status right, alone; never path or provider quota
- Health metrics: `%` + quiet live `t/s` (top border) · `CH` + optional `$` (beside model)
- Classic palette: cream pellets, yellow solid Nerd Font Pac-Man, phase-colored ghost
- Lane runs left → right: empty consumed space, Pac-Man boundary, remaining pellets
- No background color blocks; healthy text stays dim; only warning/error states gain color
- Chomp driven by streamed tokens: mouth speed = throughput, static when idle (no timers)
- Keep token speed dim: `~Nt/s` while estimated live, provider-calibrated `Nt/s` after turn
- High CH stays quiet; low CH warns. Git branch stays dim; only dirty/sync markers gain color
- Functional style, no `any`, immutable snapshots
- Pure logic in `lib/chrome.ts`; keep `index.ts` thin

## Layout

- `lib/context.ts` — native context snapshot types and session usage
- `lib/chrome.ts` — Pac-Man lane, health metrics, health-row composition
- `lib/git.ts` — pure local Git parsing / label cascade
- `lib/border.ts` — pure model/Git border fitting
- `lib/text.ts` — ANSI-safe text helpers
- `ui/rounded-editor.ts` — Pi/TUI editor adapter
- `index.ts` — extension state, I/O, lifecycle wiring only
- `lib/*.test.ts` — mirrored Node.js `node:test` suites

## Stack

Node.js 24.18.0 via project mise config + ES2024 + npm + TypeScript 7 + Biome. Runtime source and tests use separate TypeScript configs. Extension loads as `.ts` source.

## Tests

<!-- pi-ci-standard:validation:start -->
## Validation

CI contract for this repository (managed by pi-ci-standard — regenerate with `pi-ci init`):

- Run `mise run check` while iterating; fix all failures before continuing.
- Run `mise run ci` before declaring work complete; it must pass.
- GitHub Actions runs project checks only through managed mise tasks. Never add language-specific check commands to workflows.
<!-- pi-ci-standard:validation:end -->

`npm test` uses `node:test`. `npm run test:coverage` enforces Node coverage thresholds. `npm run smoke:package` verifies an npm production install. Keep pure logic in `lib/`; do not grow untested math in `index.ts`.
