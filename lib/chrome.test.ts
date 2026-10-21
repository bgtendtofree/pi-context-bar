import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	ASCII_GLYPHS,
	activityAfterContext,
	activityForAssistantEvent,
	type ChromeStyles,
	formatCost,
	formatDuration,
	formatWindowSize,
	GHOST_GLYPH,
	GHOST_TOKENS,
	metricOptions,
	NERD_GLYPHS,
	PACMAN_CLOSED_GLYPH,
	PACMAN_FRAMES,
	PACMAN_GLYPH,
	PELLET_GLYPH,
	POWER_PELLET_GLYPH,
	POWER_PELLET_RATIOS,
	type QuotaLimit,
	type QuotaUsage,
	quotaRender,
	renderLaneStrip,
	renderPacmanLane,
	USAGE_ERROR_PERCENT,
	USAGE_WARNING_PERCENT,
} from "./chrome.ts";
import type { ContextSnapshot, SessionUsage } from "./context.ts";

const usage = (partial: Partial<SessionUsage> = {}): SessionUsage => ({
	cost: 0,
	cacheHitRate: undefined,
	cacheHitRateAvg: undefined,
	...partial,
});

const snapshot = (partial: Partial<ContextSnapshot> = {}): ContextSnapshot => ({
	usedTokens: 0,
	contextWindow: 200_000,
	...partial,
});

const identityStyles: ChromeStyles = { fg: (_token, text) => text };

const markedStyles: ChromeStyles = { fg: (token, text) => `<${token}>${text}</${token}>` };

/** Foreground-only painter: the chrome must never emit a background escape. */
const fgOnlyStyles: ChromeStyles = { fg: (_token, text) => `\x1b[38;5;7m${text}\x1b[39m` };

const recorder = (): Readonly<{ styles: ChromeStyles; seen: Array<readonly [string, string]> }> => {
	const seen: Array<readonly [string, string]> = [];
	return {
		styles: {
			fg: (token, text) => {
				seen.push([token, text]);
				return text;
			},
		},
		seen,
	};
};

const dominantSnapshot = snapshot({
	usedTokens: 57_976,
	contextWindow: 372_000,
});

describe("health metric formatting", () => {
	const full = usage({ cost: 1.61, cacheHitRate: 97.9 });

	test("formats cost with useful precision", () => {
		assert.equal(formatCost(0), "");
		assert.equal(formatCost(0.042), "$0.042");
		assert.equal(formatCost(1.61), "$1.61");
		// A sub-mill cost is real money; it must never round down to a misleading `$0.000`.
		assert.equal(formatCost(0.0004), "<$0.001");
		assert.equal(formatCost(0.001), "$0.001");
		assert.equal(formatCost(Number.NaN), "");
		assert.equal(formatCost(Number.POSITIVE_INFINITY), "");
	});

	test("formats remaining time for quota windows and resets", () => {
		const now = Date.parse("2026-07-01T00:00:00Z");
		const left = (iso: string): number => Date.parse(iso) - now;
		assert.equal(formatDuration(left("2026-07-01T00:12:00Z")), "12m");
		assert.equal(formatDuration(left("2026-07-01T05:10:00Z")), "5h 10m");
		assert.equal(formatDuration(left("2026-07-03T03:30:00Z")), "2d 3h");
		assert.equal(formatDuration(0), "expired");
		assert.equal(formatDuration(-1), "expired");
		for (const ms of [1, 30_000, 59_999]) assert.equal(formatDuration(ms), "<1m");
		assert.equal(formatDuration(60_000), "1m");
		// Whole hours and days drop the zero component instead of printing "6h 0m".
		assert.equal(formatDuration(left("2026-07-01T06:00:00Z")), "6h");
		assert.equal(formatDuration(left("2026-07-02T00:00:00Z")), "1d");
		assert.equal(formatDuration(left("2026-07-04T01:00:00Z")), "3d 1h");
		// Non-finite input must not leak a `NaNd NaNh` reading into the border.
		assert.equal(formatDuration(Number.NaN), "expired");
		assert.equal(formatDuration(Number.POSITIVE_INFINITY), "expired");
	});

	test("builds wide and narrow options", () => {
		const nerd = metricOptions(full, identityStyles, NERD_GLYPHS);
		assert.equal(nerd[0]?.decorated, `${NERD_GLYPHS.cache} 98%  $1.61`);
		assert.equal(nerd[0]?.plain, "98%  $1.61");
		assert.equal(nerd[1]?.decorated, `${NERD_GLYPHS.cache} 98%`);
		assert.equal(nerd[1]?.plain, "98%");
		const ascii = metricOptions(full, identityStyles, ASCII_GLYPHS);
		assert.equal(ascii[0]?.plain, "CH98%  $1.61");
		assert.equal(ascii[1]?.plain, "CH98%");
		// Last option is the empty reading used when no metric fits at all.
		assert.equal(nerd.at(-1)?.plain, "");
	});

	test("keeps cost when cache is unknown", () => {
		for (const glyphs of [NERD_GLYPHS, ASCII_GLYPHS]) {
			const options = metricOptions(usage({ cost: 0.042 }), identityStyles, glyphs);
			assert.equal(options[0]?.plain, "$0.042");
			assert.equal(options[0]?.decorated, "$0.042");
			assert.equal(
				options.every((option) => !option.plain.includes("CH") && !option.plain.includes(NERD_GLYPHS.cache)),
				true,
			);
		}
	});
});

