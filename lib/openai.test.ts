import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	fetchOpenAiUsage,
	fetchResetCreditIds,
	openAiAccountId,
	parseOpenAiUsage,
	parseResetCreditIds,
	redeemResetCredit,
} from "./openai.ts";

// Real /wham/usage response shape (2026-05, trimmed): primary 5h + secondary 7d windows, plan_type, optional credits.
const usagePayload = {
	plan_type: "plus",
	rate_limit: {
		primary_window: { used_percent: 6, reset_at: 1738300000, limit_window_seconds: 18000 },
		secondary_window: { used_percent: 24, reset_at: 1738900000, limit_window_seconds: 604800 },
	},
	credits: { has_credits: true, unlimited: false, balance: 5.39 },
	rate_limit_reset_credits: { available_count: 2 },
};

const fakeJwt = (payload: unknown): string => `x.${Buffer.from(JSON.stringify(payload)).toString("base64")}.y`;

const authedToken = fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_123" } });

type MockResponse = Readonly<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;

const withMockFetch = async (
	response: MockResponse,
	run: (calls: Array<{ url: unknown; init: unknown }>) => Promise<void>,
): Promise<void> => {
	const original = globalThis.fetch;
	const calls: Array<{ url: unknown; init: unknown }> = [];
	globalThis.fetch = (async (url: unknown, init: unknown) => {
		calls.push({ url, init });
		return response;
	}) as typeof fetch;
	try {
		await run(calls);
	} finally {
		globalThis.fetch = original;
	}
};

describe("parseOpenAiUsage", () => {
	test("parses the real wham/usage shape", () => {
		assert.deepEqual(parseOpenAiUsage(usagePayload), {
			weeklyPercent: undefined,
			limits: [
				{ label: "5h", percent: 6 },
				{ label: "7d", percent: 24 },
			],
			resetCredits: 2,
		});
	});

	test("converts window seconds to labels", () => {
		const usage = parseOpenAiUsage({
			rate_limit: {
				primary_window: { used_percent: 10, limit_window_seconds: 900 },
				secondary_window: { used_percent: 20, limit_window_seconds: 45 },
			},
		});
		assert.deepEqual(usage.limits, [
			{ label: "15m", percent: 10 },
			{ label: "45s", percent: 20 },
		]);
	});

	test("survives a missing secondary window and string numbers", () => {
		const usage = parseOpenAiUsage({
			rate_limit: { primary_window: { used_percent: "50", limit_window_seconds: "3600" } },
		});
		assert.deepEqual(usage.limits, [{ label: "1h", percent: 50 }]);
	});

	test("skips windows without usable percent and labels by position", () => {
		const usage = parseOpenAiUsage({
			rate_limit: {
				primary_window: { limit_window_seconds: 18000 },
				secondary_window: { used_percent: 5 },
			},
		});
		assert.deepEqual(usage.limits, [{ label: "L2", percent: 5 }]);
	});

	test("returns empty usage for garbage", () => {
		for (const payload of [undefined, null, 42, "nope", [], { rate_limit: "x" }]) {
			assert.deepEqual(parseOpenAiUsage(payload), { weeklyPercent: undefined, limits: [] });
		}
	});
});

describe("parseResetCreditIds", () => {
	test("accepts a top-level array of credits", () => {
		assert.deepEqual(
			parseResetCreditIds([{ credit_id: "c1" }, { id: "c2" }, { credit_id: "c3", status: "available" }]),
			["c1", "c2", "c3"],
		);
	});

	test("unwraps common container keys", () => {
		assert.deepEqual(parseResetCreditIds({ credits: [{ credit_id: "c1" }] }), ["c1"]);
		assert.deepEqual(parseResetCreditIds({ rate_limit_reset_credits: [{ id: "c2" }] }), ["c2"]);
	});

	test("skips spent credits and entries without ids", () => {
		const payload = [
			{ credit_id: "used", status: "consumed" },
			{ credit_id: "gone", status: "Redeemed" },
			{ credit_id: "old", status: "expired" },
			{ status: "available" },
			"junk",
			{ credit_id: "keep", status: "available" },
		];
		assert.deepEqual(parseResetCreditIds(payload), ["keep"]);
	});

	test("returns empty for garbage", () => {
		for (const payload of [undefined, null, 42, "nope", {}, { credits: "x" }, { other: [] }]) {
			assert.deepEqual(parseResetCreditIds(payload), []);
		}
	});
});

