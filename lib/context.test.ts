import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
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

const assistantEntry = (id: string, usage: AssistantUsage, provider = "test"): SessionMessageEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "",
	message: {
		role: "assistant",
		content: [],
		api: "test",
		provider,
		model: "test",
		usage,
		stopReason: "stop",
		timestamp: 0,
	},
});

const toolResultEntry = (id: string, usage: AssistantUsage): SessionMessageEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "",
	message: {
		role: "toolResult",
		toolCallId: "call",
		toolName: "generateImage",
		content: [],
		usage,
		isError: false,
		timestamp: 0,
	},
});

const summaryEntry = (id: string, usage: AssistantUsage): SessionEntry => ({
	type: "compaction",
	id,
	parentId: null,
	timestamp: "",
	summary: "",
	firstKeptEntryId: "",
	tokensBefore: 0,
	usage,
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

	test("excludes subscription-plan assistant cost but keeps its CH", () => {
		const result = accumulateSessionUsage([
			assistantEntry("plan", assistantUsage({ input: 10, cacheRead: 90 }, 0.5), "kimi-coding"),
			assistantEntry("billed", assistantUsage({ input: 20, output: 5, cacheRead: 80 }, 0.01)),
		]);
		assert.ok(Math.abs(result.cost - 0.01) < 1e-10);
		assert.equal(result.cacheHitRate, 80);
	});

	test("counts toolResult and compaction usage as billed", () => {
		const result = accumulateSessionUsage([
			assistantEntry("one", assistantUsage({}, 0.01)),
			toolResultEntry("tool", assistantUsage({}, 0.02)),
			summaryEntry("compact", assistantUsage({}, 0.03)),
		]);
		assert.ok(Math.abs(result.cost - 0.06) < 1e-10);
	});
});
