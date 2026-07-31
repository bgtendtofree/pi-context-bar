import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ChromeStyles } from "./chrome.ts";
import { type KimiUsage, kimiMetricOptions, parseKimiUsage } from "./kimi.ts";

const identityStyles: ChromeStyles = {
	dim: (text) => text,
	warning: (text) => text,
	error: (text) => text,
};

const markedStyles: ChromeStyles = {
	dim: (text) => `<d>${text}</d>`,
	warning: (text) => `<w>${text}</w>`,
	error: (text) => `<e>${text}</e>`,
};

const usagesPayload = {
	data: [
		{ model_name: "all", used: 40, limit: 100 },
		{ model_name: "k2", used: 30, limit: 100, duration: 300, timeUnit: "MINUTE" },
		{ model_name: "k2", used: 95, limit: 100, duration: 1, timeUnit: "DAY" },
	],
};

describe("parseKimiUsage", () => {
	test("parses the /usages data-array shape", () => {
		const usage = parseKimiUsage(usagesPayload);
		assert.equal(usage.weeklyPercent, 40);
		assert.deepEqual(usage.limits, [
			{ label: "5h", percent: 30 },
			{ label: "1d", percent: 95 },
		]);
	});

	test("matches enum-style units by substring and converts seconds", () => {
		const usage = parseKimiUsage({
			data: [
				{ model_name: "all", used: 32, limit: 100 },
				{ used: 19, limit: 100, duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
				{ used: 1, limit: 10, duration: 90, timeUnit: "TIME_UNIT_SECOND" },
			],
		});
		assert.deepEqual(usage.limits, [
			{ label: "5h", percent: 19 },
			{ label: "90s", percent: 10 },
		]);
	});

	test("handles string numbers and alternate unit field names", () => {
		const usage = parseKimiUsage({
			data: [{ used: "1", limit: "4", duration: "90", time_unit: "minute" }],
		});
		assert.equal(usage.weeklyPercent, undefined);
		assert.deepEqual(usage.limits, [{ label: "90m", percent: 25 }]);
	});

	test("skips rows without usable numbers and falls back to row names", () => {
		const usage = parseKimiUsage({
			data: [{ model_name: "all" }, { name: "burst", used: 1, limit: 2 }, { used: 1, limit: 0 }],
		});
		assert.equal(usage.weeklyPercent, undefined);
		assert.deepEqual(usage.limits, [{ label: "burst", percent: 50 }]);
	});

	test("returns empty usage for garbage", () => {
		for (const payload of [undefined, null, 42, "nope", [], { usage: { used: 1, limit: 2 } }]) {
			assert.deepEqual(parseKimiUsage(payload), { weeklyPercent: undefined, limits: [] });
		}
	});
});

describe("kimiMetricOptions", () => {
	const full: KimiUsage = {
		weeklyPercent: 40,
		limits: [
			{ label: "5h", percent: 30 },
			{ label: "1d", percent: 12 },
		],
	};

	test("offers widest to tightest variants", () => {
		const options = kimiMetricOptions(full, identityStyles).map(stripVTControlCharacters);
		assert.deepEqual(options, ["W40% 5h30% 1d12%", "W40%", ""]);
	});

	test("skips the combined variant when weekly is unknown", () => {
		const options = kimiMetricOptions({ weeklyPercent: undefined, limits: full.limits }, identityStyles);
		assert.equal(stripVTControlCharacters(options[0] ?? ""), "5h30% 1d12%");
		assert.equal(options[1], "");
	});

	test("escalates color with usage level", () => {
		const options = kimiMetricOptions({ weeklyPercent: 95, limits: [{ label: "5h", percent: 80 }] }, markedStyles);
		assert.equal(options[0], "<e>W95%</e><d> </d><w>5h80%</w>");
	});

	test("keeps quiet quota dim", () => {
		assert.equal(kimiMetricOptions(full, markedStyles)[1], "<d>W40%</d>");
	});
});
