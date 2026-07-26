import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	type ChromeStyles,
	formatCost,
	freeMetricOptions,
	GHOST_GLYPH,
	LANE_ACTIVITY_TEXT,
	PACMAN_FRAMES,
	PACMAN_GLYPH,
	PACMAN_LANE_MAX_WIDTH,
	PELLET_GLYPH,
	pickFirstFitting,
	renderChromeLine,
	renderPacmanLane,
	styleFreeMetrics,
} from "./chrome.ts";
import type { ContextSnapshot, SessionUsage } from "./context.ts";
import type { TokenSpeedSnapshot } from "./speed.ts";
import { foreground, plainWidth, stripAnsi } from "./text.ts";

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
		const options = freeMetricOptions(dominantSnapshot, full);
		assert.equal(options[0], "15.6%   CH98%  $1.61");
		assert.equal(pickFirstFitting(options, 200), options[0]);
		assert.ok(plainWidth(pickFirstFitting(options, 15)) <= 15);
		assert.equal(pickFirstFitting(options, -1), "");
	});

	test("supports missing CH", () => {
		const options = freeMetricOptions(dominantSnapshot, usage({ cost: 0.042 }));
		assert.ok(options[0]?.startsWith("15.6%"));
		assert.equal(
			options.every((option) => !option.includes("CH")),
			true,
		);
	});

	test("adds quiet token speed without changing existing options", () => {
		const speed: TokenSpeedSnapshot = { tokensPerSecond: 42.25, estimated: true };
		const options = freeMetricOptions(dominantSnapshot, full, speed);
		assert.equal(options[0], "15.6%   CH98%  ~42.3t/s  $1.61");
		assert.ok(options.includes("CH98%  ~42.3t/s"));
	});
});

describe("semantic metric styling", () => {
	test("keeps healthy values quiet", () => {
		const styled = styleFreeMetrics("51.3%   CH99%  $6.65", 51.3, 99, markedStyles);
		assert.ok(styled.includes("<d>51.3%</d>"));
		assert.ok(styled.includes("<d>CH99%</d>"));
		assert.ok(!styled.includes("<w>"));
		assert.ok(!styled.includes("<e>"));
	});

	test("accents only unhealthy usage and cache", () => {
		assert.ok(styleFreeMetrics("75.0%   CH60%", 75, 60, markedStyles).includes("<w>75.0%</w>"));
		assert.ok(styleFreeMetrics("95.0%   CH20%", 95, 20, markedStyles).includes("<e>CH20%</e>"));
		assert.equal(styleFreeMetrics("", 10, undefined, markedStyles), "");
	});
});

