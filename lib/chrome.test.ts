import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	BREATH_STEPS,
	breathingBorderColor,
	type ChromeStyles,
	foreground,
	formatCost,
	formatWindowSize,
	freeMetricOptions,
	GHOST_GLYPH,
	LANE_ACTIVITY_TEXT,
	PACMAN_FRAMES,
	PACMAN_GLYPH,
	PELLET_GLYPH,
	POWER_PELLET_GLYPH,
	POWER_PELLET_RATIOS,
	type QuotaUsage,
	quotaMetricOptions,
	renderLaneStrip,
	renderPacmanLane,
} from "./chrome.ts";
import type { ContextSnapshot, SessionUsage } from "./context.ts";

const usage = (partial: Partial<SessionUsage> = {}): SessionUsage => ({
	cost: 0,
	cacheHitRate: undefined,
	...partial,
});

const snapshot = (partial: Partial<ContextSnapshot> = {}): ContextSnapshot => ({
	usedTokens: 0,
	contextWindow: 200_000,
	...partial,
});

const identityStyles: ChromeStyles = {
	dim: (text) => text,
	warning: (text) => text,
	error: (text) => text,
};

const markedStyles: ChromeStyles = {
	dim: (text) => `<d>${text}</d>`,
	warning: (text) => `<w>${text}</w>`,
	error: (text) => `<e>${text}</e>`,
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
	});

	test("builds wide and narrow options", () => {
		const options = freeMetricOptions(full, identityStyles);
		assert.equal(options[0], "CH98%  $1.61");
		assert.equal(
			options.find((value) => visibleWidth(value) <= 200),
			options[0],
		);
		assert.equal(
			options.find((value) => visibleWidth(value) <= 6),
			"CH98%",
		);
		assert.equal(
			options.find((value) => visibleWidth(value) <= -1),
			undefined,
		);
	});

	test("supports missing CH", () => {
		const options = freeMetricOptions(usage({ cost: 0.042 }), identityStyles);
		assert.ok(options[0]?.startsWith("$"));
		assert.equal(
			options.every((option) => !option.includes("CH")),
			true,
		);
	});
});

describe("semantic metric styling", () => {
	test("keeps healthy cache quiet", () => {
		const widest = freeMetricOptions(usage({ cost: 6.65, cacheHitRate: 99 }), markedStyles)[0] ?? "";
		assert.ok(widest.includes("<d>CH99%</d>"));
		assert.ok(!widest.includes("<w>"));
		assert.ok(!widest.includes("<e>"));
	});

	test("accents only unhealthy cache", () => {
		const warning = freeMetricOptions(usage({ cacheHitRate: 60 }), markedStyles)[0] ?? "";
		assert.ok(warning.includes("<w>CH60%</w>"));
		const error = freeMetricOptions(usage({ cacheHitRate: 20 }), markedStyles)[0] ?? "";
		assert.ok(error.includes("<e>CH20%</e>"));
		assert.equal(freeMetricOptions(usage(), markedStyles)[0], "");
	});
});

