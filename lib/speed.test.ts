import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { completedTokenSpeed, estimateDeltaTokens, formatTokenSpeed, recordTokenSpeed } from "./speed.ts";

describe("token speed", () => {
	test("measures a bounded live window", () => {
		assert.equal(estimateDeltaTokens("12345678"), 2);
		const first = recordTokenSpeed([], 1000, 1000, 5);
		assert.equal(first.snapshot.tokensPerSecond, 20);
		const second = recordTokenSpeed(first.samples, 1500, 1000, 20);
		assert.equal(second.snapshot.tokensPerSecond, 50);
		const pruned = recordTokenSpeed(second.samples, 2600, 1000, 10);
		assert.deepEqual(pruned.samples, [{ time: 2600, tokens: 10 }]);
		assert.equal(pruned.snapshot.tokensPerSecond, 10);
	});

	test("formats estimated and provider-calibrated rates", () => {
		assert.equal(formatTokenSpeed({ tokensPerSecond: 42.25, estimated: true }), "~42.3t/s");
		assert.equal(formatTokenSpeed(completedTokenSpeed(100, 2000)), "50.0t/s");
		assert.equal(completedTokenSpeed(10, 50), null);
		assert.equal(formatTokenSpeed(null), "");
	});
});
