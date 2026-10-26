import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	CHARACTERS_PER_TOKEN,
	completedTokenSpeed,
	estimateDeltaTokens,
	estimateTokenSpeed,
	formatTokenSpeed,
	pushSpeedSample,
	SPEED_SAMPLE_CAP,
	TOOL_CHARACTERS_PER_TOKEN,
	windowedTokenSpeed,
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

describe("live window", () => {
	test("measures the newest reading against the oldest sample inside the window", () => {
		assert.equal(
			windowedTokenSpeed([
				{ at: 0, tokens: 0 },
				{ at: 500, tokens: 100 },
			])?.tokensPerSecond,
			200,
		);
		// The sample at 600 stays inside the one-second window; the 1100 reading spans it.
		const samples = pushSpeedSample(pushSpeedSample([{ at: 0, tokens: 0 }], 600, 100), 1100, 300);
		assert.deepEqual(samples, [
			{ at: 600, tokens: 100 },
			{ at: 1100, tokens: 300 },
		]);
		assert.equal(windowedTokenSpeed(samples)?.tokensPerSecond, 400);
	});

	test("drops samples older than the window so a pause cannot drag the reading down", () => {
		const samples = pushSpeedSample(
			[
				{ at: 0, tokens: 0 },
				{ at: 100, tokens: 50 },
			],
			1200,
			300,
		);
		assert.deepEqual(samples, [{ at: 1200, tokens: 300 }]);
		// One sample cannot span a rate: the caller keeps its previous reading.
		assert.equal(windowedTokenSpeed(samples), null);
	});

	test("reports nothing until the window spans the minimum interval", () => {
		assert.equal(windowedTokenSpeed([]), null);
		assert.equal(windowedTokenSpeed([{ at: 10, tokens: 5 }]), null);
		assert.equal(
			windowedTokenSpeed([
				{ at: 10, tokens: 5 },
				{ at: 400, tokens: 40 },
			]),
			null,
		);
		assert.equal(
			windowedTokenSpeed([
				{ at: 10, tokens: 5 },
				{ at: 510, tokens: 105 },
			])?.tokensPerSecond,
			200,
		);
	});

	test("a flat token count is not a rate", () => {
		assert.equal(
			windowedTokenSpeed([
				{ at: 0, tokens: 50 },
				{ at: 600, tokens: 50 },
			]),
			null,
		);
	});

	test("caps sample growth at pathological chunk rates", () => {
		let samples: readonly { at: number; tokens: number }[] = [];
		for (let index = 0; index < SPEED_SAMPLE_CAP + 50; index++) samples = pushSpeedSample(samples, index, index);
		assert.equal(samples.length, SPEED_SAMPLE_CAP);
		assert.equal(samples.at(-1)?.tokens, SPEED_SAMPLE_CAP + 49);
	});
});