describe("Pac-Man lane", () => {
	test("moves left to right while eaten pellets become empty space", () => {
		const empty = stripVTControlCharacters(renderPacmanLane(snapshot({ usedTokens: 0, contextWindow: 100 }), 18));
		const half = stripVTControlCharacters(renderPacmanLane(snapshot({ usedTokens: 50, contextWindow: 100 }), 18));
		const full = stripVTControlCharacters(renderPacmanLane(snapshot({ usedTokens: 100, contextWindow: 100 }), 18));
		assert.equal(visibleWidth(empty), 18);
		assert.equal(visibleWidth(half), 18);
		assert.equal(visibleWidth(full), 18);
		assert.equal(empty.split(PELLET_GLYPH).length - 1, 6);
		assert.equal(empty.split(POWER_PELLET_GLYPH).length - 1, 2);
		assert.equal(half.split(PELLET_GLYPH).length - 1, 2);
		assert.equal(half.indexOf(PACMAN_GLYPH), 8);
		assert.equal(full.includes(PELLET_GLYPH), false);
	});

	test("animates mouth without resurrecting pellets", () => {
		const open = stripVTControlCharacters(renderPacmanLane(snapshot(), 10, 0, "working"));
		const closed = stripVTControlCharacters(renderPacmanLane(snapshot(), 10, 1, "working"));
		assert.ok(open.includes(PACMAN_FRAMES[0]));
		assert.ok(closed.includes(PACMAN_FRAMES[1]));
		assert.equal(open.split(PELLET_GLYPH).length - 1, 2);
		assert.equal(closed.split(PELLET_GLYPH).length - 1, 2);
	});

	test("pins open-mouth Pac-Man while idle", () => {
		assert.ok(stripVTControlCharacters(renderPacmanLane(snapshot(), 10, 1)).includes(PACMAN_GLYPH));
		assert.ok(!stripVTControlCharacters(renderPacmanLane(snapshot(), 10, 1)).includes(PACMAN_FRAMES[1]));
	});

	test("shows phase ghost only while active", () => {
		const active = snapshot({ usedTokens: 100, contextWindow: 100 });
		assert.equal(stripVTControlCharacters(renderPacmanLane(active, 18)).includes(GHOST_GLYPH), false);
		for (const [activity, color] of Object.entries(LANE_ACTIVITY_TEXT)) {
			const lane = renderPacmanLane(active, 18, 0, activity as keyof typeof LANE_ACTIVITY_TEXT);
			assert.ok(lane.includes(foreground(color, `${GHOST_GLYPH} `)));
		}
	});

	test("marks warning thresholds with power pellets that get eaten", () => {
		const hungry = stripVTControlCharacters(renderPacmanLane(snapshot({ usedTokens: 0, contextWindow: 100 }), 18));
		assert.equal(hungry.split(POWER_PELLET_GLYPH).length - 1, POWER_PELLET_RATIOS.length);
		const pastWarning = stripVTControlCharacters(
			renderPacmanLane(snapshot({ usedTokens: 80, contextWindow: 100 }), 18),
		);
		assert.equal(pastWarning.split(POWER_PELLET_GLYPH).length - 1, 1);
		const pastError = stripVTControlCharacters(renderPacmanLane(snapshot({ usedTokens: 95, contextWindow: 100 }), 18));
		assert.equal(pastError.includes(POWER_PELLET_GLYPH), false);
		assert.equal(pastError.includes(PELLET_GLYPH), false);
	});

	test("moves ghost chase distance and handles tiny lanes", () => {
		const active = snapshot({ usedTokens: 100, contextWindow: 100 });
		const close = stripVTControlCharacters(renderPacmanLane(active, 18, 0, "working"));
		const far = stripVTControlCharacters(renderPacmanLane(active, 18, 2, "working"));
		assert.ok(close.indexOf(GHOST_GLYPH) > far.indexOf(GHOST_GLYPH));
		assert.equal(renderPacmanLane(snapshot(), 0), "");
		assert.equal(stripVTControlCharacters(renderPacmanLane(snapshot(), 1)), PACMAN_GLYPH);
		assert.equal(
			stripVTControlCharacters(
				renderPacmanLane(snapshot({ usedTokens: 25, contextWindow: 100 }), 10, 0, "tools"),
			).includes(GHOST_GLYPH),
			false,
		);
	});

	test("clamps unknown, negative, and overfull usage", () => {
		const unknown = stripVTControlCharacters(renderPacmanLane(snapshot({ contextWindow: 0 }), 10));
		assert.equal(unknown.startsWith(PACMAN_GLYPH), true);
		const negative = stripVTControlCharacters(renderPacmanLane(snapshot({ usedTokens: -10, contextWindow: 100 }), 10));
		assert.equal(negative.startsWith(PACMAN_GLYPH), true);
		const overfull = stripVTControlCharacters(renderPacmanLane(snapshot({ usedTokens: 200, contextWindow: 100 }), 10));
		assert.equal(overfull.trimEnd().endsWith(PACMAN_GLYPH), true);
	});
});

