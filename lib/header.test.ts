import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
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
