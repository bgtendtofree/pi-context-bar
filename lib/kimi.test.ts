import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseKimiUsage } from "./kimi.ts";

// Real /usages response shape (2026-08, trimmed): string numbers, ISO resetTime, window/detail pairs.
const usagesPayload = {
	usage: { limit: "100", used: "33", remaining: "67", resetTime: "2026-08-04T19:05:48.483520Z" },
	limits: [
		{
			window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
			detail: { limit: "100", used: "26", remaining: "74", resetTime: "2026-07-31T17:05:48.483520Z" },
		},
		{
			window: { duration: 1, timeUnit: "TIME_UNIT_DAY" },
			detail: { limit: "100", used: "95", remaining: "5" },
		},
	],
};

describe("parseKimiUsage", () => {
	test("parses the real usage + limits shape", () => {
		const usage = parseKimiUsage(usagesPayload);
		assert.equal(usage.weeklyPercent, 33);
		assert.deepEqual(usage.limits, [
			{ label: "5h", percent: 26 },
			{ label: "1d", percent: 95 },
		]);
	});

	test("matches enum-style units by substring and converts seconds", () => {
		const usage = parseKimiUsage({
			limits: [
				{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { used: 19, limit: 100 } },
				{ window: { duration: 90, timeUnit: "TIME_UNIT_SECOND" }, detail: { used: 1, limit: 10 } },
			],
		});
		assert.equal(usage.weeklyPercent, undefined);
		assert.deepEqual(usage.limits, [
			{ label: "5h", percent: 19 },
			{ label: "90s", percent: 10 },
		]);
	});

	test("accepts bare limit rows and snake_case unit fields", () => {
		const usage = parseKimiUsage({ limits: [{ used: "1", limit: "4", duration: "90", time_unit: "minute" }] });
		assert.deepEqual(usage.limits, [{ label: "90m", percent: 25 }]);
	});

	test("skips rows without usable numbers and falls back to row names", () => {
		const usage = parseKimiUsage({
			usage: {},
			limits: [{ detail: { name: "burst", used: 1, limit: 2 } }, { detail: { used: 1, limit: 0 } }],
		});
		assert.equal(usage.weeklyPercent, undefined);
		assert.deepEqual(usage.limits, [{ label: "burst", percent: 50 }]);
	});

	test("returns empty usage for garbage", () => {
		for (const payload of [undefined, null, 42, "nope", [], { data: [] }]) {
			assert.deepEqual(parseKimiUsage(payload), { weeklyPercent: undefined, limits: [] });
		}
	});
});