describe("semantic metric styling", () => {
	test("keeps healthy cache quiet", () => {
		const nerd = metricOptions(usage({ cost: 6.65, cacheHitRate: 99 }), markedStyles, NERD_GLYPHS)[0]?.decorated ?? "";
		assert.ok(nerd.includes(`<dim>${NERD_GLYPHS.cache} 99</dim>%`));
		assert.ok(!nerd.includes("<warning>"));
		assert.ok(!nerd.includes("<error>"));
		const ascii =
			metricOptions(usage({ cost: 6.65, cacheHitRate: 99 }), markedStyles, ASCII_GLYPHS)[0]?.decorated ?? "";
		assert.ok(ascii.includes("<dim>CH99</dim>%"));
	});

	test("rounds the cache rate once so the label and its color agree", () => {
		const healthy = metricOptions(usage({ cacheHitRate: 79.6 }), markedStyles, ASCII_GLYPHS)[0]?.decorated ?? "";
		assert.ok(healthy.includes("<dim>CH80</dim>%"));
		const warning = metricOptions(usage({ cacheHitRate: 49.6 }), markedStyles, ASCII_GLYPHS)[0]?.decorated ?? "";
		assert.ok(warning.includes("<warning>CH50</warning>%"));
	});

	test("accents only unhealthy cache", () => {
		const warning = metricOptions(usage({ cacheHitRate: 60 }), markedStyles, ASCII_GLYPHS)[0]?.decorated ?? "";
		assert.ok(warning.includes("<warning>CH60</warning>%"));
		const error = metricOptions(usage({ cacheHitRate: 20 }), markedStyles, ASCII_GLYPHS)[0]?.decorated ?? "";
		assert.ok(error.includes("<error>CH20</error>%"));
		assert.equal(metricOptions(usage(), markedStyles, ASCII_GLYPHS)[0]?.decorated, "");
	});
});

