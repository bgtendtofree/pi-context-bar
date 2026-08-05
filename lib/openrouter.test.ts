import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fetchOpenRouterBalance, parseOpenRouterKey } from "./openrouter.ts";

describe("OpenRouter key balance parsing", () => {
	test("parses a limited key into balance, spent, and limit percent", () => {
		const quota = parseOpenRouterKey({
			data: { label: "My Key", usage: 3.25, limit: 10, limit_remaining: 6.75, limit_reset: "weekly" },
		});
		assert.equal(quota.weeklyPercent, undefined);
		assert.equal(quota.balanceDollars, 6.75);
		assert.equal(quota.spentDollars, undefined);
		assert.deepEqual(quota.limits, [{ label: "7d", percent: 32.5 }]);
	});

	test("unlimited key reports usage as spent with no balance", () => {
		const quota = parseOpenRouterKey({
			data: { label: "K", usage: 3.25, limit: null, limit_remaining: null, limit_reset: null },
		});
		assert.equal(quota.balanceDollars, undefined);
		assert.equal(quota.spentDollars, 3.25);
		assert.deepEqual(quota.limits, []);
	});

	test("limited key with unknown remaining keeps the limit quiet", () => {
		const quota = parseOpenRouterKey({
			data: { label: "K", usage: 1, limit: 10, limit_remaining: null, limit_reset: "daily" },
		});
		assert.equal(quota.balanceDollars, undefined);
		assert.equal(quota.spentDollars, undefined);
		assert.deepEqual(quota.limits, []);
	});

	test("ignores malformed payloads", () => {
		assert.deepEqual(parseOpenRouterKey(null), { weeklyPercent: undefined, limits: [] });
		assert.deepEqual(parseOpenRouterKey({}), { weeklyPercent: undefined, limits: [] });
	});

	test("maps reset windows to short labels", () => {
		const key = (reset: unknown) => ({
			data: { label: "K", usage: 1, limit: 10, limit_remaining: 5, limit_reset: reset },
		});
		assert.deepEqual(parseOpenRouterKey(key("daily")).limits, [{ label: "1d", percent: 50 }]);
		assert.deepEqual(parseOpenRouterKey(key("monthly")).limits, [{ label: "1mo", percent: 50 }]);
		assert.deepEqual(parseOpenRouterKey(key(null)).limits, [{ label: "key", percent: 50 }]);
	});

	test("fetch failures throw", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = () => Promise.resolve(new Response(null, { status: 401 }));
		try {
			await assert.rejects(() => fetchOpenRouterBalance("k", "https://openrouter.ai/api/v1"));
		} finally {
			globalThis.fetch = original;
		}
	});

	test("fetch success parses the payload", async () => {
		const original = globalThis.fetch;
		globalThis.fetch = () =>
			Promise.resolve(
				new Response(JSON.stringify({ data: { label: "K", usage: 3.25, limit: 10, limit_remaining: 6.75 } }), {
					status: 200,
				}),
			);
		try {
			const quota = await fetchOpenRouterBalance("k", "https://openrouter.ai/api/v1/");
			assert.equal(quota.balanceDollars, 6.75);
		} finally {
			globalThis.fetch = original;
		}
	});
});
