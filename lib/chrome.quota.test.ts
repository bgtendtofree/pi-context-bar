import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { identityStyles, markedStyles } from "../test-support/chrome-fixtures.ts";
import { ASCII_GLYPHS, NERD_GLYPHS, type QuotaLimit, type QuotaUsage, quotaRender } from "./chrome.ts";

describe("quota rendering", () => {
	const now = Date.parse("2026-07-01T00:00:00Z");
	const reset = (label: string, percent: number, minutes = 150): QuotaLimit => ({
		label,
		percent,
		resetAt: now + minutes * 60_000,
	});
	const full: QuotaUsage = {
		limits: [
			{ label: "5h", percent: 30 },
			{ label: "1d", percent: 12 },
		],
	};
	const plain = (values: readonly string[]): readonly string[] => values.map(stripVTControlCharacters);
	const labels = (render: ReturnType<typeof quotaRender>): readonly string[] =>
		plain(render.essentials.map((option) => option.label));
	const upgrades = (render: ReturnType<typeof quotaRender>): readonly string[] =>
		plain(render.essentials[0]?.upgrades ?? []);

	test("healthy windows are percentage-only essentials with no upgrades", () => {
		const render = quotaRender({ limits: [reset("5h", 53), reset("7d", 43)] }, identityStyles, now);
		assert.deepEqual(labels(render), ["5h 53%  7d 43%", "5h 53%", "7d 43%", ""]);
		assert.deepEqual(upgrades(render), []);
	});

	test("only a window above the warning threshold upgrades to its countdown", () => {
		const render = quotaRender({ limits: [reset("5h", 75), reset("7d", 43)] }, identityStyles, now);
		assert.deepEqual(labels(render), ["5h 75%  7d 43%", "5h 75%", "7d 43%", ""]);
		assert.deepEqual(upgrades(render), ["5h 75% 󰦛 2h 30m  7d 43%"]);
	});

	test("keeps the most-used window when the whole group cannot fit", () => {
		// Narrow borders narrow the group instead of dropping quota entirely: highest used percent first,
		// equal percentages keeping the provider's order.
		const render = quotaRender({ limits: [reset("7d", 43), reset("5h", 53)] }, identityStyles, now);
		assert.deepEqual(labels(render), ["7d 43%  5h 53%", "5h 53%", "7d 43%", ""]);
		const tied = quotaRender({ limits: [reset("7d", 43), reset("5h", 43)] }, identityStyles, now);
		assert.deepEqual(labels(tied), ["7d 43%  5h 43%", "7d 43%", "5h 43%", ""]);
	});

	test("a narrowed window only ever shows its own countdown", () => {
		const render = quotaRender({ limits: [reset("5h", 43), reset("7d", 75)] }, identityStyles, now);
		const [whole, high, low] = render.essentials;
		assert.deepEqual(plain([whole?.label ?? ""]), ["5h 43%  7d 75%"]);
		assert.deepEqual(plain([high?.label ?? ""]), ["7d 75%"]);
		assert.deepEqual(plain(high?.upgrades ?? []), ["7d 75% 󰦛 2h 30m"]);
		// The quiet sibling has no countdown of its own, so its reading cannot borrow the other one's.
		assert.deepEqual(plain([low?.label ?? ""]), ["5h 43%"]);
		assert.deepEqual(plain(low?.upgrades ?? []), []);
	});

	test("treats exactly 70 as quiet and 70.01/90 as high", () => {
		for (const [percent, upgraded] of [
			[70, false],
			[70.01, true],
			[90, true],
		] as const) {
			const render = quotaRender({ limits: [reset("5h", percent)] }, identityStyles, now);
			assert.equal((render.essentials[0]?.upgrades.length ?? 0) > 0, upgraded, String(percent));
		}
	});

	test("counts every reported window toward the high check", () => {
		const high = quotaRender({ limits: [reset("5h", 10), reset("7d", 71)], resetCredits: 2 }, identityStyles, now);
		assert.deepEqual(plain([high.essentials[0]?.label ?? ""]), ["5h 10%  7d 71%"]);
		// Only the second window is high, so the banked credits stay visible from that alone.
		assert.ok((high.essentials[0]?.upgrades ?? []).some((value) => value.includes("󰔖")));
		// No window above the threshold keeps the same credits hidden.
		const quiet = quotaRender({ limits: [reset("5h", 10)], resetCredits: 2 }, identityStyles, now);
		assert.deepEqual(upgrades(quiet), []);
	});

	test("hides the countdown for missing or expired resets", () => {
		const missing = quotaRender({ limits: [{ label: "5h", percent: 80 }] }, identityStyles, now);
		assert.deepEqual(plain([missing.essentials[0]?.label ?? ""]), ["5h 80%"]);
		assert.deepEqual(upgrades(missing), []);
		const expired = quotaRender({ limits: [{ label: "5h", percent: 80, resetAt: now - 1000 }] }, identityStyles, now);
		assert.deepEqual(plain([expired.essentials[0]?.label ?? ""]), ["5h 80%"]);
		assert.deepEqual(upgrades(expired), []);
	});

	test("shows credits only while a reported quota is above the warning threshold", () => {
		const high = quotaRender({ limits: [reset("5h", 75)], resetCredits: 3 }, identityStyles, now);
		assert.deepEqual(upgrades(high), ["5h 75% 󰦛 2h 30m  󰔖 3", "5h 75% 󰦛 2h 30m", "5h 75%  󰔖 3"]);
		const healthy = quotaRender({ ...full, resetCredits: 3 }, identityStyles, now);
		assert.deepEqual(labels(healthy), ["5h 30%  1d 12%", "5h 30%", "1d 12%", ""]);
		assert.deepEqual(upgrades(healthy), []);
		const zero = quotaRender({ limits: [reset("5h", 75)], resetCredits: 0 }, identityStyles, now);
		assert.ok((zero.essentials[0]?.upgrades ?? []).every((value) => !value.includes("󰔖")));
		const unknown = quotaRender({ limits: [reset("5h", 75)] }, identityStyles, now);
		assert.ok((unknown.essentials[0]?.upgrades ?? []).every((value) => !value.includes("󰔖")));
	});

	test("keeps window percentages essential while countdowns and credits upgrade", () => {
		const render = quotaRender({ limits: [reset("5h", 92), reset("7d", 43)], resetCredits: 1 }, identityStyles, now);
		assert.ok(render.essentials.every((option) => !option.label.includes("󰦛") && !option.label.includes("󰔖")));
		assert.ok(render.essentials[0]?.label.includes("5h 92%") && render.essentials[0]?.label.includes("7d 43%"));
		const richest = render.essentials[0]?.upgrades[0] ?? "";
		assert.ok(richest.includes("󰦛") && richest.includes("󰔖"));
	});

	test("uses ASCII tokens without spacing and Nerd glyphs with spacing", () => {
		const usage: QuotaUsage = { limits: [reset("5h", 75)], resetCredits: 2 };
		const ascii = quotaRender(usage, identityStyles, now, ASCII_GLYPHS);
		assert.equal(stripVTControlCharacters(ascii.essentials[0]?.upgrades[0] ?? ""), "5h 75% r2h 30m  R2");
		const nerd = quotaRender(usage, identityStyles, now, NERD_GLYPHS);
		assert.equal(stripVTControlCharacters(nerd.essentials[0]?.upgrades[0] ?? ""), "5h 75% 󰦛 2h 30m  󰔖 2");
		assert.ok(!readFileSync(new URL("./chrome.ts", import.meta.url), "utf8").includes("↻"));
	});

	test("offers the combined essential and an empty fallback for a quiet session", () => {
		const render = quotaRender(full, identityStyles);
		assert.deepEqual(labels(render), ["5h 30%  1d 12%", "5h 30%", "1d 12%", ""]);
		assert.deepEqual(upgrades(render), []);
		assert.deepEqual(labels(quotaRender({ limits: [] }, identityStyles)), [""]);
	});

	test("escalates color with usage level", () => {
		const render = quotaRender(
			{
				limits: [
					{ label: "5h", percent: 95 },
					{ label: "7d", percent: 80 },
				],
			},
			markedStyles,
		);
		assert.equal(render.essentials[0]?.label, "<error>5h 95%</error><dim>  </dim><warning>7d 80%</warning>");
	});

	test("keeps quiet quota dim", () => {
		assert.equal(
			quotaRender(full, markedStyles).essentials[0]?.label,
			"<dim>5h 30%</dim><dim>  </dim><dim>1d 12%</dim>",
		);
	});

	test("keeps quota lane dollar-free: limit percent renders, balance data never shown", () => {
		const render = quotaRender({ limits: [{ label: "7d", percent: 32.5 }] }, identityStyles);
		assert.deepEqual(labels(render), ["7d 33%", ""]);
	});
});
