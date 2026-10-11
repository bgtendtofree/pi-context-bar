import assert from "node:assert/strict";
import { test } from "node:test";
import { isObject, toNumber } from "./json.ts";

test("accepts finite numbers and non-empty numeric strings", () => {
	assert.equal(toNumber(0), 0);
	assert.equal(toNumber(12.5), 12.5);
	assert.equal(toNumber(-3), -3);
	assert.equal(toNumber("42"), 42);
	assert.equal(toNumber(" 1.5 "), 1.5);
});

test("drops booleans, containers, blanks, and non-finite values", () => {
	for (const value of [
		true,
		false,
		[],
		[1],
		{},
		"",
		"   ",
		"nope",
		Number.NaN,
		Number.POSITIVE_INFINITY,
		null,
		undefined,
	]) {
		assert.equal(toNumber(value), undefined, `expected ${JSON.stringify(value)} to drop out`);
	}
});

test("treats only plain objects as objects", () => {
	assert.equal(isObject({}), true);
	assert.equal(isObject([]), false);
	assert.equal(isObject(null), false);
	assert.equal(isObject("x"), false);
});
