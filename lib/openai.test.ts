import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { openAiAccountId, parseOpenAiUsage } from "./openai.ts";

// Real /wham/usage response shape (2026-05, trimmed): primary 5h + secondary 7d windows, plan_type, optional credits.
const usagePayload = {
	plan_type: "plus",
	rate_limit: {
		primary_window: { used_percent: 6, reset_at: 1738300000, limit_window_seconds: 18000 },
		secondary_window: { used_percent: 24, reset_at: 1738900000, limit_window_seconds: 604800 },
	},
	credits: { has_credits: true, unlimited: false, balance: 5.39 },
};

const fakeJwt = (payload: unknown): string => `x.${Buffer.from(JSON.stringify(payload)).toString("base64")}.y`;

describe("parseOpenAiUsage", () => {
	test("parses the real wham/usage shape", () => {
		assert.deepEqual(parseOpenAiUsage(usagePayload), {
			weeklyPercent: undefined,
			limits: [
				{ label: "5h", percent: 6 },
				{ label: "7d", percent: 24 },
			],
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
