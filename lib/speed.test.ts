import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	CHARACTERS_PER_TOKEN,
	completedTokenSpeed,
	estimateDeltaTokens,
	finishSpeedMessage,
	formatTokenSpeed,
	INITIAL_OUTPUT_SPEED,
	pushSpeedSample,
	recordSpeedDelta,
	resetTurnSpeed,
	restartSpeedStream,
	SPEED_SAMPLE_CAP,
	settleSpeedTurn,
	TOOL_CHARACTERS_PER_TOKEN,
	windowedTokenSpeed,
} from "./speed.ts";

describe("token speed", () => {
	test("estimates delta tokens at their text density", () => {
		assert.equal(estimateDeltaTokens("12345678"), 2);
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

describe("output speed lifecycle", () => {
	test("a first chunk without history stays unknown, then the window measures", () => {
		const first = recordSpeedDelta(INITIAL_OUTPUT_SPEED, 250, 0);
		assert.equal(first.reading, null);
		assert.equal(first.streamTokens, 250);
		assert.equal(first.streamStartedAt, 0);
		const measured = recordSpeedDelta(first, 250, 600);
		assert.equal(measured.reading?.tokensPerSecond, 250 / 0.6);
		assert.equal(measured.reading?.estimated, true);
	});

	test("turn and message boundaries keep the last measured reading", () => {
		const settled = { ...INITIAL_OUTPUT_SPEED, reading: { tokensPerSecond: 100, estimated: false } };
		const nextTurn = resetTurnSpeed(settled);
		assert.deepEqual(nextTurn.reading, settled.reading);
		assert.equal(nextTurn.turnOutputTokens, 0);
		assert.equal(nextTurn.turnActiveMs, 0);
		const restarted = restartSpeedStream(nextTurn);
		assert.deepEqual(restarted.reading, settled.reading);
		assert.deepEqual(restarted.samples, []);
		const held = recordSpeedDelta(restarted, 100, 1_000);
		assert.deepEqual(held.reading, { tokensPerSecond: 100, estimated: true });
	});

	test("completed output settles a calibrated reading and keeps it when unmeasurable", () => {
		const streaming = recordSpeedDelta(INITIAL_OUTPUT_SPEED, 100, 0);
		const finished = finishSpeedMessage(streaming, 50, 2_000);
		assert.equal(finished.turnActiveMs, 2_000);
		assert.equal(finished.turnOutputTokens, 50);
		assert.equal(finished.reading, null);
		const settled = settleSpeedTurn(finished);
		assert.deepEqual(settled.reading, { tokensPerSecond: 25, estimated: false });
		// Too short to calibrate: the held live reading survives instead of blanking the field.
		const unmeasurable = settleSpeedTurn({
			...INITIAL_OUTPUT_SPEED,
			reading: { tokensPerSecond: 42, estimated: true },
			turnOutputTokens: 1,
			turnActiveMs: 10,
		});
		assert.deepEqual(unmeasurable.reading, { tokensPerSecond: 42, estimated: true });
	});
});