describe("openAiAccountId", () => {
	test("extracts chatgpt_account_id from the namespaced claim", () => {
		const token = fakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_123" } });
		assert.equal(openAiAccountId(token), "acc_123");
	});

	test("rejects tokens without the claim", () => {
		assert.equal(openAiAccountId(fakeJwt({ sub: "user" })), undefined);
		assert.equal(openAiAccountId(fakeJwt({ "https://api.openai.com/auth": {} })), undefined);
	});

	test("rejects malformed tokens", () => {
		assert.equal(openAiAccountId("not-a-jwt"), undefined);
		assert.equal(openAiAccountId("x.!!!.y"), undefined);
	});
});

describe("openai fetch functions", () => {
	test("fetchOpenAiUsage hits wham/usage with bearer + account id and parses windows", async () => {
		await withMockFetch({ ok: true, json: async () => usagePayload }, async (calls) => {
			const usage = await fetchOpenAiUsage(authedToken, "https://chatgpt.com/backend-api/codex/responses");
			assert.equal(usage.limits.length, 2);
			assert.equal(usage.resetCredits, 2);
			assert.equal(calls[0]?.url, "https://chatgpt.com/backend-api/wham/usage");
			const headers = (calls[0] as { init: { headers: Record<string, string> } }).init.headers;
			assert.equal(headers.Authorization, `Bearer ${authedToken}`);
			assert.equal(headers["ChatGPT-Account-Id"], "acc_123");
		});
	});

	test("fetchResetCreditIds lists redeemable credits", async () => {
		await withMockFetch({ ok: true, json: async () => [{ credit_id: "c1" }] }, async (calls) => {
			assert.deepEqual(await fetchResetCreditIds(authedToken), ["c1"]);
			assert.equal(calls[0]?.url, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
		});
	});

	test("redeemResetCredit posts an idempotent consume and returns the outcome code", async () => {
		await withMockFetch({ ok: true, json: async () => ({ code: "already_redeemed" }) }, async (calls) => {
			const outcome = await redeemResetCredit(authedToken, "c1");
			assert.equal(outcome, "already_redeemed");
			assert.equal(calls[0]?.url, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
			const body = JSON.parse(String((calls[0] as { init: { body: string } }).init.body));
			assert.equal(body.credit_id, "c1");
			assert.ok(typeof body.redeem_request_id === "string" && body.redeem_request_id.length > 0);
		});
	});

	test("redeemResetCredit defaults to reset when the body has no code", async () => {
		await withMockFetch({ ok: true, json: async () => ({}) }, async () => {
			assert.equal(await redeemResetCredit(authedToken, "c1"), "reset");
		});
	});

	test("fetch failures throw", async () => {
		await withMockFetch({ ok: false, status: 401, json: async () => ({}) }, async () => {
			await assert.rejects(fetchOpenAiUsage(authedToken), /401/);
			await assert.rejects(fetchResetCreditIds(authedToken), /401/);
			await assert.rejects(redeemResetCredit(authedToken, "c1"), /401/);
		});
	});

	test("tokens without an account id throw before any request", async () => {
		await withMockFetch({ ok: true, json: async () => ({}) }, async (calls) => {
			await assert.rejects(fetchOpenAiUsage("bad-token"), /chatgpt_account_id/);
			assert.equal(calls.length, 0);
		});
	});
});
