import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQuotaEvent, parseQuotaHeaders, responseQuotaKey, unexpiredQuota } from "./response-quota.ts";

const now = 1_800_000_000_000;
const future = now / 1000 + 3600;
const window = { used_percent: 0, reset_at: future, window_minutes: 300 };

test("response identity supports physical Responses APIs, not virtual or other APIs", () => {
	assert.equal(responseQuotaKey(undefined), undefined);
	const model = { provider: "proxy", api: "openai-codex-responses", id: "model", baseUrl: "https://proxy.test" };
	assert.ok(responseQuotaKey(model));
	assert.ok(responseQuotaKey({ ...model, api: "openai-responses" }));
	assert.equal(responseQuotaKey({ ...model, api: "pi-virtual" }), undefined);
	for (const change of [{ provider: "other" }, { id: "other" }, { baseUrl: "https://other.test" }])
		assert.notEqual(responseQuotaKey({ ...model, ...change }), responseQuotaKey(model));
});

test("headers are case-insensitive, keep real zero, and derive window labels from reported duration", () => {
	assert.deepEqual(
		parseQuotaHeaders(
			{
				"X-Codex-Primary-Used-Percent": "0",
				"x-codex-primary-reset-at": `${future}`,
				"x-codex-primary-window-minutes": "300",
				"x-codex-secondary-used-percent": "73.5",
				"x-codex-secondary-reset-at": `${future}`,
				"x-codex-secondary-window-minutes": "10080",
			},
			now,
		),
		{
			limits: [
				{ label: "5h", percent: 0, resetAt: future * 1000 },
				{ label: "7d", percent: 73.5, resetAt: future * 1000 },
			],
		},
	);
	assert.equal(parseQuotaHeaders({ "content-type": "text/event-stream" }, now), undefined);
	assert.deepEqual(parseQuotaHeaders({ "x-codex-primary-used-percent": "bad" }, now), { limits: [] });
});

test("stream snapshots replace windows and ignore other metered buckets and unrelated events", () => {
	assert.deepEqual(
		parseQuotaEvent({ type: "codex.rate_limits", rate_limits: { primary: window, review: window } }, now),
		{
			limits: [{ label: "5h", percent: 0, resetAt: future * 1000 }],
		},
	);
	for (const minutes of [undefined, 0, -1, "bad"])
		assert.equal(
			parseQuotaEvent(
				{ type: "codex.rate_limits", rate_limits: { secondary: { ...window, window_minutes: minutes } } },
				now,
			)?.limits[0]?.label,
			"",
		);
	assert.equal(
		parseQuotaEvent({ type: "codex.rate_limits", rate_limits: { primary: { ...window, window_minutes: 90 } } }, now)
			?.limits[0]?.label,
		"90m",
	);
	for (const data of [null, [], 1, {}, { type: "response.created" }])
		assert.equal(parseQuotaEvent(data, now), undefined);
	for (const rate_limits of [undefined, null, { review: window }, { primary: "bad" }])
		assert.deepEqual(parseQuotaEvent({ type: "codex.rate_limits", rate_limits }, now), { limits: [] });
});

test("malformed percentages and expired, missing or overflowing resets never become healthy zeroes", () => {
	for (const used_percent of [undefined, null, "", false, -1, 101, Number.NaN, Number.POSITIVE_INFINITY, "bad"])
		assert.deepEqual(
			parseQuotaEvent({ type: "codex.rate_limits", rate_limits: { primary: { ...window, used_percent } } }, now),
			{ limits: [] },
		);
	for (const reset_at of [undefined, "bad", 0, now / 1000, now / 1000 - 1, Number.MAX_VALUE])
		assert.deepEqual(
			parseQuotaEvent({ type: "codex.rate_limits", rate_limits: { primary: { ...window, reset_at } } }, now),
			{ limits: [] },
		);
});

test("expiry drops stale windows without mutating the snapshot and keeps reset credits plus windows without resetAt", () => {
	const quota = {
		limits: [
			{ label: "5h", percent: 42, resetAt: now + 1 },
			{ label: "", percent: 10 },
		],
		resetCredits: 2,
	};
	assert.equal(unexpiredQuota(quota, now), quota);
	assert.deepEqual(unexpiredQuota(quota, now + 1), {
		limits: [{ label: "", percent: 10 }],
		resetCredits: 2,
	});
	assert.deepEqual(unexpiredQuota({ limits: [{ label: "5h", percent: 42, resetAt: now }], resetCredits: 1 }, now), {
		limits: [],
		resetCredits: 1,
	});
	assert.equal(quota.limits.length, 2);
});