describe("Pac-Man lane", () => {
	test("moves left to right while eaten pellets become empty space", () => {
		const empty = stripVTControlCharacters(
			renderPacmanLane(snapshot({ usedTokens: 0, contextWindow: 100 }), 18, identityStyles),
		);
		const half = stripVTControlCharacters(
			renderPacmanLane(snapshot({ usedTokens: 50, contextWindow: 100 }), 18, identityStyles),
		);
		const full = stripVTControlCharacters(
			renderPacmanLane(snapshot({ usedTokens: 100, contextWindow: 100 }), 18, identityStyles),
		);
		assert.equal(visibleWidth(empty), 18);
		assert.equal(visibleWidth(half), 18);
		assert.equal(visibleWidth(full), 18);
		assert.equal(empty.split(PELLET_GLYPH).length - 1, 6);
		assert.equal(empty.split(POWER_PELLET_GLYPH).length - 1, 2);
		assert.equal(half.split(PELLET_GLYPH).length - 1, 2);
		assert.equal(half.indexOf(PACMAN_GLYPH), 8);
		assert.equal(full.includes(PELLET_GLYPH), false);
	});

	test("paints Pac-Man text, pellets dim, and power pellets muted", () => {
		const { styles, seen } = recorder();
		renderPacmanLane(snapshot({ usedTokens: 0, contextWindow: 100 }), 18, styles);
		assert.ok(seen.some(([token, text]) => token === "text" && text.includes(PACMAN_GLYPH)));
		assert.ok(seen.some(([token, text]) => token === "dim" && text.includes(PELLET_GLYPH)));
		assert.ok(seen.some(([token, text]) => token === "muted" && text.includes(POWER_PELLET_GLYPH)));
	});

	test("animates mouth without resurrecting pellets", () => {
		const open = stripVTControlCharacters(renderPacmanLane(snapshot(), 10, identityStyles, 0, "working"));
		const closed = stripVTControlCharacters(renderPacmanLane(snapshot(), 10, identityStyles, 1, "working"));
		assert.ok(open.includes(PACMAN_FRAMES[0]));
		assert.ok(closed.includes(PACMAN_FRAMES[1]));
		assert.equal(open.split(PELLET_GLYPH).length - 1, 2);
		assert.equal(closed.split(PELLET_GLYPH).length - 1, 2);
	});

	test("loosens wide-lane spacing without capping width or changing usage ratios", () => {
		assert.equal(POWER_PELLET_GLYPH, "○");
		for (const width of [79, 80, 81, 120, 200]) {
			const cellWidth = width >= 80 ? 3 : 2;
			const lastCell = Math.floor(width / cellWidth) - 1;
			for (const usedTokens of [0, 50, 100]) {
				const lane = stripVTControlCharacters(
					renderPacmanLane(snapshot({ usedTokens, contextWindow: 100 }), width, identityStyles),
				);
				assert.equal(visibleWidth(lane), width);
				assert.equal(lane.indexOf(PACMAN_GLYPH), Math.round((usedTokens / 100) * lastCell) * cellWidth);
				if (usedTokens === 0) assert.ok(lane.startsWith(`${PACMAN_GLYPH}${" ".repeat(cellWidth - 1)}`));
			}
		}
		const wide = stripVTControlCharacters(renderPacmanLane(snapshot(), 120, identityStyles));
		assert.equal(wide.split(PELLET_GLYPH).length - 1, 37);
		assert.equal(wide.split(POWER_PELLET_GLYPH).length - 1, 2);
	});

	test("pins open-mouth Pac-Man while idle", () => {
		assert.ok(stripVTControlCharacters(renderPacmanLane(snapshot(), 10, identityStyles, 1)).includes(PACMAN_GLYPH));
		assert.ok(
			!stripVTControlCharacters(renderPacmanLane(snapshot(), 10, identityStyles, 1)).includes(PACMAN_FRAMES[1]),
		);
	});

	test("context assembly only promotes a fresh model turn", () => {
		assert.equal(activityAfterContext("working"), "thinking");
		assert.equal(activityAfterContext("thinking"), "thinking");
		assert.equal(activityAfterContext("assistant"), "assistant");
		assert.equal(activityAfterContext("tools"), "tools");
		assert.equal(activityAfterContext("idle"), "idle");
	});

	test("maps assistant stream events to generating versus answering", () => {
		// Tool-call arguments are still the model generating, never the answer itself.
		for (const type of ["thinking_start", "thinking_delta"]) assert.equal(activityForAssistantEvent(type), "thinking");
		for (const type of ["text_start", "text_delta"]) assert.equal(activityForAssistantEvent(type), "assistant");
		for (const type of ["toolcall_start", "toolcall_delta"]) assert.equal(activityForAssistantEvent(type), "tools");
		assert.equal(activityForAssistantEvent("done"), undefined);
		assert.equal(activityForAssistantEvent(""), undefined);
	});

	test("shows a token-colored ghost only while active", () => {
		const active = snapshot({ usedTokens: 100, contextWindow: 100 });
		const idle = recorder();
		renderPacmanLane(active, 18, idle.styles);
		assert.equal(
			idle.seen.some(([, text]) => text.includes(GHOST_GLYPH)),
			false,
		);
		for (const [activity, token] of Object.entries(GHOST_TOKENS)) {
			const { styles, seen } = recorder();
			renderPacmanLane(active, 18, styles, 0, activity as keyof typeof GHOST_TOKENS);
			assert.ok(seen.some(([seenToken, text]) => seenToken === token && text.includes(GHOST_GLYPH)));
		}
	});

	test("keeps activity out of the warning and error roles", () => {
		// Warning/error mark a crossed threshold or a failure, the way Omarchy keeps `urgent` for attention.
		for (const token of Object.values(GHOST_TOKENS)) {
			assert.ok(token !== "warning" && token !== "error", `ghost token ${token} is a threshold role`);
		}
	});

	test("carries exactly three ghost states: quiet, generating, answering", () => {
		// Reasoning and tool calls share `accent` on purpose: the palette has no fourth hue that is
		// not a state color or a content role, and activity must not borrow either.
		assert.equal(GHOST_TOKENS.thinking, GHOST_TOKENS.tools);
		assert.deepEqual([...new Set(Object.values(GHOST_TOKENS))], ["muted", "accent", "success"]);
	});

	test("marks warning thresholds with power pellets that get eaten", () => {
		const hungry = stripVTControlCharacters(
			renderPacmanLane(snapshot({ usedTokens: 0, contextWindow: 100 }), 18, identityStyles),
		);
		assert.equal(hungry.split(POWER_PELLET_GLYPH).length - 1, POWER_PELLET_RATIOS.length);
		const pastWarning = stripVTControlCharacters(
			renderPacmanLane(snapshot({ usedTokens: 80, contextWindow: 100 }), 18, identityStyles),
		);
		assert.equal(pastWarning.split(POWER_PELLET_GLYPH).length - 1, 1);
		const pastError = stripVTControlCharacters(
			renderPacmanLane(snapshot({ usedTokens: 95, contextWindow: 100 }), 18, identityStyles),
		);
		assert.equal(pastError.includes(POWER_PELLET_GLYPH), false);
		assert.equal(pastError.includes(PELLET_GLYPH), false);
	});

	test("ties the power-pellet ratios and the color thresholds together", () => {
		// The pellets mark the same percents that flip the metric color, so they must be derived from
		// the shared thresholds instead of duplicated literals that can drift apart.
		assert.deepEqual([...POWER_PELLET_RATIOS], [USAGE_WARNING_PERCENT / 100, USAGE_ERROR_PERCENT / 100]);
		const at = (percent: number): string =>
			renderLaneStrip(snapshot({ usedTokens: percent, contextWindow: 100 }), 80, markedStyles);
		assert.ok(at(USAGE_WARNING_PERCENT).includes(`<dim>${USAGE_WARNING_PERCENT}.0%</dim>`));
		assert.ok(at(USAGE_WARNING_PERCENT + 0.1).includes(`<warning>${USAGE_WARNING_PERCENT + 0.1}%</warning>`));
		assert.ok(at(USAGE_ERROR_PERCENT).includes(`<warning>${USAGE_ERROR_PERCENT}.0%</warning>`));
		assert.ok(at(USAGE_ERROR_PERCENT + 0.1).includes(`<error>${USAGE_ERROR_PERCENT + 0.1}%</error>`));
	});

	test("moves ghost chase distance and handles tiny lanes", () => {
		const active = snapshot({ usedTokens: 100, contextWindow: 100 });
		const close = stripVTControlCharacters(renderPacmanLane(active, 18, identityStyles, 0, "working"));
		const far = stripVTControlCharacters(renderPacmanLane(active, 18, identityStyles, 2, "working"));
		assert.ok(close.indexOf(GHOST_GLYPH) > far.indexOf(GHOST_GLYPH));
		assert.equal(renderPacmanLane(snapshot(), 0, identityStyles), "");
		assert.equal(stripVTControlCharacters(renderPacmanLane(snapshot(), 1, identityStyles)), PACMAN_GLYPH);
		assert.equal(
			stripVTControlCharacters(
				renderPacmanLane(snapshot({ usedTokens: 25, contextWindow: 100 }), 10, identityStyles, 0, "tools"),
			).includes(GHOST_GLYPH),
			false,
		);
	});

	test("swaps in ASCII glyphs for terminals without a Nerd Font", () => {
		const active = snapshot({ usedTokens: 100, contextWindow: 100 });
		const open = stripVTControlCharacters(renderPacmanLane(snapshot(), 10, identityStyles, 0, "working", ASCII_GLYPHS));
		const closed = stripVTControlCharacters(
			renderPacmanLane(snapshot(), 10, identityStyles, 1, "working", ASCII_GLYPHS),
		);
		const ghost = stripVTControlCharacters(renderPacmanLane(active, 18, identityStyles, 0, "tools", ASCII_GLYPHS));
		assert.ok(open.includes(ASCII_GLYPHS.pacmanOpen));
		assert.ok(closed.includes(ASCII_GLYPHS.pacmanClosed));
		assert.ok(ghost.includes(ASCII_GLYPHS.ghost));
		assert.ok(!open.includes(PACMAN_GLYPH));
		assert.ok(!closed.includes(PACMAN_FRAMES[1] ?? ""));
		assert.ok(!ghost.includes(GHOST_GLYPH));
		// ASCII replaces the ambiguous-width pellets too, so the lane stays single-cell in any font.
		for (const lane of [open, closed, ghost]) {
			assert.ok(!lane.includes(PELLET_GLYPH), lane);
			assert.ok(!lane.includes(POWER_PELLET_GLYPH), lane);
		}
		assert.ok(open.includes(ASCII_GLYPHS.pellet));
		assert.ok(open.includes(ASCII_GLYPHS.powerPellet));
	});

	test("keeps Nerd pellets and thresholds while ASCII swaps only the glyphs", () => {
		const positions = (lane: string, glyph: string): readonly number[] =>
			[...lane].flatMap((char, index) => (char === glyph ? [index] : []));
		for (const width of [10, 18, 79, 80, 120]) {
			const nerd = stripVTControlCharacters(renderPacmanLane(snapshot(), width, identityStyles));
			const ascii = stripVTControlCharacters(
				renderPacmanLane(snapshot(), width, identityStyles, 0, "idle", ASCII_GLYPHS),
			);
			assert.equal(visibleWidth(nerd), width);
			assert.equal(visibleWidth(ascii), width);
			assert.equal(nerd.split(PELLET_GLYPH).length, ascii.split(ASCII_GLYPHS.pellet).length);
			assert.deepEqual(positions(ascii, ASCII_GLYPHS.powerPellet), positions(nerd, POWER_PELLET_GLYPH));
		}
	});

	test("clamps unknown, negative, and overfull usage", () => {
		const unknown = stripVTControlCharacters(renderPacmanLane(snapshot({ contextWindow: 0 }), 10, identityStyles));
		assert.equal(unknown.startsWith(PACMAN_GLYPH), true);
		// Null tokens are unknown, not zero; the lane stays neutral (Pac-Man then blank space, no pellets).
		const unknownLane = stripVTControlCharacters(
			renderPacmanLane(snapshot({ usedTokens: null, contextWindow: 100 }), 18, identityStyles),
		);
		assert.ok(unknownLane.startsWith(PACMAN_GLYPH));
		assert.ok(!unknownLane.includes(PELLET_GLYPH));
		assert.ok(!unknownLane.includes(POWER_PELLET_GLYPH));
		assert.equal(visibleWidth(unknownLane), 18);
		// A known zero still claims remaining capacity with pellets.
		assert.ok(
			stripVTControlCharacters(
				renderPacmanLane(snapshot({ usedTokens: 0, contextWindow: 100 }), 18, identityStyles),
			).includes(PELLET_GLYPH),
		);
		const negative = stripVTControlCharacters(
			renderPacmanLane(snapshot({ usedTokens: -10, contextWindow: 100 }), 10, identityStyles),
		);
		assert.equal(negative.startsWith(PACMAN_GLYPH), true);
		const overfull = stripVTControlCharacters(
			renderPacmanLane(snapshot({ usedTokens: 200, contextWindow: 100 }), 10, identityStyles),
		);
		assert.equal(overfull.trimEnd().endsWith(PACMAN_GLYPH), true);
	});
});

