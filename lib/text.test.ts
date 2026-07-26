import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fitStyledText, foreground, plainWidth, stripAnsi } from "./text.ts";

describe("ANSI text helpers", () => {
	test("strips styling and measures plain width", () => {
		assert.equal(stripAnsi("\x1b[38;2;1;2;3mhi\x1b[39m"), "hi");
		assert.equal(plainWidth("\x1b[31mab\x1b[39m"), 2);
		assert.equal(plainWidth("你"), 2);
		assert.equal(plainWidth("e\u0301"), 1);
	});

	test("truncates plain and styled text", () => {
		assert.equal(fitStyledText("hello", 10), "hello");
		assert.equal(fitStyledText("hello", 0), "");
		assert.equal(stripAnsi(fitStyledText("hello", 1)), "…");
		assert.equal(stripAnsi(fitStyledText("hello", 3)), "he…");
		assert.equal(stripAnsi(fitStyledText("你好世界", 5)), "你好…");
		assert.equal(stripAnsi(fitStyledText("e\u0301clair", 3)), "e\u0301c…");
		const styled = "\x1b[31mhello\x1b[39m";
		assert.equal(fitStyledText(styled, 10), styled);
		assert.equal(stripAnsi(fitStyledText(styled, 3)), "he…");
	});

	test("builds true-color foreground escapes", () => {
		assert.equal(stripAnsi(foreground("#010203", "x")), "x");
	});
});
