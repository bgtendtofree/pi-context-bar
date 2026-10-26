# Plan: Nerd Font grammar inside editor chrome

Living plan for the current slice of editor chrome. The current baseline is an open-sided
editor with theme-token chrome (see AGENTS.md for the binding rules); this document lists what
is shipped, what needs an owner decision, and what remains.

## Scope: chrome, not conversation rendering

- Assistant messages, thinking content, tool calls/results, and compaction notices keep Pi's
  native conversation rendering. This project does not replace their renderers or alter content.
- This project does customize Pi UI through extension APIs: it wraps `CustomEditor`, adds the
  full-width top lane, bottom rule, and prompt, moves autocomplete above the editor, replaces the welcome header,
  empties the footer, and hides the redundant working row while active.
- Session events supply context, cost, throughput, and lane phase. Reading these events does
  not make this extension responsible for rendering their conversation content.
- The current shipped slice only adds Nerd Font grammar to information already present in the frame.
  No new status row, tool name, queue indicator, compaction label, or latency metric.

## Baseline (shipped)

- Open sides with a full-width top lane (no `─` caps or filler) and a bottom `─` rule;
  no corners or background fills. Prompt and header are flush left; typed text follows the glyph
  and one space, with continuation rows, mouse, and IME aligned. Right input gutter and bottom
  metric positions stay unchanged; no extra rows. Scroll counts remain visible.
- Theme tokens only, never hex. Roles: `text` Pac-Man and typed input, `accent` model id and
  ready prompt and tools and thinking ghost, `muted` working ghost and power pellets, `dim` pellets and
  thinking level and metrics, `borderMuted` bottom rule, `bashMode` bottom rule while input starts with `!`,
  `warning`/`error` for thresholds and failure, `success` for a completed response. A source test
  in `lib/chrome.sources.test.ts` fails the build on any hex color or raw ANSI escape in chrome sources.
- Prompt state: `❯` accent, `✗` error when the last completed turn stopped with `error`
  (`aborted` keeps the previous state). Derived from the session branch on start and tree nav.
- Nerd Font icons in use: Pac-Man `󰮯`, ghost `󰊠`, reset countdown `󰦛`, reset credits `󰔖`,
  cache database `󰆼`, speedometer `󰓅`. ASCII fallback: `C`/`O`/`0`, `>`/`x`, `r52m`, `R1`, `CH` cache label, plain `t/s`.
- Icon grammar shipped: thinking level stays
  plain dim text (no brain), database replaces `CH` in Nerd mode, speedometer never alone.
  All decorations drop before useful text or numbers; `asciiFallback` output is unchanged.
- Quota hierarchy shipped: healthy windows show only label + used percent; a window above 70%
  shows its reset countdown, and banked credits show only while any reported quota (weekly
  included) is above 70%; countdowns and credits drop before window percentages.
- Quota group spacing: one space inside a group, two between groups.
- Ghost states (three, not four): `muted` quiet while work has started without streamed output, `accent`
  generating (reasoning and tool-call arguments share it — the palette has one non-state hue), `success`
  while the answer streams. `warning`/`error` stay reserved for thresholds and failure. Locked by a test.
- Startup header (Omarchy-aligned): pi's mark as half blocks `▀▀█` over `█▀ █` in `accent`, version
  `dim` beside it, hints on the mark's second row, indent at the editor's prompt column. Single-color
  silhouette, no background fills, fallback to the `pi vX` wordmark when the width cannot fit the mark.
  `quietStartup: true` skips the replacement header so Pi's own startup output stays hidden.
- Apple Terminal forces the `pi vX` wordmark instead of the half-block mark, matching Pi's own
  `supportsPiLogo()`; the decision is the pure `headerMark(ascii, appleTerminal)` in `lib/header.ts`.
- `/context-bar ascii-fallback [on|off|toggle]` switches the glyph set for the rest of the session.
  Runtime only: nothing is written and the next session start reads the config file again, so the
  file stays the single source of truth and the command never rewrites keys it does not own.
- Slot ownership: this extension holds the header, footer, and editor slots, and Pi keeps exactly one
  owner per slot with the last install winning. README states the conflict with other chrome
  extensions instead of letting one silently replace half the chrome.
