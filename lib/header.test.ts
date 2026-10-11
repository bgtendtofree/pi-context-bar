import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	HEADER_INDENT,
	type HeaderMark,
	type HeaderStyles,
	type Hint,
	PI_MARK_LINES,
	renderWelcome,
} from "./header.ts";

const identityStyles: HeaderStyles = {
	accent: (text) => text,
	dim: (text) => text,
};

const version = "1.2.3";
const compact: readonly Hint[] = [
	{ key: "esc", action: "interrupt" },
	{ key: "ctrl+c", action: "exit" },
];
const expanded: readonly Hint[] = [...compact, { key: "ctrl+p", action: "select model" }];

const welcome = (
	mark: HeaderMark,
	expandedState: boolean,
	width: number,
	styles: HeaderStyles = identityStyles,
	hints: readonly Hint[] = compact,
	expandedList: readonly Hint[] = expanded,
): readonly string[] => renderWelcome(version, hints, expandedList, expandedState, mark, width, styles);

describe("welcome header mark", () => {
	test("block mark is pi's silhouette drawn as half blocks", () => {
		assert.deepEqual(PI_MARK_LINES, ["▀▀█", "█▀ █"]);
	});

	test("block mark keeps one theme token per cell and no brand hex", () => {
		const lines = welcome("block", false, 80).map(stripVTControlCharacters);
		assert.equal(lines[1], `${" ".repeat(HEADER_INDENT)}▀▀█ v1.2.3`);
		assert.equal(lines[2], `${" ".repeat(HEADER_INDENT)}█▀ █  esc interrupt · ctrl+c exit`);
		assert.ok(!lines.join("").includes("#"));
	});

	test("expanded block mark lists hints under the mark instead of beside it", () => {
		const lines = welcome("block", true, 80).map(stripVTControlCharacters);
		assert.equal(lines.length, 3 + expanded.length);
		assert.equal(lines[1], `${" ".repeat(HEADER_INDENT)}▀▀█ v1.2.3`);
		assert.equal(lines[2], `${" ".repeat(HEADER_INDENT)}█▀ █`);
		assert.equal(lines.at(-1), `${" ".repeat(HEADER_INDENT)}ctrl+p select model`);
	});

	test("block mark keeps exactly one compact hint row, or none when it does not fit", () => {
		const wide = welcome("block", false, 80).map(stripVTControlCharacters);
		assert.equal(wide.length, 3);
		const noHints = welcome("block", false, 30, identityStyles, [{ key: "", action: "nothing" }]).map(
			stripVTControlCharacters,
		);
		assert.deepEqual(noHints, ["", `${" ".repeat(HEADER_INDENT)}▀▀█ v1.2.3`, `${" ".repeat(HEADER_INDENT)}█▀ █`]);
	});

	test("falls back to the text wordmark when the mark cannot fit", () => {
		for (const width of [1, 2, 3, 4, 5, 6]) {
			// One logo row and one blank row: the two-row mark and its hint row are gone.
			const lines = welcome("block", false, width).map(stripVTControlCharacters);
			assert.equal(lines.length, 2);
			assert.ok(!/▀|█/.test(lines.join("")));
		}
	});
});

describe("welcome header", () => {
	test("collapsed shows logo row and one hint row", () => {
		const lines = welcome("text", false, 80).map(stripVTControlCharacters);
		assert.equal(lines.length, 3);
		assert.equal(lines[1], `${" ".repeat(HEADER_INDENT)}pi v1.2.3`);
		assert.equal(lines[2], `${" ".repeat(HEADER_INDENT)}esc interrupt · ctrl+c exit`);
	});

	test("drops the hint row on narrow widths", () => {
		const narrow = welcome("text", false, 20).map(stripVTControlCharacters);
		assert.equal(narrow.length, 2);
		assert.equal(narrow[1], `${" ".repeat(HEADER_INDENT)}pi v1.2.3`);
	});

	test("expanded lists every hint on its own row", () => {
		const lines = welcome("text", true, 80).map(stripVTControlCharacters);
		assert.equal(lines.length, 2 + expanded.length);
		assert.equal(lines.at(-1), `${" ".repeat(HEADER_INDENT)}ctrl+p select model`);
	});

	test("skips hints with unbound keys", () => {
		const hints: readonly Hint[] = [{ key: "", action: "nothing" }];
		assert.equal(renderWelcome(version, hints, hints, true, "text", 80, identityStyles).length, 2);
		assert.equal(renderWelcome(version, hints, hints, true, "block", 80, identityStyles).length, 3);
	});

	test("keeps collapsed and expanded lines inside narrow widths", () => {
		for (let width = 0; width <= 80; width++) {
			for (const expandedState of [false, true]) {
				for (const mark of ["block", "text"] as const) {
					const lines = welcome(mark, expandedState, width);
					assert.ok(lines.every((line) => visibleWidth(line) <= width));
				}
			}
		}
	});

	test("includes only complete keybinding hints when width is tight", () => {
		const hints: readonly Hint[] = [
			{ key: "esc", action: "interrupt" },
			{ key: "ctrl+c", action: "exit" },
			{ key: "ctrl+p", action: "select an especially long model name" },
		];
		const collapsed = renderWelcome(version, hints, hints, false, "text", 40, identityStyles);
		assert.equal(collapsed[2], `${" ".repeat(HEADER_INDENT)}esc interrupt · ctrl+c exit`);
		const expandedLines = renderWelcome(version, hints, hints, true, "text", 20, identityStyles);
		assert.deepEqual(expandedLines.slice(2), [
			`${" ".repeat(HEADER_INDENT)}esc interrupt`,
			`${" ".repeat(HEADER_INDENT)}ctrl+c exit`,
		]);
	});

	test("differs from the built-in header before falling back to plain text", () => {
		const styles: HeaderStyles = {
			accent: (text) => `<a>${text}</a>`,
			dim: (text) => `<d>${text}</d>`,
		};
		const lines = welcome("block", false, 80, styles);
		assert.ok(lines[1]?.startsWith(`${" ".repeat(HEADER_INDENT)}<a>▀▀█</a> <d>v1.2.3</d>`));
	});

	test("keeps keys more prominent than descriptions in both views", () => {
		const styles: HeaderStyles = {
			accent: (text) => `<a>${text}</a>`,
			dim: (text) => `<d>${text}</d>`,
		};
		for (const expandedState of [false, true]) {
			const lines = welcome("text", expandedState, 120, styles);
			assert.ok(lines[2]?.startsWith(`${" ".repeat(HEADER_INDENT)}<a>esc</a> <d>interrupt</d>`));
		}
	});

	test("accounts for indentation when fitting complete hints", () => {
		const hints: readonly Hint[] = [{ key: "/", action: "x".repeat(37) }];
		assert.equal(renderWelcome(version, hints, hints, false, "text", 40, identityStyles).length, 2);
		assert.equal(renderWelcome(version, hints, hints, true, "text", 40, identityStyles).length, 2);
	});
});
