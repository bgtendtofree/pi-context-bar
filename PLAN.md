# Plan: Nerd Font grammar inside editor chrome

Living plan for the current slice of editor chrome. The current baseline is a square framed
editor with theme-token chrome (see AGENTS.md for the binding rules); this document lists what
is shipped, what needs an owner decision, and what remains.

## Scope: chrome, not conversation rendering

- Assistant messages, thinking content, tool calls/results, and compaction notices keep Pi's
  native conversation rendering. This project does not replace their renderers or alter content.
- This project does customize Pi UI through extension APIs: it wraps `CustomEditor`, adds the
  square frame and prompt, moves autocomplete above the editor, replaces the welcome header,
  empties the footer, and hides the redundant working row while active.
- Session events supply context, cost, throughput, and lane phase. Reading these events does
  not make this extension responsible for rendering their conversation content.
- The current shipped slice only adds Nerd Font grammar to information already present in the frame.
  No new status row, tool name, queue indicator, compaction label, or latency metric.

## Baseline (shipped)

- Square frame (`┌ ┐ └ ┘`, `─ │`), no background fills anywhere in the chrome.
- Theme tokens only, never hex. Roles: `text` Pac-Man and typed input, `accent` model id and
  ready prompt and tools ghost, `muted` working ghost and power pellets, `dim` pellets and
  thinking and metrics, `borderMuted` frame, `bashMode` frame while input starts with `!`,
  `warning`/`success`/`error` for phases, thresholds, and failure.
- Prompt state: `❯` accent, `✗` error when the last completed turn stopped with `error`
  (`aborted` keeps the previous state). Derived from the session branch on start and tree nav.
- Nerd Font icons in use: Pac-Man `󰮯`, ghost `󰊠`, reset countdown `󰦛`, reset credits `󰔖`,
  provider badges `cod-openai` `` / `cod-claude` ``, thinking brain `󰧑`, cache database `󰆼`,
  speedometer `󰓅`. ASCII fallback: `C`/`O`/`0`, `>`/`x`, `r52m`, `R1`, no provider badge, no brain,
  `CH` cache label, plain `t/s`.
- Icon grammar shipped: badges only for exact known non-virtual providers, brain only with a
  thinking label (routed included), database replaces `CH` in Nerd mode, speedometer never alone.
  All decorations drop before useful text or numbers; `asciiFallback` output is unchanged.
- Quota group spacing: one space inside a group, two between groups.

## Ground rules for anything added here

- Health chrome stays inside the editor frame; no extra rows.
- Quiet by default: icons inherit their information's existing theme role. Warning/error
  remain reserved for existing thresholds and failure. Never a background fill.
- Every glyph is verified against the official Nerd Font table (`glyphnames.json`) and renders
  width 1 in a Mono Nerd Font. Prefer a Nerd Font icon over ambiguous Unicode arrows:
  U+21BB `↻` is absent from JetBrains Mono, so terminals fall back to another font and the
  glyph renders small and off-baseline. That is why the quota reset uses `󰦛`.
- Every glyph ships an ASCII fallback through `GlyphSet`; ASCII tokens stay compact (`r52m`).
- Widths go through `visibleWidth`; keep the fit and fallback order exact.
- Pure logic in `lib/` with mirrored `node:test` coverage; `index.ts` stays wiring only.
- Update README (and AGENTS.md when a rule changes) in the same change.

## Icon grammar (shipped)

Use the existing `GlyphSet` and `asciiFallback`; do not add another setting or dependency.
Icons change presentation, not metric semantics or lifecycle behavior.

| Information | Nerd Font rendering | ASCII / unsupported provider |
|---|---|---|
| Selected provider before model id | accent `cod-openai` U+EC81 / `cod-claude` U+EC82 | No badge; keep model id |
| Thinking level | dim `· 󰧑 max` (`md-brain` U+F09D1) | Existing `· max` |
| Cache hit | `󰆼 98/94%` (`md-database` U+F01BC) | Existing `CH98/94%` |
| Token speed | dim `󰓅 ~218t/s` (`md-speedometer` U+F04C5) | Existing `~218t/s` |

