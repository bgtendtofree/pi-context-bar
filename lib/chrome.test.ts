import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	ASCII_GLYPHS,
	type ChromeStyles,
	formatCost,
	formatDuration,
	formatWindowSize,
	freeMetricOptions,
	GHOST_GLYPH,
	GHOST_TOKENS,
	NERD_GLYPHS,
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
	});

	test("builds wide and narrow options", () => {
		const nerd = freeMetricOptions(full, identityStyles, NERD_GLYPHS);
		assert.equal(nerd[0], `${NERD_GLYPHS.cache} 98%  $1.61`);
		assert.equal(
			nerd.find((value) => visibleWidth(value) <= 200),
			nerd[0],
		);
		assert.equal(
			nerd.find((value) => visibleWidth(value) <= 6),
			`${NERD_GLYPHS.cache} 98%`,
		);
		const ascii = freeMetricOptions(full, identityStyles, ASCII_GLYPHS);
		assert.equal(ascii[0], "CH98%  $1.61");
		assert.equal(
			ascii.find((value) => visibleWidth(value) <= 6),
			"CH98%",
		);
		assert.equal(
			ascii.find((value) => visibleWidth(value) <= -1),
			undefined,
		);
	});

	test("keeps cost when cache is unknown", () => {
		for (const glyphs of [NERD_GLYPHS, ASCII_GLYPHS]) {
			const options = freeMetricOptions(usage({ cost: 0.042 }), identityStyles, glyphs);
			assert.equal(options[0], "$0.042");
			assert.equal(
				options.every((option) => !option.includes("CH") && !option.includes(NERD_GLYPHS.cache)),
				true,
			);
		}
	});
});

describe("semantic metric styling", () => {
	test("keeps healthy cache quiet", () => {
		const nerd = freeMetricOptions(usage({ cost: 6.65, cacheHitRate: 99 }), markedStyles, NERD_GLYPHS)[0] ?? "";
		assert.ok(nerd.includes(`<dim>${NERD_GLYPHS.cache} 99</dim>%`));
		assert.ok(!nerd.includes("<warning>"));
		assert.ok(!nerd.includes("<error>"));
		const ascii = freeMetricOptions(usage({ cost: 6.65, cacheHitRate: 99 }), markedStyles, ASCII_GLYPHS)[0] ?? "";
		assert.ok(ascii.includes("<dim>CH99</dim>%"));
	});

	test("accents only unhealthy cache", () => {
		const warning = freeMetricOptions(usage({ cacheHitRate: 60 }), markedStyles, ASCII_GLYPHS)[0] ?? "";
		assert.ok(warning.includes("<warning>CH60</warning>%"));
		const error = freeMetricOptions(usage({ cacheHitRate: 20 }), markedStyles, ASCII_GLYPHS)[0] ?? "";
		assert.ok(error.includes("<error>CH20</error>%"));
		assert.equal(freeMetricOptions(usage(), markedStyles, ASCII_GLYPHS)[0], "");
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
	});

	test("clamps unknown, negative, and overfull usage", () => {
		const unknown = stripVTControlCharacters(renderPacmanLane(snapshot({ contextWindow: 0 }), 10, identityStyles));
		assert.equal(unknown.startsWith(PACMAN_GLYPH), true);
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
		const ascii = freeMetricOptions(usage({ cacheHitRate: 98, cacheHitRateAvg: 92 }), identityStyles, ASCII_GLYPHS);
		assert.equal(stripVTControlCharacters(ascii[0] ?? ""), "CH98/92%");
		const nerd = freeMetricOptions(usage({ cacheHitRate: 98, cacheHitRateAvg: 92 }), identityStyles, NERD_GLYPHS);
		assert.equal(stripVTControlCharacters(nerd[0] ?? ""), `${NERD_GLYPHS.cache} 98/92%`);
	});

	test("stays latest-only when the average is close or unknown", () => {
		assert.equal(
			freeMetricOptions(usage({ cacheHitRate: 98, cacheHitRateAvg: 96 }), identityStyles, ASCII_GLYPHS)[0],
			"CH98%",
		);
		assert.equal(
			freeMetricOptions(usage({ cacheHitRate: 98, cacheHitRateAvg: 98.2 }), identityStyles, ASCII_GLYPHS)[0],
			"CH98%",
		);
		assert.equal(freeMetricOptions(usage({ cacheHitRate: 98 }), identityStyles, ASCII_GLYPHS)[0], "CH98%");
	});

	test("drops the database icon before the average", () => {
		const options = freeMetricOptions(usage({ cacheHitRate: 98, cacheHitRateAvg: 92 }), identityStyles, NERD_GLYPHS);
		const plain = options.find((value) => !value.includes(NERD_GLYPHS.cache));
		assert.equal(plain, "98/92%");
		assert.equal(visibleWidth(plain ?? ""), visibleWidth("98/92%"));
	});

	test("keeps the latest-turn color on CH and styles the average dim", () => {
		const widest =
			freeMetricOptions(usage({ cacheHitRate: 20, cacheHitRateAvg: 60 }), markedStyles, ASCII_GLYPHS)[0] ?? "";
		assert.ok(widest.includes("<error>CH20</error>"));
		assert.ok(widest.includes("<dim>/60</dim>%"));
	});
});

