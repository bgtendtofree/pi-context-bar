import assert from "node:assert/strict";
import { describe, type TestContext, test } from "node:test";
import {
	fetchOpenAiUsage,
	fetchResetCredits,
	openAiAccountId,
	parseOpenAiUsage,
	parseResetCredits,
	redeemResetCredit,
	shouldRefreshQuota,
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

test("quota refresh throttle can be bypassed after a reset", () => {
	assert.equal(shouldRefreshQuota(0, 59_999), false);
	assert.equal(shouldRefreshQuota(0, 60_000), true);
	assert.equal(shouldRefreshQuota(59_999, 60_000, true), true);
});

const jsonResponse = (payload: unknown, status = 200): Response => new Response(JSON.stringify(payload), { status });

/** Stub global fetch for one test; node:test restores it on test end. */
const mockFetch = (t: TestContext, response: Response | (() => Response)): Array<{ url: unknown; init: unknown }> => {
	const calls: Array<{ url: unknown; init: unknown }> = [];
	t.mock.method(globalThis, "fetch", async (url: unknown, init: unknown) => {
		calls.push({ url, init });
		return typeof response === "function" ? response() : response;
	});
	return calls;
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

describe("parseResetCredits", () => {
	test("accepts a top-level array of credits", () => {
		assert.deepEqual(parseResetCredits([{ credit_id: "c1" }, { id: "c2" }, { credit_id: "c3", status: "available" }]), [
			{ id: "c1" },
			{ id: "c2" },
			{ id: "c3" },
		]);
	});

	test("unwraps common container keys", () => {
		assert.deepEqual(parseResetCredits({ credits: [{ credit_id: "c1" }] }), [{ id: "c1" }]);
		assert.deepEqual(parseResetCredits({ rate_limit_reset_credits: [{ id: "c2" }] }), [{ id: "c2" }]);
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
		assert.deepEqual(parseResetCredits(payload), [{ id: "keep" }]);
	});

	test("puts soonest-expiring reset first and unknown expiries last", () => {
		assert.deepEqual(
			parseResetCredits({
				credits: [
					{ id: "later", expires_at: "2026-08-01T00:00:00Z" },
					{ id: "unknown" },
					{ id: "soon", expires_at: "2026-07-01T00:00:00Z" },
				],
			}),
			[
				{ id: "soon", expiresAt: Date.parse("2026-07-01T00:00:00Z") },
				{ id: "later", expiresAt: Date.parse("2026-08-01T00:00:00Z") },
				{ id: "unknown" },
			],
		);
	});

	test("returns empty for garbage", () => {
		for (const payload of [undefined, null, 42, "nope", {}, { credits: "x" }, { other: [] }]) {
			assert.deepEqual(parseResetCredits(payload), []);
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
	test("fetchOpenAiUsage hits wham/usage with bearer + account id and parses windows", async (t) => {
		const calls = mockFetch(t, jsonResponse(usagePayload));
		const usage = await fetchOpenAiUsage(authedToken, "https://chatgpt.com/backend-api/codex/responses");
		assert.equal(usage.limits.length, 2);
		assert.equal(usage.resetCredits, 2);
		assert.equal(calls[0]?.url, "https://chatgpt.com/backend-api/wham/usage");
		const call = calls[0];
		assert.ok(call);
		const init = call.init as RequestInit;
		const headers = new Headers(init.headers);
		assert.equal(headers.get("Authorization"), `Bearer ${authedToken}`);
		assert.equal(headers.get("ChatGPT-Account-Id"), "acc_123");
		assert.equal(init.redirect, "manual");
		assert.ok(init.signal instanceof AbortSignal);
	});

	test("fetchResetCredits lists redeemable credits", async (t) => {
		const calls = mockFetch(t, jsonResponse([{ credit_id: "c1" }]));
		assert.deepEqual(await fetchResetCredits(authedToken), [{ id: "c1" }]);
		assert.equal(calls[0]?.url, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
	});

	test("redeemResetCredit posts an idempotent consume and returns the outcome code", async (t) => {
		const calls = mockFetch(t, jsonResponse({ code: "already_redeemed" }));
		const outcome = await redeemResetCredit(authedToken, "c1");
		assert.equal(outcome, "already_redeemed");
		assert.equal(calls[0]?.url, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
		const call = calls[0];
		assert.ok(call);
		const body = JSON.parse(String((call.init as RequestInit).body));
		assert.equal(body.credit_id, "c1");
		assert.ok(typeof body.redeem_request_id === "string" && body.redeem_request_id.length > 0);
	});

	test("redeemResetCredit does not claim success when response body lacks code", async (t) => {
		mockFetch(t, jsonResponse({}));
		assert.equal(await redeemResetCredit(authedToken, "c1"), "unknown");
	});

	test("redeemResetCredit reports unknown for a non-JSON success body", async (t) => {
		mockFetch(t, new Response("invalid JSON"));
		assert.equal(await redeemResetCredit(authedToken, "c1"), "unknown");
	});

	test("fetch failures throw", async (t) => {
		mockFetch(t, () => new Response(null, { status: 401 }));
		await assert.rejects(fetchOpenAiUsage(authedToken), /401/);
		await assert.rejects(fetchResetCredits(authedToken), /401/);
		await assert.rejects(redeemResetCredit(authedToken, "c1"), /401/);
	});

	test("tokens without an account id throw before any request", async (t) => {
		const calls = mockFetch(t, jsonResponse({}));
		await assert.rejects(fetchOpenAiUsage("bad-token"), /chatgpt_account_id/);
		assert.equal(calls.length, 0);
	});

	test("rejects custom, proxied, and malformed endpoints before sending credentials", async (t) => {
		const calls = mockFetch(t, jsonResponse(usagePayload));
		for (const baseUrl of [
			"https://evil.example/backend-api/codex/responses",
			"http://chatgpt.com/backend-api/codex/responses",
			"https://chatgpt.com.attacker.example/backend-api/codex/responses",
			"https://user@chatgpt.com/backend-api/codex/responses",
			"https://chatgpt.com/proxy/codex/responses",
			"https://chatgpt.com/backend-api/codex/responses?forward=1",
			"not a URL",
		]) {
			await assert.rejects(fetchOpenAiUsage(authedToken, baseUrl), /official ChatGPT endpoint/);
		}
		assert.equal(calls.length, 0);
	});

	test("does not follow redirects", async (t) => {
		const calls = mockFetch(
			t,
			() => new Response(null, { status: 302, headers: { Location: "https://evil.example/" } }),
		);
		await assert.rejects(fetchOpenAiUsage(authedToken), /OpenAI usage API 302/);
		const call = calls[0];
		assert.ok(call);
		assert.equal((call.init as RequestInit).redirect, "manual");
	});

	test("bounds response body size", async (t) => {
		mockFetch(t, new Response(new Uint8Array(64 * 1024 + 1)));
		await assert.rejects(fetchOpenAiUsage(authedToken), /response exceeds size limit/);
	});
});