Implementation contract:

- Verify names/code points against official `glyphnames.json` before implementation. State
  the actual minimum Nerd Font version for the selected badges; do not assume all v3 releases
  include newer Codicons. Verified: `cod-openai` U+EC81 and `cod-claude` U+EC82 first appear in
  Nerd Font v3.5.0 (absent from v3.4.0 and earlier); `md-brain`/`md-database`/`md-speedometer`
  exist since v3.0.0.
- Plumb selected `provider` into `ModelInfo`. Badge only exact known OpenAI
  (`openai`, `openai-codex`) and Anthropic (`anthropic`) providers. Unknown providers have no
  badge. Virtual selections have no provider badge; do not infer provider from a model id or
  pretend the selected provider is the routed physical provider.
- Thinking icons appear only with an existing thinking label, including routed thinking.
- Keep latest/average cache-hit calculation, threshold colors, cost, quota, and reset behavior
  unchanged. The average stays dim; high cache hit stays quiet.
- Keep `~`, numeric precision, and `t/s` units unchanged. Speed icon never appears alone.
- Width fitting must count glyph plus spacing. Decorative icons drop before useful text or
  numeric information; existing model/route/thinking, quota, cache-before-cost, and
  context-window/speed fallback priorities otherwise stay unchanged.
- Test Nerd Font and ASCII output, unknown/virtual/no-model cases, thinking off, routed
  thinking, cache divergence and thresholds, live/completed speed, and narrow width fitting.
- No new timers, event handlers, network requests, conversation renderers, or config flags.

Rejected: icons for the `5h` / `7d` window labels. The window length is information; a clock
glyph loses it.

## Deferred: additional status information

These are not part of the Nerd Font implementation:

- Compaction means Pi summarizes older conversation context to reclaim model capacity, not
  file compression. The existing post-compaction Pac-Man rewind remains; no in-flight label.
- Tool execution already changes the lane ghost's phase/color. Tool names/results stay in
  Pi's native conversation view; do not duplicate them in the frame.
- Queued messages and first-token latency add new information and consume scarce frame width.
  Revisit only on a separate explicit request.

## Considered and rejected

- Git branch or path: AGENTS forbids it in the frame.
- Auto-compact threshold marker in the lane: `getContextUsage()` exposes only `tokens`,
  `contextWindow`, and `percent`; pi does not publish the threshold.
- Auto-retry indicator: `auto_retry_start` / `auto_retry_end` exist only in pi's internal
  `AgentSessionEvent` stream, not as extension events. Inferring it (an `error` `turn_end`
  followed by `agent_start` with no user message in between) is possible but fragile.
- Session totals (tokens, elapsed): competes with `$` for the same slot, low value.
- Account badge (`PLUS` / `API`): only meaningful beside quota; revisit if quota confusion
  comes up.

## Open decisions (owner)

1. Pac-Man color: `text` (current) or neon yellow via `warning`.
2. Frame no longer follows the thinking level; it switches only for bash mode. Restore pi's
   native `this.borderColor` to get the old behavior back.
3. Narrow-width fallback threshold is `width < 9` (was `< 7`) because the body indent is four
   columns and pi's word wrap recurses on wide graphemes below that.
4. Daily pi loads the GitHub package (`packages` in `~/.pi/agent/settings.json`), so the local
   checkout is not what runs day to day. Use `pi --no-extensions -e ./index.ts` to preview, or
   switch to `pi install -l file:./`.

## Verification recipe

- `mise run check` while iterating; `mise run ci` before declaring work complete.
- Live preview in a scratch pane: `pi --no-extensions -e ./index.ts`, then `/reload` after
  edits.
- Read the pane with ANSI enabled and check the roles: `38;2;...` foreground per token, no
  `48;...` background codes anywhere in the chrome, `borderMuted` on the frame, `bashMode`
  while the input starts with `!`.
- Tests assert the absence of `↻` and of background codes, so a regression shows up in
  `mise run ci` rather than in a screenshot.
