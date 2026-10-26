import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	CHARACTERS_PER_TOKEN,
	completedTokenSpeed,
	estimateDeltaTokens,
	estimateTokenSpeed,
	formatTokenSpeed,
	TOOL_CHARACTERS_PER_TOKEN,
} from "./speed.ts";

describe("token speed", () => {
	test("measures cumulative live rate with floored elapsed time", () => {
		assert.equal(estimateDeltaTokens("12345678"), 2);
		assert.equal(estimateTokenSpeed(0, 1000), null);
		assert.equal(estimateTokenSpeed(5, 0)?.tokensPerSecond, 20);
		assert.equal(estimateTokenSpeed(25, 500)?.tokensPerSecond, 50);
		assert.equal(estimateTokenSpeed(35, 1600)?.tokensPerSecond, 21.875);
	});

	test("estimates CJK at one token per character instead of four", () => {
		assert.equal(estimateDeltaTokens("你好世界"), 4);
		assert.equal(estimateDeltaTokens("こんにちは"), 5);
		assert.equal(estimateDeltaTokens("안녕하세요"), 5);
		assert.equal(estimateDeltaTokens("、。「」"), 4);
		// Mixed text: ASCII keeps the prose density, CJK stays per-character.
		assert.equal(estimateDeltaTokens("hi你好"), 2 / CHARACTERS_PER_TOKEN + 2);
	});

	test("estimates tool-call JSON at two characters per token", () => {
		assert.equal(estimateDeltaTokens('{"a":1}', "toolcall"), 7 / TOOL_CHARACTERS_PER_TOKEN);
		assert.equal(estimateDeltaTokens('{"q":"你好"}', "toolcall"), 2 + 8 / TOOL_CHARACTERS_PER_TOKEN);
		// The same fragment is prose when it arrives as text, so densities never leak across kinds.
		assert.equal(estimateDeltaTokens('{"a":1}', "text"), 7 / CHARACTERS_PER_TOKEN);
		assert.equal(estimateDeltaTokens('{"a":1}', "thinking"), 7 / CHARACTERS_PER_TOKEN);
	});

	test("reports no estimate for empty deltas", () => {
		assert.equal(estimateDeltaTokens("", "text"), 0);
		assert.equal(estimateDeltaTokens("", "toolcall"), 0);
	});

	test("formats estimated and provider-calibrated rates", () => {
		assert.equal(formatTokenSpeed({ tokensPerSecond: 42.25, estimated: true }), "~42.3t/s");
		assert.equal(formatTokenSpeed(completedTokenSpeed(100, 2000)), "50.0t/s");
		assert.equal(completedTokenSpeed(10, 50), null);
		assert.equal(formatTokenSpeed(null), "");
	});
});