describe("lane strip", () => {
	test("paints foreground tokens only, never a background", () => {
		const active = snapshot({ usedTokens: 100_000 });
		const strip = renderLaneStrip(active, 60, fgOnlyStyles, 0, "tools");
		assert.ok(strip.includes("\x1b[38;5;"));
		assert.ok(!strip.includes("\x1b[38;2;"));
		assert.ok(!strip.includes("\x1b[48;"));
		assert.equal(
			stripVTControlCharacters(strip),
			stripVTControlCharacters(renderLaneStrip(active, 60, identityStyles, 0, "tools")),
		);
		assert.equal(renderPacmanLane(active, 1, fgOnlyStyles, 0, "idle", ASCII_GLYPHS), "\x1b[38;5;7mC\x1b[39m");
	});

	test("shows an unavailable reading instead of a false zero when tokens are unknown", () => {
		const unknown = stripVTControlCharacters(renderLaneStrip(snapshot({ usedTokens: null }), 60, identityStyles));
		assert.ok(unknown.includes("?%"));
		assert.ok(!unknown.includes("0.0%"));
		assert.ok(unknown.includes(PACMAN_GLYPH));
		// A known window plus unknown tokens still shows the quiet reading at a tight width.
		assert.ok(
			stripVTControlCharacters(renderLaneStrip(snapshot({ usedTokens: null }), 12, identityStyles)).includes("?%"),
		);
		// No window at all (a virtual model without limits) keeps the same unknown indicator.
		assert.ok(
			stripVTControlCharacters(renderLaneStrip({ usedTokens: null, contextWindow: 0 }, 60, identityStyles)).includes(
				"?%",
			),
		);
	});

	test("fills the width with lane, percent, and quiet speed", () => {
		const strip = stripVTControlCharacters(
			renderLaneStrip(dominantSnapshot, 40, identityStyles, 0, "idle", { tokensPerSecond: 42.25, estimated: true }),
		);
		assert.equal(visibleWidth(strip), 40);
		assert.ok(strip.includes("15.6%"));
		assert.ok(strip.endsWith("~42.3t/s "));
		assert.ok(strip.includes(PACMAN_GLYPH));
	});

	test("appends the window size to the percent", () => {
		const strip = stripVTControlCharacters(
			renderLaneStrip(dominantSnapshot, 40, identityStyles, 0, "idle", {
				tokensPerSecond: 42.25,
				estimated: true,
			}),
		);
		assert.ok(strip.includes("15.6% (372K)"));
	});

	test("accents only unhealthy percent while keeping window size dim", () => {
		assert.ok(
			renderLaneStrip(snapshot({ usedTokens: 150_000 }), 80, markedStyles).includes(
				"<warning>75.0%</warning> <dim>(200K)</dim>",
			),
		);
		assert.ok(
			renderLaneStrip(snapshot({ usedTokens: 190_000 }), 80, markedStyles).includes(
				"<error>95.0%</error> <dim>(200K)</dim>",
			),
		);
	});

	test("formats window sizes compactly", () => {
		assert.equal(formatWindowSize(200_000), "200K");
		assert.equal(formatWindowSize(372_000), "372K");
		assert.equal(formatWindowSize(1_000_000), "1M");
		assert.equal(formatWindowSize(999_999), "1M");
		// One decimal keeps a fractional unit honest on both sides of the K/M boundary.
		assert.equal(formatWindowSize(1_048_576), "1M");
		assert.equal(formatWindowSize(999_499), "999.5K");
		assert.equal(formatWindowSize(1_500), "1.5K");
		assert.equal(formatWindowSize(1_500_000), "1.5M");
		assert.equal(formatWindowSize(512), "512");
		assert.equal(formatWindowSize(0), "0");
		// A non-finite or negative window has no compact form; the caller drops the label.
		assert.equal(formatWindowSize(-1), "");
		assert.equal(formatWindowSize(Number.NaN), "");
		assert.equal(formatWindowSize(Number.POSITIVE_INFINITY), "");
	});

	test("drops window size to plain percent on narrow strips", () => {
		const narrow = stripVTControlCharacters(
			renderLaneStrip(dominantSnapshot, 16, identityStyles, 0, "idle", { tokensPerSecond: 42.25, estimated: true }),
		);
		assert.ok(!narrow.includes("(372K)"));
		assert.ok(narrow.includes("15.6%"));
	});

	test("drops speed before percent on narrow strips", () => {
		const narrow = stripVTControlCharacters(
			renderLaneStrip(dominantSnapshot, 14, identityStyles, 0, "idle", { tokensPerSecond: 42.25, estimated: true }),
		);
		assert.ok(!narrow.includes("t/s"));
		assert.ok(narrow.includes("15.6%"));
	});

	test("drops the speedometer icon before the speed reading and keeps the window", () => {
		const speed = { tokensPerSecond: 42.25, estimated: true };
		const tight = stripVTControlCharacters(
			renderLaneStrip(dominantSnapshot, 28, identityStyles, 0, "idle", speed, NERD_GLYPHS),
		);
		assert.ok(tight.includes("~42.3t/s"));
		assert.ok(tight.includes("(372K)"));
		assert.ok(!tight.includes(NERD_GLYPHS.speed));
		const wide = stripVTControlCharacters(
			renderLaneStrip(dominantSnapshot, 32, identityStyles, 0, "idle", speed, NERD_GLYPHS),
		);
		assert.ok(wide.includes(`${NERD_GLYPHS.speed} ~42.3t/s`));
		const ascii = stripVTControlCharacters(
			renderLaneStrip(dominantSnapshot, 28, identityStyles, 0, "idle", speed, ASCII_GLYPHS),
		);
		assert.ok(ascii.includes("~42.3t/s"));
		assert.ok(ascii.includes("(372K)"));
		assert.ok(!ascii.includes(NERD_GLYPHS.speed));
	});

	test("auto-fits lane with window width", () => {
		const narrow = stripVTControlCharacters(renderLaneStrip(dominantSnapshot, 30, identityStyles));
		const wide = stripVTControlCharacters(renderLaneStrip(dominantSnapshot, 200, identityStyles));
		assert.equal(visibleWidth(narrow), 30);
		assert.equal(visibleWidth(wide), 200);
		assert.ok(wide.split(PELLET_GLYPH).length > narrow.split(PELLET_GLYPH).length);
	});

	test("handles tiny widths", () => {
		assert.equal(renderLaneStrip(dominantSnapshot, 2, identityStyles), "");
		assert.equal(visibleWidth(stripVTControlCharacters(renderLaneStrip(dominantSnapshot, 12, identityStyles))), 12);
	});

	test("every strip fits widths 0..200 with and without speed", () => {
		for (const contextWindow of [0, 100_000]) {
			for (const speed of [null, { tokensPerSecond: 42.3, estimated: true }]) {
				for (let width = 0; width <= 200; width++) {
					const strip = renderLaneStrip({ usedTokens: 20_000, contextWindow }, width, identityStyles, 0, "idle", speed);
					assert.ok(visibleWidth(strip) <= width, `strip width=${width}, speed=${Boolean(speed)}`);
				}
			}
		}
	});
});

