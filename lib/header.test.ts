import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { PACMAN_FRAMES, PACMAN_GLYPH, PELLET_GLYPH } from "./chrome.ts";
import { type HeaderStyles, type Hint, renderSweepLine, renderWelcome, SWEEP_FRAMES } from "./header.ts";

const identityStyles: HeaderStyles = {
	accent: (text) => text,
	dim: (text) => text,
	muted: (text) => text,
};

const version = "1.2.3";
const compact: readonly Hint[] = [
	{ key: "esc", action: "interrupt" },
	{ key: "ctrl+c", action: "exit" },
];
const expanded: readonly Hint[] = [...compact, { key: "ctrl+p", action: "select model" }];

describe("sweep line", () => {
	test("starts full of pellets and ends eaten", () => {
		const start = stripVTControlCharacters(renderSweepLine(0, 30));
		const end = stripVTControlCharacters(renderSweepLine(SWEEP_FRAMES, 30));
		assert.ok(start.includes(PELLET_GLYPH));
		assert.ok(start.includes(PACMAN_GLYPH));
		assert.ok(!end.includes(PELLET_GLYPH));
	});

	test("pacman advances monotonically", () => {
		const pacmanIndex = (frame: number) => {
			const glyph = PACMAN_FRAMES[frame % PACMAN_FRAMES.length] ?? PACMAN_GLYPH;
			return stripVTControlCharacters(renderSweepLine(frame, 40)).indexOf(glyph);
		};
		for (let frame = 1; frame <= SWEEP_FRAMES; frame += 1) {
			assert.ok(pacmanIndex(frame) >= pacmanIndex(frame - 1));
		}
	});

	test("handles tiny widths", () => {
		assert.equal(renderSweepLine(3, 2), "");
	});
});

describe("welcome header", () => {
	test("collapsed shows logo row and one hint row", () => {
		const lines = renderWelcome(version, compact, expanded, false, 80, identityStyles).map(stripVTControlCharacters);
		assert.equal(lines.length, 3);
		assert.equal(lines[1], "pi v1.2.3");
		assert.ok(lines[2]?.includes("esc interrupt · ctrl+c exit"));
	});

	test("drops the hint row on narrow widths", () => {
		const narrow = renderWelcome(version, compact, expanded, false, 20, identityStyles).map(stripVTControlCharacters);
		assert.equal(narrow.length, 2);
		assert.equal(narrow[1], "pi v1.2.3");
	});

	test("expanded lists every hint on its own row", () => {
		const lines = renderWelcome(version, compact, expanded, true, 80, identityStyles).map(stripVTControlCharacters);
		assert.equal(lines.length, 2 + expanded.length);
		assert.ok(lines.at(-1)?.includes("ctrl+p select model"));
	});

	test("skips hints with unbound keys", () => {
		const hints: readonly Hint[] = [{ key: "", action: "nothing" }];
		const lines = renderWelcome(version, hints, hints, true, 80, identityStyles);
		assert.equal(lines.length, 2);
	});
});