describe("Pac-Man lane", () => {
	test("moves left to right while eaten pellets become empty space", () => {
		const empty = stripAnsi(renderPacmanLane(snapshot({ usedTokens: 0, contextWindow: 100 }), 18));
		const half = stripAnsi(renderPacmanLane(snapshot({ usedTokens: 50, contextWindow: 100 }), 18));
		const full = stripAnsi(renderPacmanLane(snapshot({ usedTokens: 100, contextWindow: 100 }), 18));
		assert.equal(plainWidth(empty), 18);
		assert.equal(plainWidth(half), 18);
		assert.equal(plainWidth(full), 18);
		assert.equal(empty.split(PELLET_GLYPH).length - 1, 8);
		assert.equal(half.split(PELLET_GLYPH).length - 1, 4);
		assert.equal(half.indexOf(PACMAN_GLYPH), 8);
		assert.equal(full.includes(PELLET_GLYPH), false);
	});

	test("animates mouth without resurrecting pellets", () => {
		const open = stripAnsi(renderPacmanLane(snapshot(), 10, 0));
		const closed = stripAnsi(renderPacmanLane(snapshot(), 10, 1));
		assert.ok(open.includes(PACMAN_FRAMES[0]));
		assert.ok(closed.includes(PACMAN_FRAMES[1]));
		assert.equal(open.split(PELLET_GLYPH).length - 1, 4);
		assert.equal(closed.split(PELLET_GLYPH).length - 1, 4);
	});

	test("shows phase ghost only while active", () => {
		const active = snapshot({ usedTokens: 100, contextWindow: 100 });
		assert.equal(stripAnsi(renderPacmanLane(active, 18)).includes(GHOST_GLYPH), false);
		for (const [activity, color] of Object.entries(LANE_ACTIVITY_TEXT)) {
			const lane = renderPacmanLane(active, 18, 0, activity as keyof typeof LANE_ACTIVITY_TEXT);
			assert.ok(lane.includes(foreground(color, `${GHOST_GLYPH} `)));
		}
	});

	test("moves ghost chase distance and handles tiny lanes", () => {
		const active = snapshot({ usedTokens: 100, contextWindow: 100 });
		const close = stripAnsi(renderPacmanLane(active, 18, 0, "working"));
		const far = stripAnsi(renderPacmanLane(active, 18, 2, "working"));
		assert.ok(close.indexOf(GHOST_GLYPH) > far.indexOf(GHOST_GLYPH));
		assert.equal(renderPacmanLane(snapshot(), 0), "");
		assert.equal(stripAnsi(renderPacmanLane(snapshot(), 1)), PACMAN_GLYPH);
		assert.equal(
			stripAnsi(renderPacmanLane(snapshot({ usedTokens: 25, contextWindow: 100 }), 10, 0, "tools")).includes(
				GHOST_GLYPH,
			),
			false,
		);
	});

	test("clamps unknown, negative, and overfull usage", () => {
		const unknown = stripAnsi(renderPacmanLane(snapshot({ contextWindow: 0 }), 10));
		assert.equal(unknown.startsWith(PACMAN_GLYPH), true);
		const negative = stripAnsi(renderPacmanLane(snapshot({ usedTokens: -10, contextWindow: 100 }), 10));
		assert.equal(negative.startsWith(PACMAN_GLYPH), true);
		const overfull = stripAnsi(renderPacmanLane(snapshot({ usedTokens: 200, contextWindow: 100 }), 10));
		assert.equal(overfull.trimEnd().endsWith(PACMAN_GLYPH), true);
	});
});

describe("health row layout", () => {
	test("right-aligns fallback inside one-column padding", () => {
		assert.equal(renderChromeLine(snapshot(), usage(), 0, identityStyles), "");
		assert.equal(renderChromeLine(snapshot(), usage(), 1, identityStyles), "·");
		const line = renderChromeLine(snapshot({ contextWindow: 0 }), usage(), 40, identityStyles);
		assert.equal(plainWidth(line), 40);
		assert.ok(line.includes("ctx unavailable"));
		assert.ok(line.startsWith(" ") && line.endsWith(" "));
	});

	test("keeps lane left and readable metrics right", () => {
		const line = stripAnsi(
			renderChromeLine(
				dominantSnapshot,
				usage({ cacheHitRate: 97.9, cost: 1.61 }),
				100,
				identityStyles,
				0,
				"assistant",
			),
		);
		assert.equal(plainWidth(line), 100);
		assert.ok(line.includes("15.6%   CH98%  $1.61"));
		assert.ok(line.includes(PACMAN_GLYPH));
		assert.ok(line.includes(GHOST_GLYPH));
		assert.ok(line.endsWith("$1.61 "));
	});

	test("caps lane on ultra-wide terminals", () => {
		const line = stripAnsi(renderChromeLine(snapshot(), usage({ cacheHitRate: 90 }), 240, identityStyles));
		assert.equal(plainWidth(line), 240);
		assert.equal(line.split(PELLET_GLYPH).length - 1, PACMAN_LANE_MAX_WIDTH / 2 - 1);
		assert.ok(line.indexOf("0.0%") > PACMAN_LANE_MAX_WIDTH);
		assert.ok(line.endsWith("CH90% "));
	});
});