describe("CH session average", () => {
	test("joins the token-weighted average when it diverges by more than 5 points", () => {
		const ascii = metricOptions(usage({ cacheHitRate: 98, cacheHitRateAvg: 92 }), identityStyles, ASCII_GLYPHS);
		assert.equal(stripVTControlCharacters(ascii[0]?.decorated ?? ""), "CH98/92%");
		const nerd = metricOptions(usage({ cacheHitRate: 98, cacheHitRateAvg: 92 }), identityStyles, NERD_GLYPHS);
		assert.equal(stripVTControlCharacters(nerd[0]?.decorated ?? ""), `${NERD_GLYPHS.cache} 98/92%`);
	});

	test("stays latest-only when the average is close or unknown", () => {
		assert.equal(
			metricOptions(usage({ cacheHitRate: 98, cacheHitRateAvg: 96 }), identityStyles, ASCII_GLYPHS)[0]?.decorated,
			"CH98%",
		);
		assert.equal(
			metricOptions(usage({ cacheHitRate: 98, cacheHitRateAvg: 98.2 }), identityStyles, ASCII_GLYPHS)[0]?.decorated,
			"CH98%",
		);
		assert.equal(metricOptions(usage({ cacheHitRate: 98 }), identityStyles, ASCII_GLYPHS)[0]?.decorated, "CH98%");
	});

	test("drops the database icon before the average", () => {
		const [widest] = metricOptions(usage({ cacheHitRate: 98, cacheHitRateAvg: 92 }), identityStyles, NERD_GLYPHS);
		assert.equal(widest?.decorated, `${NERD_GLYPHS.cache} 98/92%`);
		assert.equal(widest?.plain, "98/92%");
		assert.equal(visibleWidth(widest?.plain ?? ""), visibleWidth("98/92%"));
	});

	test("keeps the latest-turn color on CH and styles the average dim", () => {
		const widest =
			metricOptions(usage({ cacheHitRate: 20, cacheHitRateAvg: 60 }), markedStyles, ASCII_GLYPHS)[0]?.decorated ?? "";
		assert.ok(widest.includes("<error>CH20</error>"));
		assert.ok(widest.includes("<dim>/60</dim>%"));
	});
});

