import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	dominantSnapshot,
	fgOnlyStyles,
	identityStyles,
	markedStyles,
	recorder,
	snapshot,
} from "../test-support/chrome-fixtures.ts";
import {
	ASCII_GLYPHS,
	activityAfterContext,
	activityForAssistantEvent,
	formatWindowSize,
	GHOST_GLYPH,
	GHOST_TOKENS,
	NERD_GLYPHS,
	PACMAN_CLOSED_GLYPH,
	PACMAN_FRAMES,
	PACMAN_GLYPH,
	PELLET_GLYPH,
	POWER_PELLET_GLYPH,
	POWER_PELLET_RATIOS,
	renderLaneStrip,
	renderPacmanLane,
	USAGE_ERROR_PERCENT,
	USAGE_WARNING_PERCENT,
} from "./chrome.ts";
import { type HealthNotice, NOTICES } from "./timing.ts";

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

	test("keeps an overlong speed reading instead of dropping the whole field", () => {
		for (const glyphs of [NERD_GLYPHS, ASCII_GLYPHS]) {
			for (const tokensPerSecond of [1_000, 10_000]) {
				const strip = stripVTControlCharacters(
					renderLaneStrip(
						dominantSnapshot,
						100,
						identityStyles,
						0,
						"assistant",
						{ tokensPerSecond, estimated: true },
						glyphs,
					),
				);
				assert.equal(visibleWidth(strip), 100);
				assert.ok(strip.includes(`${tokensPerSecond.toFixed(1)}t/s`), strip);
				assert.ok(strip.includes("15.6%"), strip);
			}
		}
	});

	test("reserves one speed field so reading length cannot resize the lane", () => {
		// Common digit lengths, the `~` estimate marker, and provider calibration all fill the same
		// right-aligned field, so Pac-Man and the context percent keep their columns.
		const strips = [
			{ tokensPerSecond: 9.8, estimated: true },
			{ tokensPerSecond: 100, estimated: true },
			{ tokensPerSecond: 100, estimated: false },
			{ tokensPerSecond: 42.3, estimated: false },
		].map((speed) => stripVTControlCharacters(renderLaneStrip(dominantSnapshot, 60, identityStyles, 0, "idle", speed)));
		const baseline = strips[0] ?? "";
		for (const strip of strips) {
			assert.equal(visibleWidth(strip), 60);
			assert.equal(strip.indexOf("15.6%"), baseline.indexOf("15.6%"));
			assert.equal(strip.indexOf(PACMAN_GLYPH), baseline.indexOf(PACMAN_GLYPH));
			// The reading itself is right-aligned: its `t/s` ends at the same column in every strip.
			assert.equal(strip.indexOf("t/s"), baseline.indexOf("t/s"));
		}
		assert.ok(strips[0]?.includes(`${NERD_GLYPHS.speed} ~9.8t/s `));
		assert.ok(strips[0]?.includes("15.6% (372K)"));
	});

	test("reserves no speed field for an unknown or absent reading", () => {
		const idle = stripVTControlCharacters(renderLaneStrip(dominantSnapshot, 60, identityStyles));
		assert.ok(idle.endsWith("15.6% (372K) "), idle);
		assert.ok(!idle.includes("t/s"));
	});

	test("keeps one reserved speed slot from waiting through the first measurable reading", () => {
		const speed = { tokensPerSecond: 42.3, estimated: false };
		for (const glyphs of [NERD_GLYPHS, ASCII_GLYPHS]) {
			for (const width of [60, 40, 28, 24]) {
				const waiting = stripVTControlCharacters(
					renderLaneStrip(dominantSnapshot, width, identityStyles, 0, "working", null, glyphs, NOTICES.waiting),
				);
				const streaming = stripVTControlCharacters(
					renderLaneStrip(dominantSnapshot, width, identityStyles, 0, "assistant", null, glyphs),
				);
				const measured = stripVTControlCharacters(
					renderLaneStrip(dominantSnapshot, width, identityStyles, 0, "assistant", speed, glyphs),
				);
				for (const strip of [waiting, streaming, measured]) assert.equal(visibleWidth(strip), width);
				// The lane, percent, and slot columns stay put while the reading appears.
				assert.equal(streaming.indexOf("15.6%"), waiting.indexOf("15.6%"), `${glyphs.ascii} w=${width}`);
				assert.equal(measured.indexOf("15.6%"), waiting.indexOf("15.6%"), `${glyphs.ascii} w=${width}`);
				assert.equal(measured.indexOf(glyphs.pacmanOpen), waiting.indexOf(glyphs.pacmanOpen));
				assert.equal(streaming.length, waiting.length);
				assert.ok(streaming.includes("?t/s"), streaming);
				assert.ok(measured.includes("42.3t/s"), measured);
				assert.doesNotMatch(waiting.replace(glyphs.waiting, ""), /~?\d+\.\dt\/s/);
			}
		}
	});

	const ICON_FOR_NOTICE = {
		[NOTICES.waiting]: NERD_GLYPHS.waiting,
		[NOTICES.retrying]: NERD_GLYPHS.retrying,
		[NOTICES.compact]: NERD_GLYPHS.compact,
		[NOTICES.summary]: NERD_GLYPHS.summary,
		[NOTICES.stash]: NERD_GLYPHS.stash,
	} as const;

	test("keeps the settled reading beside a phase glyph in the reserved field", () => {
		const speed = { tokensPerSecond: 42.25, estimated: true };
		const baseline = stripVTControlCharacters(
			renderLaneStrip(dominantSnapshot, 60, identityStyles, 0, "idle", speed, NERD_GLYPHS),
		);
		for (const notice of [NOTICES.waiting, NOTICES.retrying, NOTICES.compact, NOTICES.summary] as const) {
			const { styles, seen } = recorder();
			const strip = stripVTControlCharacters(
				renderLaneStrip(dominantSnapshot, 60, styles, 0, "idle", speed, NERD_GLYPHS, notice),
			);
			// The phase glyph takes the speedometer's slot; the reading stays beside it.
			const shown = ICON_FOR_NOTICE[notice];
			assert.equal(visibleWidth(strip), 60);
			assert.equal(strip.indexOf("15.6%"), baseline.indexOf("15.6%"));
			assert.equal(strip.indexOf(NERD_GLYPHS.pacmanOpen), baseline.indexOf(NERD_GLYPHS.pacmanOpen));
			assert.ok(strip.endsWith(`${shown} ~42.3t/s `), strip);
			assert.ok(!strip.includes(NERD_GLYPHS.speed), strip);
			assert.ok(!strip.includes(notice), strip);
			assert.ok(seen.some(([token, text]) => token === "dim" && text.includes(shown)));
		}
		// ASCII has no phase glyph, so its words replace the whole field instead.
		for (const notice of [NOTICES.waiting, NOTICES.retrying, NOTICES.compact, NOTICES.summary] as const) {
			const strip = stripVTControlCharacters(
				renderLaneStrip(dominantSnapshot, 60, identityStyles, 0, "idle", speed, ASCII_GLYPHS, notice),
			);
			assert.equal(visibleWidth(strip), 60);
			assert.ok(strip.endsWith(`${notice} `), strip);
			assert.ok(!strip.includes("t/s"), strip);
		}
	});

	test("notice and speed share one right-aligned field across the transition", () => {
		const speed = { tokensPerSecond: 9.8, estimated: true };
		const before = stripVTControlCharacters(
			renderLaneStrip(dominantSnapshot, 60, identityStyles, 0, "idle", null, NERD_GLYPHS, "waiting…"),
		);
		const after = stripVTControlCharacters(
			renderLaneStrip(dominantSnapshot, 60, identityStyles, 0, "idle", speed, NERD_GLYPHS),
		);
		assert.equal(visibleWidth(before), 60);
		assert.equal(before.indexOf("15.6%"), after.indexOf("15.6%"));
		// Without a reading the field holds the unknown marker, never a lone icon in blank space.
		assert.ok(before.endsWith(`${NERD_GLYPHS.waiting} ?t/s `));
		assert.ok(after.endsWith("~9.8t/s "));
	});

	test("shows one notice icon instead of its words, and the words only without icons", () => {
		for (const notice of [
			NOTICES.waiting,
			NOTICES.retrying,
			NOTICES.compact,
			NOTICES.summary,
			NOTICES.stash,
		] as const) {
			const icon = ICON_FOR_NOTICE[notice];
			const wide = stripVTControlCharacters(
				renderLaneStrip(dominantSnapshot, 60, identityStyles, 0, "idle", null, NERD_GLYPHS, notice),
			);
			assert.equal(visibleWidth(wide), 60);
			assert.ok(wide.endsWith(`${icon} ?t/s `), wide);
			assert.ok(!wide.includes(notice), wide);
			// ASCII has no icons, so the notice falls back to its words.
			const ascii = stripVTControlCharacters(
				renderLaneStrip(dominantSnapshot, 60, identityStyles, 0, "idle", null, ASCII_GLYPHS, notice),
			);
			assert.ok(ascii.endsWith(`${notice} `), ascii);
		}
		// A narrow strip drops the window and the icon before the unknown reading, never leaving
		// the phase glyph alone in the field.
		const tight = stripVTControlCharacters(
			renderLaneStrip(dominantSnapshot, 24, identityStyles, 0, "idle", null, NERD_GLYPHS, NOTICES.waiting),
		);
		assert.equal(visibleWidth(tight), 24);
		// The reading survives, but the lone phase glyph never does.
		assert.ok(tight.includes("?t/s"), tight);
		assert.ok(!tight.endsWith(`${NERD_GLYPHS.waiting} `), tight);
	});

	test("keeps the phase reading when the icon or window cannot fit", () => {
		const speed = { tokensPerSecond: 42.3, estimated: false };
		// Exact reported shape: a 24-column strip with a known window keeps the useful reading and
		// gives up the window detail instead of shrinking to a lone hourglass.
		const wide = stripVTControlCharacters(
			renderLaneStrip(
				snapshot({ usedTokens: 31_200, contextWindow: 200_000 }),
				24,
				identityStyles,
				0,
				"working",
				speed,
				NERD_GLYPHS,
				NOTICES.waiting,
			),
		);
		assert.equal(visibleWidth(wide), 24);
		assert.ok(wide.includes(NERD_GLYPHS.waiting), wide);
		assert.ok(wide.includes("42.3t/s"), wide);
		assert.ok(!wide.includes("(200K)"), wide);

		// Less room drops the icon but keeps the number; still less drops the whole phase field.
		const noIcon = stripVTControlCharacters(
			renderLaneStrip(
				snapshot({ usedTokens: 31_200, contextWindow: 200_000 }),
				20,
				identityStyles,
				0,
				"working",
				speed,
				NERD_GLYPHS,
				NOTICES.waiting,
			),
		);
		assert.ok(noIcon.includes("42.3t/s"), noIcon);
		assert.ok(!noIcon.includes(NERD_GLYPHS.waiting), noIcon);
		const noField = stripVTControlCharacters(
			renderLaneStrip(
				snapshot({ usedTokens: 31_200, contextWindow: 200_000 }),
				19,
				identityStyles,
				0,
				"working",
				speed,
				NERD_GLYPHS,
				NOTICES.waiting,
			),
		);
		assert.ok(noField.includes("15.6%"), noField);
		assert.ok(!noField.includes("t/s"), noField);
		assert.ok(!noField.includes(NERD_GLYPHS.waiting), noField);
	});

	test("drops the notice before the percent on narrow strips", () => {
		const roomy = stripVTControlCharacters(
			renderLaneStrip(
				snapshot({ usedTokens: null, contextWindow: 0 }),
				17,
				identityStyles,
				0,
				"idle",
				null,
				NERD_GLYPHS,
				"waiting…",
			),
		);
		assert.ok(roomy.includes("?%"), roomy);
		assert.ok(roomy.includes(NERD_GLYPHS.waiting), roomy);
		const tight = stripVTControlCharacters(
			renderLaneStrip(
				snapshot({ usedTokens: null, contextWindow: 0 }),
				13,
				identityStyles,
				0,
				"idle",
				null,
				NERD_GLYPHS,
				"waiting…",
			),
		);
		assert.ok(tight.includes("?%"), tight);
		assert.ok(!tight.includes("waiting"), tight);
	});

	test("drops pending punctuation before phase text on narrow ASCII strips", () => {
		for (const [notice, width] of [
			["waiting…", 17],
			["retrying…", 18],
		] as const) {
			const strip = renderLaneStrip(
				snapshot({ usedTokens: null, contextWindow: 0 }),
				width,
				identityStyles,
				0,
				"idle",
				null,
				ASCII_GLYPHS,
				notice,
			);
			assert.equal(visibleWidth(strip), width);
			assert.ok(strip.includes("?%"), strip);
			assert.ok(strip.endsWith(`${notice.slice(0, -1)} `), strip);
			assert.ok(!strip.includes("…"), strip);
		}
	});

	test("every pending notice fits widths 0..200 in either glyph set", () => {
		for (const glyphs of [NERD_GLYPHS, ASCII_GLYPHS]) {
			// A blank notice is not a notice; the guard is typed away at the call site but still shipped.
			for (const notice of [
				NOTICES.waiting,
				NOTICES.retrying,
				NOTICES.compact,
				NOTICES.summary,
				NOTICES.stash,
				" " as unknown as HealthNotice,
			] as const) {
				for (let width = 0; width <= 200; width++) {
					const strip = renderLaneStrip(dominantSnapshot, width, identityStyles, 0, "working", null, glyphs, notice);
					assert.ok(visibleWidth(strip) <= width, `strip width=${width}, notice=${notice}`);
				}
			}
		}
	});

	test("shrinks the speed field rather than dropping a readable number on narrow strips", () => {
		// Without a known window the reserved field cannot fit, but the reading's own width can.
		const strip = stripVTControlCharacters(
			renderLaneStrip(snapshot({ usedTokens: null, contextWindow: 0 }), 17, identityStyles, 0, "idle", {
				tokensPerSecond: 42.3,
				estimated: false,
			}),
		);
		assert.equal(visibleWidth(strip), 17);
		assert.ok(strip.includes("42.3t/s"), strip);
		assert.ok(strip.includes("?%"), strip);
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
