import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type HeaderStyles, type Hint, renderWelcome } from "./header.ts";

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

describe("welcome header", () => {
	test("collapsed shows logo row and one hint row", () => {
		const lines = renderWelcome(version, compact, expanded, false, 80, identityStyles).map(stripVTControlCharacters);
		assert.equal(lines.length, 3);
		assert.equal(lines[1], "   pi v1.2.3");
		assert.equal(lines[2], "   esc interrupt · ctrl+c exit");
	});

	test("drops the hint row on narrow widths", () => {
		const narrow = renderWelcome(version, compact, expanded, false, 20, identityStyles).map(stripVTControlCharacters);
		assert.equal(narrow.length, 2);
		assert.equal(narrow[1], "   pi v1.2.3");
	});

	test("expanded lists every hint on its own row", () => {
		const lines = renderWelcome(version, compact, expanded, true, 80, identityStyles).map(stripVTControlCharacters);
		assert.equal(lines.length, 2 + expanded.length);
		assert.equal(lines.at(-1), "   ctrl+p select model");
	});

	test("skips hints with unbound keys", () => {
		const hints: readonly Hint[] = [{ key: "", action: "nothing" }];
		const lines = renderWelcome(version, hints, hints, true, 80, identityStyles);
		assert.equal(lines.length, 2);
	});

	test("keeps collapsed and expanded lines inside narrow widths", () => {
		for (let width = 0; width <= 80; width++) {
			for (const expandedState of [false, true]) {
				const lines = renderWelcome(version, compact, expanded, expandedState, width, identityStyles);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
			}
		}
	});

	test("includes only complete keybinding hints when width is tight", () => {
		const hints: readonly Hint[] = [
			{ key: "esc", action: "interrupt" },
			{ key: "ctrl+c", action: "exit" },
			{ key: "ctrl+p", action: "select an especially long model name" },
		];
		const collapsed = renderWelcome(version, hints, hints, false, 40, identityStyles);
		assert.equal(collapsed[2], "   esc interrupt · ctrl+c exit");
		const expandedLines = renderWelcome(version, hints, hints, true, 20, identityStyles);
		assert.deepEqual(expandedLines.slice(2), ["   esc interrupt", "   ctrl+c exit"]);
	});

	test("keeps keys more prominent than descriptions in both views", () => {
		const styles: HeaderStyles = {
			accent: (text) => `<a>${text}</a>`,
			muted: (text) => `<m>${text}</m>`,
			dim: (text) => `<d>${text}</d>`,
		};
		for (const expandedState of [false, true]) {
			const lines = renderWelcome(version, compact, expanded, expandedState, 120, styles);
			assert.ok(lines[2]?.startsWith("   <a>esc</a> <d>interrupt</d>"));
		}
	});

	test("accounts for indentation when fitting complete hints", () => {
		const hints: readonly Hint[] = [{ key: "/", action: "x".repeat(37) }];
		assert.equal(renderWelcome(version, hints, hints, false, 40, identityStyles).length, 2);
		assert.equal(renderWelcome(version, hints, hints, true, 40, identityStyles).length, 2);
	});
});
