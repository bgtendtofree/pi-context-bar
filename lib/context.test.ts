import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	type AssistantUsage,
	accumulateSessionUsage,
	CONTEXT_SEGMENTS,
	cacheHitRate,
	emptyContextSegments,
	estimateContentTokens,
	estimateTextTokens,
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

describe("estimation", () => {
	test("estimates text and image content", () => {
		assert.equal(estimateTextTokens("abcd"), 1);
		assert.equal(estimateTextTokens("abcde"), 2);
		assert.equal(estimateTextTokens(""), 0);
		assert.equal(estimateContentTokens([{ type: "text", text: "abcd" }, { type: "image" }]), 1 + IMAGE_TOKEN_ESTIMATE);
		assert.equal(estimateContentTokens([{ type: "text", text: "ab" }, null, { type: "text", text: "cde" }]), 2);
		assert.equal(estimateContentTokens("abcd"), 1);
		assert.equal(estimateContentTokens({ type: "text", text: "ignored" }), 0);
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

describe("scale segments to usage", () => {
	test("scales segment estimates to measured usage", () => {
		const raw = { ...emptyContextSegments(), system: 10, prompt: 30 };
		const scaled = scaleSegmentsToUsage(raw, 100);
		assert.equal(scaled.system, 25);
		assert.equal(scaled.prompt, 75);
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
		assert.ok(snapshot.segments.prompt > 0);
		assert.ok(segmentTotal(snapshot.segments) > 0);
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

	test("accumulates assistant cost and keeps latest valid CH", () => {
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
		assert.ok(Math.abs(result.cost - 0.03) < 1e-10);
		assert.equal(result.cacheHitRate, 80);
	});
});