describe("Nerd Font glyph grammar", () => {
	test("matches the official glyphnames.json code points and stays single-cell", () => {
		assert.equal(PACMAN_GLYPH, "\u{f0baf}");
		assert.equal(PACMAN_CLOSED_GLYPH, "\u{f0765}");
		assert.equal(NERD_GLYPHS.cache, "\u{f01bc}");
		assert.equal(NERD_GLYPHS.speed, "\u{f04c5}");
		assert.equal(NERD_GLYPHS.reset, "\u{f099b}");
		assert.equal(NERD_GLYPHS.credit, "\u{f0516}");
		assert.equal(NERD_GLYPHS.cache.codePointAt(0), 0xf01bc);
		assert.equal(NERD_GLYPHS.speed.codePointAt(0), 0xf04c5);
		assert.equal(NERD_GLYPHS.reset.codePointAt(0), 0xf099b);
		assert.equal(NERD_GLYPHS.credit.codePointAt(0), 0xf0516);
		for (const glyph of [
			PACMAN_GLYPH,
			PACMAN_CLOSED_GLYPH,
			NERD_GLYPHS.cache,
			NERD_GLYPHS.speed,
			NERD_GLYPHS.reset,
			NERD_GLYPHS.credit,
		])
			assert.equal(visibleWidth(glyph), 1);
		assert.equal(ASCII_GLYPHS.cache, "");
		assert.equal(ASCII_GLYPHS.speed, "");
		assert.equal(ASCII_GLYPHS.reset, "r");
		assert.equal(ASCII_GLYPHS.credit, "R");
		assert.equal(NERD_GLYPHS.pellet, PELLET_GLYPH);
		assert.equal(NERD_GLYPHS.powerPellet, POWER_PELLET_GLYPH);
		assert.equal(ASCII_GLYPHS.pellet, ".");
		assert.equal(ASCII_GLYPHS.powerPellet, "o");
		assert.equal(visibleWidth(NERD_GLYPHS.pellet), 1);
		assert.equal(visibleWidth(ASCII_GLYPHS.pellet), 1);
		assert.equal(visibleWidth(ASCII_GLYPHS.powerPellet), 1);
	});
});

