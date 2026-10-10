# Plan: chrome status indicators and icons

Living plan for the next slice of editor chrome. The current baseline is a square framed
editor with theme-token chrome (see AGENTS.md for the binding rules); this document lists what
is shipped, what needs an owner decision, and what to build next.

## Baseline (shipped)

- Square frame (`┌ ┐ └ ┘`, `─ │`), no background fills anywhere in the chrome.
- Theme tokens only, never hex. Roles: `text` Pac-Man and typed input, `accent` model id and
  ready prompt and tools ghost, `muted` working ghost and power pellets, `dim` pellets and
  thinking and metrics, `borderMuted` frame, `bashMode` frame while input starts with `!`,
  `warning`/`success`/`error` for phases, thresholds, and failure.
- Prompt state: `❯` accent, `✗` error when the last completed turn stopped with `error`
  (`aborted` keeps the previous state). Derived from the session branch on start and tree nav.
- Nerd Font icons in use: Pac-Man `󰮯`, ghost `󰊠`, reset countdown `󰦛`, reset credits `󰔖`.
  ASCII fallback: `C`/`O`/`0`, `>`/`x`, `r52m`, `R1`.
- Quota group spacing: one space inside a group, two between groups.

## Ground rules for anything added here

- Health chrome stays inside the editor frame; no extra rows.
- Quiet by default: transient indicators appear only while active, stay `dim`, and use `error`
  only for real failures. Never a background fill.
- Every glyph is verified against the official Nerd Font table (`glyphnames.json`) and renders
  width 1 in a Mono Nerd Font. Prefer a Nerd Font icon over ambiguous Unicode arrows:
  U+21BB `↻` is absent from JetBrains Mono, so terminals fall back to another font and the
  glyph renders small and off-baseline. That is why the quota reset uses `󰦛`.
- Every glyph ships an ASCII fallback through `GlyphSet`; ASCII tokens stay compact (`r52m`).
- Widths go through `visibleWidth`; keep the fit and fallback order exact.
- Pure logic in `lib/` with mirrored `node:test` coverage; `index.ts` stays wiring only.
- Update README (and AGENTS.md when a rule changes) in the same change.

## Next: Tier 1 indicators

Transient, quiet, and each has a direct data source.

| Indicator | Data source | Render | ASCII |
|---|---|---|---|
| Queued follow-ups | `ctx.hasPendingMessages()` | dim `󱊖` (`md-tray-full` U+F1296) | `Q` |
| Compaction in flight | `session_before_compact` → `session_compact` / `session_compact_failed` | dim `󰀼` (`md-archive` U+F003C) + `compacting`; `error` on failure | `zip` |
| Running tool | `tool_execution_start` (`toolName`) → `tool_execution_end` | dim `󰖷` (`md-wrench` U+F05B7) + tool name, truncated | `<name>` |
| First-token latency | `message_start` → first `message_update` | dim `0.6s` (1 decimal under 10s, then `12s`) | same |

Notes.

- Queued: `hasPendingMessages()` is a boolean; there is no count to show.
- Compaction: payload carries `reason` (`manual` | `threshold` | `overflow`), `willRetry`, and
  `errorMessage`. Make sure the indicator always clears, including the aborted path, and test
  that it cannot stick.
- Running tool: the lane ghost already marks the tools phase; the name adds detail, so keep it
  dim. Nested calls carry `parentToolCallId` — show the outermost call only.
- Latency: measure locally with `performance.now()`. It excludes tool gaps by definition and
  must not be confused with `t/s`, which stays the throughput metric.
- Placement: all four belong to the bottom-left group, next to model, thinking, and quota.
  Decide the fixed slot order before implementing (suggested: tool, compaction, queue, then
  quota) so the line does not reshuffle while streaming.

## Optional: icon grammar for existing metrics

Replaces text labels, not information. Each row needs an ASCII fallback that keeps the current
label (`CH`, `max`, `12t/s`).

| Metric | Icon | Code point | Notes |
|---|---|---|---|
| Provider badge before model id | `cod-openai` / `cod-claude` | U+EC81 / U+EC82 | Requires Nerd Font v3 (README already requires v3+); needs `provider` plumbed into `ModelInfo` |
| Thinking level | `md-brain` | U+F09D1 | `· 󰧑 max` |
| Cache hit (`CH`) | `md-database` | U+F01BC | Avoid `md-cached` U+F00E8: too close to `md-restore` U+F099B used for resets |
| Token speed | `md-speedometer` | U+F04C5 | `󰓅 218t/s`; keeps the `t/s` unit |

Rejected: icons for the `5h` / `7d` window labels. The window length is information; a clock
glyph loses it.

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