- Unrecognized Pi editor layout: when the frame loses the border it captured this render pass, it keeps
  Pi's own editor and reports it once per editor through `onUnrecognizedLayout`. The known
  narrow-width fallback stays silent because it is intended.

## Ground rules for anything added here

- Health chrome stays on the editor's top and bottom rows; no extra rows.
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

## Current slice: quiet subscription quota (approved, shipped)

- Keep one bottom border; do not add a quota row.
- Thinking levels stay dim plain text, including
  routed thinking; remove the redundant brain glyph and its unused code.
- Healthy quota windows show only their label and used percentage, e.g. `5h 53%  7d 43%`.
- Show a future reset countdown only for a window whose used percentage is above 70%, matching
  the existing warning boundary. At exactly 70% the window is still quiet.
- Show available banked reset credits only when any reported quota is above 70%. Zero/unknown
  credits remain hidden. This is display policy, not a change to reset redemption.
- Fit model, essential quota percentages, and cache/cost first, then use spare width for
  countdowns and credit detail. Optional quota detail must not displace those baseline readings.
  Retain theme roles, quota fetching, and reset-command safety behavior.
- Keep Pac-Man, provider, cache, and speed glyphs single-cell. Small provider/speed glyphs are
  quiet secondary cues; no terminal configuration, font-size changes, or scaling escapes.
- Mirror healthy/high/mixed/exact-threshold/expired/missing-data cases in Nerd and ASCII tests;
  retain whole-editor width/metric-preservation coverage and native conversation rendering.

## Icon grammar (shipped)

Use the existing `GlyphSet` and `asciiFallback`; do not add another setting or dependency.
Icons change presentation, not metric semantics or lifecycle behavior.

| Information | Nerd Font rendering | ASCII / unsupported provider |
|---|---|---|
| Cache hit | `󰆼 98/94%` (`md-database` U+F01BC) | Existing `CH98/94%` |
| Token speed | dim `󰓅 ~218t/s` (`md-speedometer` U+F04C5) | Existing `~218t/s` |

Thinking levels stay plain dim text (`· max`, routed thinking included); the brain icon was
shipped and then removed as redundant in the quiet-quota slice.

Implementation contract:

- Verify names/code points against official `glyphnames.json` before implementation. Verified:
  `md-database` and `md-speedometer` exist since Nerd Font v3.0.0. Provider badges were shipped
  and then removed: they carried no information the model id did not already carry, and the
  Codicon codepoints they needed only exist from v3.5.0.
- Do not infer a provider from a model id, and do not pretend the selected provider is the
  routed physical provider; routed thinking stays plain dim text beside the route arrow.
- Keep latest/average cache-hit calculation, threshold colors, cost, and reset behavior
  unchanged. The average stays dim; high cache hit stays quiet. Quota display follows the
  quiet-quota slice above.
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
- Reading other extensions' statuses (`ctx.ui.setStatus` / `footerData.getExtensionStatuses()`) into the
  frame: the chrome erases the footer, so there is no read point left, and the values that exist in the
  wild (an MCP badge from a third-party adapter, `active-agent` from a subagent extension) publish
  nothing on a machine without those extensions. Pi's own MCP extension publishes no status at all.
- Reporting agent state outward to an orchestrator through the chrome: the orchestrator already owns
  that view (herdr reports per-pane agent state over its own socket, not through Pi's status bus).
- Persisting the ASCII toggle into the config file: the file is read once at startup, and writing it
  would mean rewriting a user's file to preserve keys this extension does not own.
- A resource-panel style startup screen (loaded context, skills, prompts, extensions grouped by
  provenance): it needs a bridge into Pi's private startup-panel structure and grows without a row
  budget, so it fights the one-frame, no-extra-rows rule.
- Checking installed package extensions against the npm registry at startup: a network request and a
  second diagnostic surface for a chrome extension that reports this session's health.

## Open decisions (owner)

1. Pac-Man color: `text` (current) or neon yellow via `warning`.
2. Frame no longer follows the thinking level; it switches only for bash mode. Restore pi's
   native `this.borderColor` to get the old behavior back.
3. Narrow-width fallback threshold is `width < 6`: two prompt columns, one right gutter,
   and at least three native editor columns so pi's word wrap can handle wide graphemes.
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
