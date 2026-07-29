import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { foreground, plainWidth, stripAnsi } from "./text.ts";

describe("ANSI text helpers", () => {
	test("strips styling and measures plain width", () => {
		assert.equal(stripAnsi("\x1b[38;2;1;2;3mhi\x1b[39m"), "hi");
		assert.equal(plainWidth("\x1b[31mab\x1b[39m"), 2);
		assert.equal(plainWidth("你"), 2);
		assert.equal(plainWidth("e\u0301"), 1);
	});

	test("builds true-color foreground escapes", () => {
		assert.equal(stripAnsi(foreground("#010203", "x")), "x");
	});
});
