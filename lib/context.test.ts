import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import {
	type AssistantUsage,
	accumulateSessionUsage,
	cacheHitRate,
	hasRecoverableBilling,
	latestAssistantResponse,
	recoverableSubscriptionMarkers,
	SUBSCRIPTION_TURN_ENTRY,
} from "./context.ts";

const assistantUsage = (partial: Partial<Omit<AssistantUsage, "cost">> = {}, totalCost = 0): AssistantUsage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCost },
	...partial,
});

const assistantEntry = (
	id: string,
	usage: AssistantUsage,
	provider = "test",
	parentId: string | null = null,
): SessionMessageEntry => ({
	type: "message",
	id,
	parentId,
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

// Marker stored after the response, billing the referenced response id.
const subscriptionMarker = (messageEntryId: unknown, id = "billing"): Extract<SessionEntry, { type: "custom" }> => ({
	type: "custom",
	id,
	parentId: null,
	timestamp: "",
	customType: SUBSCRIPTION_TURN_ENTRY,
	data: { messageEntryId },
});

describe("session usage", () => {
	test("keeps mixed OpenAI API bills while excluding recorded subscription turns", () => {
		const result = accumulateSessionUsage([
			assistantEntry("before", assistantUsage({}, 0.2), "openai"),
			assistantEntry("sub", assistantUsage({ input: 10, cacheRead: 90 }, 0.5), "openai"),
			subscriptionMarker("sub"),
			assistantEntry("after", assistantUsage({}, 0.3), "openai"),
			toolResultEntry("classifier", assistantUsage({}, 0.04)),
		]);
		assert.ok(Math.abs(result.cost - 0.54) < 1e-10);
		assert.equal(result.cacheHitRate, 90);
		assert.equal(result.cacheHitRateAvg, 90);
	});

	test("bills a forked response again until recovery re-appends its explicit marker", () => {
		const forked = [
			assistantEntry("before", assistantUsage({}, 0.2), "openai"),
			assistantEntry("sub", assistantUsage({}, 0.5), "openai"),
		];
		assert.equal(accumulateSessionUsage(forked).cost, 0.7);
		const recovered = [...forked, subscriptionMarker("sub")];
		assert.ok(Math.abs(accumulateSessionUsage(recovered).cost - 0.2) < 1e-10);
	});

	test("bills a response referenced by a marker and ignores malformed markers", () => {
		const result = accumulateSessionUsage([
			assistantEntry("old", assistantUsage({}, 0.5), "openai"),
			subscriptionMarker("old"),
			assistantEntry("after", assistantUsage({}, 0.3), "openai"),
		]);
		assert.equal(result.cost, 0.3);

		const orphan = accumulateSessionUsage([
			assistantEntry("bill", assistantUsage({}, 0.2), "openai"),
			{ ...subscriptionMarker("bill"), customType: "another-extension" },
			...([null, [], { messageEntryId: 0 }] as const).map((data) => ({ ...subscriptionMarker("bill"), data })),
			subscriptionMarker(0),
		]);
		assert.equal(orphan.cost, 0.2);
	});

	test("keeps a provisional subscription response out of cost while still counting paid bills and tools", () => {
		const before = assistantEntry("paid", assistantUsage({}, 0.2), "openai");
		const provisional = assistantEntry("sub", assistantUsage({ input: 10, cacheRead: 90 }, 0.5), "openai");
		const tool = toolResultEntry("tool", assistantUsage({}, 0.04));
		const entries = [before, provisional, tool];
		// The caller passes the response id captured for THIS subscription request, so it is on-plan even
		// before turn_end appends the marker, while earlier paid bills and tool costs still count.
		const provisionalUsage = accumulateSessionUsage(entries, { provisionalSubscriptionId: "sub" });
		assert.ok(Math.abs(provisionalUsage.cost - 0.24) < 1e-10);
		assert.equal(provisionalUsage.cacheHitRate, 90);
		// Without the captured identity the same unmarked response is billed.
		assert.ok(Math.abs(accumulateSessionUsage(entries).cost - 0.74) < 1e-10);
		// Once the marker lands, the response is on-plan regardless of the provisional id.
		assert.ok(Math.abs(accumulateSessionUsage([...entries, subscriptionMarker("sub")]).cost - 0.24) < 1e-10);
	});

	test("never excludes an earlier paid response just because a subscription turn started", () => {
		// Before this request's response is persisted the boundary yields no provisional id, so the old
		// paid bill must stay billed throughout message_start and streaming deltas.
		const oldPaid = assistantEntry("old-paid", assistantUsage({}, 0.4), "openai");
		assert.equal(accumulateSessionUsage([oldPaid]).cost, 0.4);
		assert.equal(accumulateSessionUsage([oldPaid], { provisionalSubscriptionId: undefined }).cost, 0.4);
		assert.equal(accumulateSessionUsage([oldPaid], { provisionalSubscriptionId: "not-persisted" }).cost, 0.4);
	});

	test("recovery re-appends only parent markers whose response is in the branch and unmarked", () => {
		const before = assistantEntry("a", assistantUsage({}, 0.2), "openai");
		const sub = assistantEntry("b", assistantUsage({}, 0.5), "openai");
		const parent = [before, sub, subscriptionMarker("b")];
		assert.deepEqual(recoverableSubscriptionMarkers([before], parent), []);
		assert.deepEqual(recoverableSubscriptionMarkers([before, sub], parent), ["b"]);
		assert.deepEqual(recoverableSubscriptionMarkers([before, sub, subscriptionMarker("b")], parent), []);
	});

	test("only a billed non-plan response can be re-classified by a recovered marker", () => {
		// The parent read is skipped entirely otherwise, so these entries must not request it.
		assert.equal(hasRecoverableBilling([]), false);
		assert.equal(hasRecoverableBilling([assistantEntry("plan", assistantUsage({}, 0.4), "openai-codex")]), false);
		assert.equal(hasRecoverableBilling([assistantEntry("free", assistantUsage({}, 0), "openai")]), false);
		assert.equal(hasRecoverableBilling([toolResultEntry("tools", assistantUsage({}, 0.2))]), false);
		assert.equal(hasRecoverableBilling([assistantEntry("billed", assistantUsage({}, 0.4), "openai")]), true);
	});

	test("includes standalone usage without changing assistant cache metrics", () => {
		const warm = {
			type: "usage" as const,
			id: "warm",
			parentId: null,
			timestamp: "",
			kind: "cache_warm",
			provider: "test",
			model: "test",
			usage: assistantUsage({ cacheRead: 100 }, 0.03),
		};
		const result = accumulateSessionUsage([
			assistantEntry("one", assistantUsage({ input: 20, cacheRead: 80 }, 0.01)),
			warm,
			{ ...warm, id: "unknown", kind: "future-operation", usage: assistantUsage({}, 0.04) },
			{ ...warm, id: "plan", provider: "openai-codex" },
		]);
		assert.ok(Math.abs(result.cost - 0.08) < 1e-10);
		assert.equal(result.cacheHitRate, 80);
		assert.equal(result.cacheHitRateAvg, 80);
	});

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

	test("computes token-weighted session average across reported turns", () => {
		const result = accumulateSessionUsage([
			assistantEntry("one", assistantUsage({ input: 10, cacheRead: 90 })), // 100 prompt, 90 hit
			assistantEntry("two", assistantUsage({ input: 20, cacheRead: 80 })), // 100 prompt, 80 hit
			assistantEntry("three", assistantUsage({ cacheRead: 200, cacheWrite: 200 })), // 400 prompt, 200 hit
		]);
		assert.equal(result.cacheHitRate, 50);
		// token-weighted: (90 + 80 + 200) / (100 + 100 + 400) = 370 / 600 = 61.67
		assert.ok(Math.abs((result.cacheHitRateAvg ?? 0) - 61.666) < 0.01);
	});

	test("leaves the average undefined when no turn reports prompt tokens", () => {
		assert.equal(accumulateSessionUsage([]).cacheHitRateAvg, undefined);
		assert.equal(accumulateSessionUsage([assistantEntry("one", assistantUsage())]).cacheHitRateAvg, undefined);
	});

	test("excludes OpenAI subscription cost but keeps its CH", () => {
		const result = accumulateSessionUsage([
			assistantEntry("plan", assistantUsage({ input: 10, cacheRead: 90 }, 0.5), "openai-codex"),
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

test("routed response follows supplied branch and skips failures and aborts", () => {
	const routed = assistantEntry("routed", assistantUsage());
	assert.equal(routed.message.role, "assistant");
	if (routed.message.role !== "assistant") throw new Error("Expected assistant fixture");
	const failed: SessionMessageEntry = { ...routed, id: "failed", message: { ...routed.message, stopReason: "error" } };
	const aborted: SessionMessageEntry = {
		...routed,
		id: "aborted",
		message: { ...routed.message, stopReason: "aborted" },
	};
	assert.equal(latestAssistantResponse([routed, subscriptionMarker("routed"), failed, aborted]), routed.message);
	assert.equal(latestAssistantResponse([failed, aborted]), undefined);
	assert.equal(latestAssistantResponse([toolResultEntry("tool", assistantUsage())]), undefined);
	assert.equal(latestAssistantResponse([]), undefined);
});
