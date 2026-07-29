import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { completedTokenSpeed, estimateDeltaTokens, estimateTokenSpeed, formatTokenSpeed } from "./speed.ts";

describe("token speed", () => {
	test("measures cumulative live rate with floored elapsed time", () => {
		assert.equal(estimateDeltaTokens("12345678"), 2);
		assert.equal(estimateTokenSpeed(0, 1000), null);
		assert.equal(estimateTokenSpeed(5, 0)?.tokensPerSecond, 20);
		assert.equal(estimateTokenSpeed(25, 500)?.tokensPerSecond, 50);
		assert.equal(estimateTokenSpeed(35, 1600)?.tokensPerSecond, 21.875);
	});

	test("formats estimated and provider-calibrated rates", () => {
		assert.equal(formatTokenSpeed({ tokensPerSecond: 42.25, estimated: true }), "~42.3t/s");
		assert.equal(formatTokenSpeed(completedTokenSpeed(100, 2000)), "50.0t/s");
		assert.equal(completedTokenSpeed(10, 50), null);
		assert.equal(formatTokenSpeed(null), "");
	});
});
