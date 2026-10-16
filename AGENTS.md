# pi-context-bar

Square framed editor + single-line context chrome for pi: model label + Pac-Man lane + CH% + cost.

## Goal

Square framed input shell plus one quiet health row. No multi-line footer. Environment in frame; health in lane + numbers. Glyphs and motion carry the game; theme colors carry meaning.

## Rules

- Health chrome lives inside the editor frame; no extra rows
- Empty footer via `setFooter` → `render: () => []` so default footer dies
- Editor top border: Pac-Man lane (auto-fits window width, no cap) + context `%` beside lane + quiet live `t/s` at the right end
- Editor bottom border: model/thinking + OpenAI Codex quota beside it on the left, `CH`/`$` right; never path or Git
- Health metrics: `%` + quiet live `t/s` (top) · cache hit + optional `$` (bottom right); Nerd Font icons may decorate speed and replace `CH`, ASCII keeps `CH` and `t/s`
- Scope: editor chrome/header/footer only; keep Pi's native conversation, thinking, tool-result, and compaction-notice renderers unchanged
- Icon grammar: plain dim thinking level (no brain icon), cache database, dim speedometer; decorations drop before useful text/numbers at narrow widths, all through `GlyphSet` with ASCII fallback
- Startup header: Omarchy-aligned single-color block mark (pi's silhouette as `▀▀█`/`█▀ █` in `accent`, version `dim`), hint row on the mark's second line, indent at the editor prompt column, `pi vX` wordmark fallback when the mark cannot fit or on Apple Terminal (pi's own `supportsPiLogo()` check)
- `quietStartup: true` hides the replacement header as it hides Pi's own; the header never overrides that setting
- Omarchy alignment: activity stays in `muted`/`accent`/`success`; `warning` and `error` are reserved for thresholds and failure, matching Omarchy's `urgent`-for-attention rule. The ghost has exactly three states — quiet `muted`, generating `accent`, answering `success` — so `thinking` and `tools` share `accent` deliberately: hue carries identity, magnitude, and failure, never activity kind, and the lane's shape/motion carries which work is running
- Quota hierarchy: healthy windows show percentages only; windows with usage >70% may show their future reset countdown, and available reset credits appear only while any quota is >70%; fit model + quota percentages + cache/cost first, then add countdowns/credits only in spare width
- Glyph proportions: single-cell Mono Nerd Font glyphs only; do not change terminal font size/config or add per-glyph scaling tricks
- Square geometry: corners `┌ ┐ └ ┘`, lines `─ │`; no rounded corners and no background fills anywhere
- Theme tokens only, never hex. Roles: `text` Pac-Man glyphs and typed input · `accent` model id, ready prompt, tools ghost, thinking ghost · `muted` working ghost, power pellets · `dim` pellets, thinking level, separators, route arrow, healthy metrics, scroll counts · `borderMuted` frame · `bashMode` frame while the input starts with `!` · `warning` thresholds · `success` response ghost · `error` failure glyph, thresholds
- A source test fails the build on hex colors or raw ANSI escapes in chrome sources; Omarchy generates the palette as a pi theme (`omarchy-system`) from its active theme, so the extension only ever names tokens
- Lane runs left → right: empty consumed space, Pac-Man boundary, remaining pellets
- Chomp driven by streamed tokens: mouth speed = throughput, static when idle (no timers)
- Keep token speed dim: `~Nt/s` while estimated live, provider-calibrated `Nt/s` after turn
- High CH stays quiet; low CH warns
- Functional style, no `any`, immutable snapshots
- Pure logic in `lib/`; keep `index.ts` thin

## Layout

- `lib/context.ts` — native context snapshot types and session usage
- `lib/chrome.ts` — Pac-Man lane, health metrics, role-based theme styling
- `lib/openai.ts` — OpenAI Codex quota, expiry-aware banked reset
- `lib/header.ts` — quiet welcome header
- `lib/prompt.ts` — prompt-state transition and glyph
- `lib/border.ts` — pure model label fitting and frame rendering
- `ui/framed-editor.ts` — Pi/TUI framed editor adapter
- `index.ts` — extension state, I/O, lifecycle wiring only
- `lib/*.test.ts` — mirrored Node.js `node:test` suites

## Stack

Node.js 24.19.0 via project mise config + ES2024 + npm + TypeScript 7 + Biome. Runtime source and tests use separate TypeScript configs. Extension loads as `.ts` source.

## Tests

<!-- pi-ci-standard:validation:start -->
## Validation

CI contract for this repository (managed by pi-ci-standard — regenerate with `pi-ci init`):

- Run `mise run check` while iterating; fix all failures before continuing.
- Run `mise run ci` before declaring work complete; it must pass.
- GitHub Actions runs project checks only through managed mise tasks. Never add language-specific check commands to workflows.
<!-- pi-ci-standard:validation:end -->

`npm test` uses `node:test`. `npm run test:coverage` enforces Node coverage thresholds. `npm run smoke:package` verifies an npm production install. Keep pure logic in `lib/`; do not grow untested math in `index.ts`.