describe("lane strip", () => {
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

	test("accents unhealthy usage percent", () => {
		assert.ok(renderLaneStrip(snapshot({ usedTokens: 150_000 }), 30, markedStyles).includes("<w>75.0% (200K)</w>"));
		assert.ok(renderLaneStrip(snapshot({ usedTokens: 190_000 }), 30, markedStyles).includes("<e>95.0% (200K)</e>"));
	});

	test("formats window sizes compactly", () => {
		assert.equal(formatWindowSize(200_000), "200K");
		assert.equal(formatWindowSize(372_000), "372K");
		assert.equal(formatWindowSize(512), "512");
		assert.equal(formatWindowSize(0), "0");
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
});

describe("breathing border", () => {
	const grayOf = (frame: number): number => Number(/38;5;(\d+)m/.exec(breathingBorderColor(frame)("─"))?.[1]);

	test("wraps text in a grayscale foreground and resets", () => {
		const styled = breathingBorderColor(0)("─");
		assert.ok(styled.startsWith("\x1b[38;5;"));
		assert.ok(styled.endsWith("─\x1b[39m"));
	});

	test("bottoms out at frame zero and peaks mid-cycle", () => {
		assert.equal(grayOf(0), 239);
		assert.equal(grayOf(BREATH_STEPS / 2), 247);
		assert.equal(grayOf(BREATH_STEPS), 239);
	});

	test("moves monotonically through the inhale half", () => {
		for (let frame = 1; frame <= BREATH_STEPS / 2; frame += 1) {
			assert.ok(grayOf(frame) >= grayOf(frame - 1));
		}
	});
});

describe("quota metric options", () => {
	const full: QuotaUsage = {
		weeklyPercent: 40,
		limits: [
			{ label: "5h", percent: 30 },
			{ label: "1d", percent: 12 },
		],
	};

	test("offers widest to tightest variants", () => {
		const options = quotaMetricOptions(full, identityStyles).map(stripVTControlCharacters);
		assert.deepEqual(options, ["W40% 5h30% 1d12%", "W40%", ""]);
	});

	test("skips the combined variant when weekly is unknown", () => {
		const options = quotaMetricOptions({ weeklyPercent: undefined, limits: full.limits }, identityStyles);
		assert.equal(stripVTControlCharacters(options[0] ?? ""), "5h30% 1d12%");
		assert.equal(options[1], "");
	});

	test("escalates color with usage level", () => {
		const options = quotaMetricOptions({ weeklyPercent: 95, limits: [{ label: "5h", percent: 80 }] }, markedStyles);
		assert.equal(options[0], "<e>W95%</e><d> </d><w>5h80%</w>");
	});

	test("keeps quiet quota dim", () => {
		assert.equal(quotaMetricOptions(full, markedStyles)[1], "<d>W40%</d>");
	});

	test("appends banked reset credits and uses them as the tight fallback", () => {
		const usageWithResets: QuotaUsage = { ...full, weeklyPercent: undefined, resetCredits: 3 };
		const options = quotaMetricOptions(usageWithResets, identityStyles).map(stripVTControlCharacters);
		assert.deepEqual(options, ["5h30% 1d12% R3", "R3", ""]);
	});

	test("hides zero reset credits", () => {
		const options = quotaMetricOptions({ ...full, resetCredits: 0 }, identityStyles).map(stripVTControlCharacters);
		assert.deepEqual(options, ["W40% 5h30% 1d12%", "W40%", ""]);
	});

	test("keeps quota lane dollar-free: limit percent renders, balance data never shown", () => {
		const options = quotaMetricOptions(
			{ weeklyPercent: undefined, limits: [{ label: "7d", percent: 32.5 }] },
			identityStyles,
		).map(stripVTControlCharacters);
		assert.deepEqual(options, ["7d33%", "", ""]);
	});
});
