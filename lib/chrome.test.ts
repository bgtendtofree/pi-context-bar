import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	type ChromeStyles,
	foreground,
	formatCost,
	freeMetricOptions,
	GHOST_GLYPH,
	LANE_ACTIVITY_TEXT,
	PACMAN_FRAMES,
	PACMAN_GLYPH,
	PELLET_GLYPH,
	POWER_PELLET_GLYPH,
	POWER_PELLET_RATIOS,
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
		const open = stripVTControlCharacters(renderPacmanLane(snapshot(), 10, 0));
		const closed = stripVTControlCharacters(renderPacmanLane(snapshot(), 10, 1));
		assert.ok(open.includes(PACMAN_FRAMES[0]));
		assert.ok(closed.includes(PACMAN_FRAMES[1]));
		assert.equal(open.split(PELLET_GLYPH).length - 1, 2);
		assert.equal(closed.split(PELLET_GLYPH).length - 1, 2);
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

	test("accents unhealthy usage percent", () => {
		assert.ok(renderLaneStrip(snapshot({ usedTokens: 150_000 }), 30, markedStyles).includes("<w>75.0%</w>"));
		assert.ok(renderLaneStrip(snapshot({ usedTokens: 190_000 }), 30, markedStyles).includes("<e>95.0%</e>"));
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