describe("quota rendering", () => {
	const now = Date.parse("2026-07-01T00:00:00Z");
	const reset = (label: string, percent: number, minutes = 150): QuotaLimit => ({
		label,
		percent,
		resetAt: now + minutes * 60_000,
	});
	const full: QuotaUsage = {
		limits: [
			{ label: "5h", percent: 30 },
			{ label: "1d", percent: 12 },
		],
	};
	const plain = (values: readonly string[]): readonly string[] => values.map(stripVTControlCharacters);

	test("healthy windows are percentage-only essentials with no upgrades", () => {
		const render = quotaRender({ limits: [reset("5h", 53), reset("7d", 43)] }, identityStyles, now);
		assert.deepEqual(plain(render.essentials), ["5h 53%  7d 43%", ""]);
		assert.deepEqual(render.upgrades, []);
	});

	test("only a window above the warning threshold upgrades to its countdown", () => {
		const render = quotaRender({ limits: [reset("5h", 75), reset("7d", 43)] }, identityStyles, now);
		assert.deepEqual(plain(render.essentials), ["5h 75%  7d 43%", ""]);
		assert.deepEqual(plain(render.upgrades), ["5h 75% 󰦛 2h 30m  7d 43%"]);
	});

	test("treats exactly 70 as quiet and 70.01/90 as high", () => {
		for (const [percent, upgraded] of [
			[70, false],
			[70.01, true],
			[90, true],
		] as const) {
			const render = quotaRender({ limits: [reset("5h", percent)] }, identityStyles, now);
			assert.equal(render.upgrades.length > 0, upgraded, String(percent));
		}
	});

	test("counts every reported window toward the high check", () => {
		const high = quotaRender({ limits: [reset("5h", 10), reset("7d", 71)], resetCredits: 2 }, identityStyles, now);
		assert.equal(stripVTControlCharacters(high.essentials[0] ?? ""), "5h 10%  7d 71%");
		// Only the second window is high, so the banked credits stay visible from that alone.
		assert.ok(high.upgrades.some((value) => value.includes("󰔖")));
		// No window above the threshold keeps the same credits hidden.
		const quiet = quotaRender({ limits: [reset("5h", 10)], resetCredits: 2 }, identityStyles, now);
		assert.deepEqual(quiet.upgrades, []);
	});

	test("hides the countdown for missing or expired resets", () => {
		const missing = quotaRender({ limits: [{ label: "5h", percent: 80 }] }, identityStyles, now);
		assert.equal(stripVTControlCharacters(missing.essentials[0] ?? ""), "5h 80%");
		assert.deepEqual(missing.upgrades, []);
		const expired = quotaRender({ limits: [{ label: "5h", percent: 80, resetAt: now - 1000 }] }, identityStyles, now);
		assert.equal(stripVTControlCharacters(expired.essentials[0] ?? ""), "5h 80%");
		assert.deepEqual(expired.upgrades, []);
	});

	test("shows credits only while a reported quota is above the warning threshold", () => {
		const high = quotaRender({ limits: [reset("5h", 75)], resetCredits: 3 }, identityStyles, now);
		assert.deepEqual(plain(high.upgrades), ["5h 75% 󰦛 2h 30m  󰔖 3", "5h 75% 󰦛 2h 30m", "5h 75%  󰔖 3"]);
		const healthy = quotaRender({ ...full, resetCredits: 3 }, identityStyles, now);
		assert.deepEqual(plain(healthy.essentials), ["5h 30%  1d 12%", ""]);
		assert.deepEqual(healthy.upgrades, []);
		const zero = quotaRender({ limits: [reset("5h", 75)], resetCredits: 0 }, identityStyles, now);
		assert.ok(zero.upgrades.every((value) => !value.includes("󰔖")));
		const unknown = quotaRender({ limits: [reset("5h", 75)] }, identityStyles, now);
		assert.ok(unknown.upgrades.every((value) => !value.includes("󰔖")));
	});

	test("keeps window percentages essential while countdowns and credits upgrade", () => {
		const render = quotaRender({ limits: [reset("5h", 92), reset("7d", 43)], resetCredits: 1 }, identityStyles, now);
		assert.ok(render.essentials.every((value) => !value.includes("󰦛") && !value.includes("󰔖")));
		assert.ok(render.essentials[0]?.includes("5h 92%") && render.essentials[0]?.includes("7d 43%"));
		assert.ok(render.upgrades[0]?.includes("󰦛") && render.upgrades[0]?.includes("󰔖"));
	});

	test("uses ASCII tokens without spacing and Nerd glyphs with spacing", () => {
		const usage: QuotaUsage = { limits: [reset("5h", 75)], resetCredits: 2 };
		const ascii = quotaRender(usage, identityStyles, now, ASCII_GLYPHS);
		assert.equal(stripVTControlCharacters(ascii.upgrades[0] ?? ""), "5h 75% r2h 30m  R2");
		const nerd = quotaRender(usage, identityStyles, now, NERD_GLYPHS);
		assert.equal(stripVTControlCharacters(nerd.upgrades[0] ?? ""), "5h 75% 󰦛 2h 30m  󰔖 2");
		assert.ok(!readFileSync(new URL("./chrome.ts", import.meta.url), "utf8").includes("↻"));
	});

	test("offers the combined essential and an empty fallback for a quiet session", () => {
		const render = quotaRender(full, identityStyles);
		assert.deepEqual(plain(render.essentials), ["5h 30%  1d 12%", ""]);
		assert.deepEqual(render.upgrades, []);
	});

	test("escalates color with usage level", () => {
		const render = quotaRender(
			{
				limits: [
					{ label: "5h", percent: 95 },
					{ label: "7d", percent: 80 },
				],
			},
			markedStyles,
		);
		assert.equal(render.essentials[0], "<error>5h 95%</error><dim>  </dim><warning>7d 80%</warning>");
	});

	test("keeps quiet quota dim", () => {
		assert.equal(quotaRender(full, markedStyles).essentials[0], "<dim>5h 30%</dim><dim>  </dim><dim>1d 12%</dim>");
	});

	test("keeps quota lane dollar-free: limit percent renders, balance data never shown", () => {
		const render = quotaRender({ limits: [{ label: "7d", percent: 32.5 }] }, identityStyles);
		assert.deepEqual(plain(render.essentials), ["7d 33%", ""]);
	});
});

describe("chrome color sources", () => {
	// Omarchy's palette lives in the active pi theme file, so the extension must never carry its own
	// colors: every value comes from a theme token, and no surface fills a background.
	const ESC = String.fromCharCode(0x1b);
	const chromeSources = (): readonly string[] => {
		const root = new URL("../", import.meta.url);
		const sources = ["index.ts"];
		for (const dir of ["lib", "ui"]) {
			for (const name of readdirSync(new URL(`${dir}/`, root))) {
				if (name.endsWith(".ts") && !name.endsWith(".test.ts")) sources.push(`${dir}/${name}`);
			}
		}
		return sources;
	};

	test("uses theme tokens only, with no hex colors and no raw ANSI escapes", () => {
		const root = new URL("../", import.meta.url);
		const sources = chromeSources();
		assert.ok(sources.length >= 10);
		for (const source of sources) {
			const text = readFileSync(new URL(source, root), "utf8");
			assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(text), `${source} hardcodes a hex color`);
			assert.ok(!text.includes(ESC), `${source} embeds a raw escape character`);
			assert.ok(!/\\x1b|\\033|\\u001b/.test(text), `${source} embeds a raw escape literal`);
		}
	});
});
