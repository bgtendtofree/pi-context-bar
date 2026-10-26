import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { identityStyles, markedStyles, usage } from "../test-support/chrome-fixtures.ts";
import { ASCII_GLYPHS, formatCost, formatDuration, metricOptions, NERD_GLYPHS } from "./chrome.ts";

describe("health metric formatting", () => {
	const full = usage({ cost: 1.61, cacheHitRate: 97.9 });

	test("formats cost with useful precision", () => {
		assert.equal(formatCost(0), "");
		assert.equal(formatCost(0.042), "$0.042");
		assert.equal(formatCost(1.61), "$1.61");
		// A sub-mill cost is real money; it must never round down to a misleading `$0.000`.
		assert.equal(formatCost(0.0004), "<$0.001");
		assert.equal(formatCost(0.001), "$0.001");
		assert.equal(formatCost(Number.NaN), "");
		assert.equal(formatCost(Number.POSITIVE_INFINITY), "");
	});

	test("formats remaining time for quota windows and resets", () => {
		const now = Date.parse("2026-07-01T00:00:00Z");
		const left = (iso: string): number => Date.parse(iso) - now;
		assert.equal(formatDuration(left("2026-07-01T00:12:00Z")), "12m");
		assert.equal(formatDuration(left("2026-07-01T05:10:00Z")), "5h 10m");
		assert.equal(formatDuration(left("2026-07-03T03:30:00Z")), "2d 3h");
		assert.equal(formatDuration(0), "expired");
		assert.equal(formatDuration(-1), "expired");
		for (const ms of [1, 30_000, 59_999]) assert.equal(formatDuration(ms), "<1m");
		assert.equal(formatDuration(60_000), "1m");
		// Whole hours and days drop the zero component instead of printing "6h 0m".
		assert.equal(formatDuration(left("2026-07-01T06:00:00Z")), "6h");
		assert.equal(formatDuration(left("2026-07-02T00:00:00Z")), "1d");
		assert.equal(formatDuration(left("2026-07-04T01:00:00Z")), "3d 1h");
		// Non-finite input must not leak a `NaNd NaNh` reading into the border.
		assert.equal(formatDuration(Number.NaN), "expired");
		assert.equal(formatDuration(Number.POSITIVE_INFINITY), "expired");
	});

	test("builds wide and narrow options", () => {
		const nerd = metricOptions(full, identityStyles, NERD_GLYPHS);
		assert.equal(nerd[0]?.decorated, `${NERD_GLYPHS.cache} 98%  $1.61`);
		assert.equal(nerd[0]?.plain, "CH98%  $1.61");
		assert.equal(nerd[1]?.decorated, `${NERD_GLYPHS.cache} 98%`);
		assert.equal(nerd[1]?.plain, "CH98%");
		const ascii = metricOptions(full, identityStyles, ASCII_GLYPHS);
		assert.equal(ascii[0]?.plain, "CH98%  $1.61");
		assert.equal(ascii[1]?.plain, "CH98%");
		// Last option is the empty reading used when no metric fits at all.
		assert.equal(nerd.at(-1)?.plain, "");
	});

	test("never falls back to an unlabelled cache percentage", () => {
		// A bare `98%` cannot be identified as cache; the icon replaces the `CH` label at equal width,
		// so dropping the icon leaves the label in place.
		for (const glyphs of [NERD_GLYPHS, ASCII_GLYPHS]) {
			for (const cacheHitRateAvg of [undefined, 92]) {
				const options = metricOptions({ cost: 1.61, cacheHitRate: 98, cacheHitRateAvg }, identityStyles, glyphs);
				for (const option of options) if (option.plain !== "") assert.ok(option.plain.includes("CH98"), option.plain);
			}
			const [widest] = metricOptions({ cost: 0, cacheHitRate: 98, cacheHitRateAvg: 92 }, identityStyles, glyphs);
			assert.equal(visibleWidth(widest?.decorated ?? ""), visibleWidth(widest?.plain ?? ""));
		}
	});

	test("keeps cost when cache is unknown", () => {
		for (const glyphs of [NERD_GLYPHS, ASCII_GLYPHS]) {
			const options = metricOptions(usage({ cost: 0.042 }), identityStyles, glyphs);
			assert.equal(options[0]?.plain, "$0.042");
			assert.equal(options[0]?.decorated, "$0.042");
			assert.equal(
				options.every((option) => !option.plain.includes("CH") && !option.plain.includes(NERD_GLYPHS.cache)),
				true,
			);
		}
	});
});

