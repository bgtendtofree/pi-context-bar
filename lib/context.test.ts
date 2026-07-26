import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { type AssistantUsage, accumulateSessionUsage, cacheHitRate } from "./context.ts";

const assistantUsage = (partial: Partial<Omit<AssistantUsage, "cost">> = {}, totalCost = 0): AssistantUsage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCost },
	...partial,
});

const assistantEntry = (id: string, usage: AssistantUsage): SessionMessageEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "",
	message: {
		role: "assistant",
		content: [],
		api: "test",
		provider: "test",
		model: "test",
		usage,
		stopReason: "stop",
		timestamp: 0,
	},
});

describe("session usage", () => {
	test("computes cache hit rate", () => {
		assert.equal(cacheHitRate(assistantUsage({ input: 10, cacheRead: 90 })), 90);
		assert.equal(cacheHitRate(assistantUsage()), undefined);
		assert.equal(cacheHitRate(assistantUsage({ input: 5, cacheWrite: 5 })), 0);
	});

	test("accumulates assistant cost and keeps latest valid CH", () => {
		const result = accumulateSessionUsage([
			{
				type: "model_change",
				id: "model",
				parentId: null,
				timestamp: "",
				provider: "test",
				modelId: "test",
			},
			assistantEntry("one", assistantUsage({ input: 10, output: 5, cacheRead: 90 }, 0.01)),
			assistantEntry("two", assistantUsage({ input: 20, output: 5, cacheRead: 80 }, 0.02)),
			assistantEntry("three", assistantUsage()),
		]);
		assert.ok(Math.abs(result.cost - 0.03) < 1e-10);
		assert.equal(result.cacheHitRate, 80);
	});
});
