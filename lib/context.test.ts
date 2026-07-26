import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type AssistantUsage, accumulateSessionUsage, cacheHitRate } from "./context.ts";

const assistantUsage = (partial: Partial<AssistantUsage> = {}): AssistantUsage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: { total: 0 },
	...partial,
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