describe("Nerd Font glyph grammar", () => {
	test("matches the official glyphnames.json code points and stays single-cell", () => {
		assert.equal(NERD_GLYPHS.providerOpenai, "\uec81");
		assert.equal(NERD_GLYPHS.providerAnthropic, "\uec82");
		assert.equal(NERD_GLYPHS.thinking, "\u{f09d1}");
		assert.equal(NERD_GLYPHS.cache, "\u{f01bc}");
		assert.equal(NERD_GLYPHS.speed, "\u{f04c5}");
		assert.equal(NERD_GLYPHS.providerOpenai.codePointAt(0), 0xec81);
		assert.equal(NERD_GLYPHS.providerAnthropic.codePointAt(0), 0xec82);
		assert.equal(NERD_GLYPHS.thinking.codePointAt(0), 0xf09d1);
		assert.equal(NERD_GLYPHS.cache.codePointAt(0), 0xf01bc);
		assert.equal(NERD_GLYPHS.speed.codePointAt(0), 0xf04c5);
		for (const glyph of [
			NERD_GLYPHS.providerOpenai,
			NERD_GLYPHS.providerAnthropic,
			NERD_GLYPHS.thinking,
			NERD_GLYPHS.cache,
			NERD_GLYPHS.speed,
		])
			assert.equal(visibleWidth(glyph), 1);
		assert.equal(ASCII_GLYPHS.providerOpenai, "");
		assert.equal(ASCII_GLYPHS.providerAnthropic, "");
		assert.equal(ASCII_GLYPHS.thinking, "");
		assert.equal(ASCII_GLYPHS.cache, "");
		assert.equal(ASCII_GLYPHS.speed, "");
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
		assert.deepEqual(options, ["W40%  5h 30%  1d 12%", "W40%", ""]);
	});

	test("skips the combined variant when weekly is unknown", () => {
		const options = quotaMetricOptions({ weeklyPercent: undefined, limits: full.limits }, identityStyles);
		assert.equal(stripVTControlCharacters(options[0] ?? ""), "5h 30%  1d 12%");
		assert.equal(options[1], "");
	});

	test("appends remaining time to each window when the provider reports a reset", () => {
		const now = Date.parse("2026-07-01T00:00:00Z");
		const usageWithReset: QuotaUsage = {
			weeklyPercent: undefined,
			limits: [
				{ label: "5h", percent: 30, resetAt: now + 150 * 60_000 },
				{ label: "7d", percent: 12, resetAt: now + 5 * 86_400_000 + 15 * 3_600_000 },
			],
		};
		const options = quotaMetricOptions(usageWithReset, identityStyles, now).map(stripVTControlCharacters);
		assert.deepEqual(options, ["5h 30% 󰦛 2h 30m  7d 12% 󰦛 5d 15h", "5h 30%  7d 12%", ""]);
	});

	test("uses the ASCII reset and credit tokens without spacing", () => {
		const now = Date.parse("2026-07-01T00:00:00Z");
		const usageWithReset: QuotaUsage = {
			weeklyPercent: 40,
			limits: [{ label: "5h", percent: 30, resetAt: now + 150 * 60_000 }],
			resetCredits: 3,
		};
		const options = quotaMetricOptions(usageWithReset, identityStyles, now, ASCII_GLYPHS).map(stripVTControlCharacters);
		assert.equal(options[0], "W40%  5h 30% r2h 30m  R3");
	});

	test("uses the md-restore and md-ticket glyphs, never the fallback arrow", () => {
		assert.equal(NERD_GLYPHS.reset.codePointAt(0), 0xf099b);
		assert.equal(NERD_GLYPHS.credit.codePointAt(0), 0xf0516);
		assert.equal(visibleWidth(NERD_GLYPHS.reset), 1);
		assert.equal(visibleWidth(NERD_GLYPHS.credit), 1);
		assert.equal(ASCII_GLYPHS.reset, "r");
		assert.equal(ASCII_GLYPHS.credit, "R");
		assert.ok(!readFileSync(new URL("./chrome.ts", import.meta.url), "utf8").includes("↻"));
		const now = Date.parse("2026-07-01T00:00:00Z");
		const output = quotaMetricOptions(
			{ weeklyPercent: 40, limits: [{ label: "5h", percent: 30, resetAt: now + 3_600_000 }], resetCredits: 2 },
			identityStyles,
			now,
		).join("");
		assert.ok(!output.includes("↻"));
		assert.ok(output.includes("󰦛") && output.includes("󰔖"));
	});

	test("drops a past window reset instead of showing zero", () => {
		const now = Date.parse("2026-07-01T00:00:00Z");
		const options = quotaMetricOptions(
			{ weeklyPercent: undefined, limits: [{ label: "5h", percent: 30, resetAt: now - 1000 }] },
			identityStyles,
			now,
		).map(stripVTControlCharacters);
		assert.deepEqual(options, ["5h 30%", ""]);
	});

	test("escalates color with usage level", () => {
		const options = quotaMetricOptions({ weeklyPercent: 95, limits: [{ label: "5h", percent: 80 }] }, markedStyles);
		assert.equal(options[0], "<error>W95%</error><dim>  </dim><warning>5h 80%</warning>");
	});

	test("keeps quiet quota dim", () => {
		assert.equal(quotaMetricOptions(full, markedStyles)[1], "<dim>W40%</dim>");
	});

	test("appends banked reset credits and uses them as the tight fallback", () => {
		const usageWithResets: QuotaUsage = { ...full, weeklyPercent: undefined, resetCredits: 3 };
		const options = quotaMetricOptions(usageWithResets, identityStyles).map(stripVTControlCharacters);
		assert.deepEqual(options, ["5h 30%  1d 12%  󰔖 3", "󰔖 3", ""]);
	});

	test("hides zero reset credits", () => {
		const options = quotaMetricOptions({ ...full, resetCredits: 0 }, identityStyles).map(stripVTControlCharacters);
		assert.deepEqual(options, ["W40%  5h 30%  1d 12%", "W40%", ""]);
	});

	test("keeps quota lane dollar-free: limit percent renders, balance data never shown", () => {
		const options = quotaMetricOptions(
			{ weeklyPercent: undefined, limits: [{ label: "7d", percent: 32.5 }] },
			identityStyles,
		).map(stripVTControlCharacters);
		assert.deepEqual(options, ["7d 33%", ""]);
	});
});