describe("semantic metric styling", () => {
	test("keeps healthy cache quiet", () => {
		const nerd = metricOptions(usage({ cost: 6.65, cacheHitRate: 99 }), markedStyles, NERD_GLYPHS)[0]?.decorated ?? "";
		assert.ok(nerd.includes(`<dim>${NERD_GLYPHS.cache} 99</dim>%`));
		assert.ok(!nerd.includes("<warning>"));
		assert.ok(!nerd.includes("<error>"));
		const ascii =
			metricOptions(usage({ cost: 6.65, cacheHitRate: 99 }), markedStyles, ASCII_GLYPHS)[0]?.decorated ?? "";
		assert.ok(ascii.includes("<dim>CH99</dim>%"));
	});

	test("rounds the cache rate once so the label and its color agree", () => {
		const healthy = metricOptions(usage({ cacheHitRate: 79.6 }), markedStyles, ASCII_GLYPHS)[0]?.decorated ?? "";
		assert.ok(healthy.includes("<dim>CH80</dim>%"));
		const warning = metricOptions(usage({ cacheHitRate: 49.6 }), markedStyles, ASCII_GLYPHS)[0]?.decorated ?? "";
		assert.ok(warning.includes("<warning>CH50</warning>%"));
	});

	test("accents only unhealthy cache", () => {
		const warning = metricOptions(usage({ cacheHitRate: 60 }), markedStyles, ASCII_GLYPHS)[0]?.decorated ?? "";
		assert.ok(warning.includes("<warning>CH60</warning>%"));
		const error = metricOptions(usage({ cacheHitRate: 20 }), markedStyles, ASCII_GLYPHS)[0]?.decorated ?? "";
		assert.ok(error.includes("<error>CH20</error>%"));
		assert.equal(metricOptions(usage(), markedStyles, ASCII_GLYPHS)[0]?.decorated, "");
	});
});

describe("CH session average", () => {
	test("joins the token-weighted average when it diverges by more than 5 points", () => {
		const ascii = metricOptions(usage({ cacheHitRate: 98, cacheHitRateAvg: 92 }), identityStyles, ASCII_GLYPHS);
		assert.equal(stripVTControlCharacters(ascii[0]?.decorated ?? ""), "CH98/92%");
		const nerd = metricOptions(usage({ cacheHitRate: 98, cacheHitRateAvg: 92 }), identityStyles, NERD_GLYPHS);
		assert.equal(stripVTControlCharacters(nerd[0]?.decorated ?? ""), `${NERD_GLYPHS.cache} 98/92%`);
	});

	test("stays latest-only when the average is close or unknown", () => {
		assert.equal(
			metricOptions(usage({ cacheHitRate: 98, cacheHitRateAvg: 96 }), identityStyles, ASCII_GLYPHS)[0]?.decorated,
			"CH98%",
		);
		assert.equal(
			metricOptions(usage({ cacheHitRate: 98, cacheHitRateAvg: 98.2 }), identityStyles, ASCII_GLYPHS)[0]?.decorated,
			"CH98%",
		);
		assert.equal(metricOptions(usage({ cacheHitRate: 98 }), identityStyles, ASCII_GLYPHS)[0]?.decorated, "CH98%");
	});

	test("drops the database icon before the average", () => {
		const [widest] = metricOptions(usage({ cacheHitRate: 98, cacheHitRateAvg: 92 }), identityStyles, NERD_GLYPHS);
		assert.equal(widest?.decorated, `${NERD_GLYPHS.cache} 98/92%`);
		assert.equal(widest?.plain, "CH98/92%");
		assert.equal(visibleWidth(widest?.plain ?? ""), visibleWidth("CH98/92%"));
	});

	test("keeps the latest-turn color on CH and styles the average dim", () => {
		const widest =
			metricOptions(usage({ cacheHitRate: 20, cacheHitRateAvg: 60 }), markedStyles, ASCII_GLYPHS)[0]?.decorated ?? "";
		assert.ok(widest.includes("<error>CH20</error>"));
		assert.ok(widest.includes("<dim>/60</dim>%"));
	});
});
