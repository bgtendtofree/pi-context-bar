import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	type AssistantUsage,
	accumulateSessionUsage,
	allocateProportionally,
	CONTEXT_SEGMENTS,
	cacheHitRate,
	emptyContextSegments,
	estimateContentTokens,
	estimateTextTokens,
	formatTokens,
	IMAGE_TOKEN_ESTIMATE,
	makeContextSnapshot,
	scaleSegmentsToUsage,
	segmentSessionMessages,
	segmentTotal,
} from "./context.ts";

const assistantUsage = (partial: Partial<AssistantUsage> = {}): AssistantUsage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: { total: 0 },
	...partial,
});

describe("formatTokens and estimation", () => {
	test("formats token ranges", () => {
		assert.equal(formatTokens(-5), "0");
		assert.equal(formatTokens(999), "999");
		assert.equal(formatTokens(1500), "1.5k");
		assert.equal(formatTokens(9999), "10.0k");
		assert.equal(formatTokens(123_456), "123k");
		assert.equal(formatTokens(2_500_000), "2.5M");
		assert.equal(formatTokens(10_000_000), "10M");
	});

	test("estimates text and image content", () => {
		assert.equal(estimateTextTokens("abcd"), 1);
		assert.equal(estimateTextTokens("abcde"), 2);
		assert.equal(estimateTextTokens(""), 0);
		assert.equal(estimateContentTokens([{ type: "text", text: "abcd" }, { type: "image" }]), 1 + IMAGE_TOKEN_ESTIMATE);
		assert.equal(estimateContentTokens("abcd"), 1);
	});
});

describe("context segmentation", () => {
	test("buckets roles and tool calls", () => {
		const segments = segmentSessionMessages(
			[
				{ role: "user", content: "abcd" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "abcd" },
						{ type: "thinking", thinking: "abcd" },
						{ type: "toolCall", name: "read", arguments: {} },
					],
				},
				{ role: "toolResult", content: "abcd" },
				{ role: "other" },
				null,
			],
			"abcd",
		);
		assert.equal(segments.system, 1);
		assert.equal(segments.prompt, 1);
		assert.ok(segments.assistant > 0);
		assert.equal(segments.thinking, 1);
		assert.equal(segments.tools, 1);
		assert.equal(
			segmentTotal(segments),
			Object.values(segments).reduce((sum, value) => sum + value, 0),
		);
	});

	test("keeps stable segment keys", () => {
		assert.deepEqual(
			CONTEXT_SEGMENTS.map((segment) => segment.key),
			["system", "prompt", "assistant", "thinking", "tools"],
		);
	});
});

describe("proportional allocation", () => {
	test("allocates all columns with fair remainders", () => {
		const columns = allocateProportionally([1, 1, 1], 5);
		assert.equal(
			columns.reduce((sum, value) => sum + value, 0),
			5,
		);
		assert.equal(
			columns.every((value) => value >= 1),
			true,
		);
	});

	test("handles empty totals and columns", () => {
		assert.deepEqual(allocateProportionally([1, 2], 0), [0, 0]);
		assert.deepEqual(allocateProportionally([0, 0], 5), [0, 0]);
	});

	test("scales segment estimates to measured usage", () => {
		const raw = { ...emptyContextSegments(), system: 10, prompt: 30 };
		const scaled = scaleSegmentsToUsage(raw, 100);
		assert.equal(segmentTotal(scaled), 100);
		assert.ok(scaled.prompt > scaled.system);
		assert.deepEqual(scaleSegmentsToUsage(emptyContextSegments(), 100), emptyContextSegments());
		assert.deepEqual(scaleSegmentsToUsage({ ...emptyContextSegments(), prompt: 5 }, 0), {
			...emptyContextSegments(),
			prompt: 5,
		});
	});
});

describe("context snapshots", () => {
	test("uses measured tokens when present", () => {
		const snapshot = makeContextSnapshot([{ role: "user", content: "abcdabcd" }], "abcd", 1000, 200_000);
		assert.equal(snapshot.usedTokens, 1000);
		assert.equal(snapshot.usageIsEstimated, false);
		assert.equal(snapshot.contextWindow, 200_000);
		assert.equal(segmentTotal(snapshot.segments), 1000);
	});

	test("falls back to estimate", () => {
		const snapshot = makeContextSnapshot([{ role: "user", content: "abcd" }], "abcd", undefined, 0);
		assert.equal(snapshot.usageIsEstimated, true);
		assert.equal(snapshot.usedTokens, segmentTotal(snapshot.segments));
	});
});

describe("session usage", () => {
	test("computes cache hit rate", () => {
		assert.equal(cacheHitRate(assistantUsage({ input: 10, cacheRead: 90 })), 90);
		assert.equal(cacheHitRate(assistantUsage()), undefined);
		assert.equal(cacheHitRate(assistantUsage({ input: 5, cacheWrite: 5 })), 0);
	});

	test("accumulates assistant entries and keeps latest valid CH", () => {
		const result = accumulateSessionUsage([
			{ type: "message", message: { role: "user", usage: assistantUsage({ input: 999 }) } },
			{
				type: "message",
				message: {
					role: "assistant",
					usage: assistantUsage({ input: 10, output: 5, cacheRead: 90, cost: { total: 0.01 } }),
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					usage: assistantUsage({ input: 20, output: 5, cacheRead: 80, cost: { total: 0.02 } }),
				},
			},
			{ type: "message", message: { role: "assistant", usage: assistantUsage() } },
		]);
		assert.equal(result.input, 30);
		assert.equal(result.output, 10);
		assert.equal(result.cacheRead, 170);
		assert.ok(Math.abs(result.cost - 0.03) < 1e-10);
		assert.equal(result.cacheHitRate, 80);
	});
});
