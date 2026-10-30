import assert from "node:assert/strict";
import { test } from "node:test";
import { ASCII_GLYPHS, balanceRender, type ChromeStyles } from "./chrome.ts";
import type { BalanceInfo, BalanceUsage } from "./deepseek.ts";

const styles: ChromeStyles = { fg: (_token, text) => text };
const balance: BalanceInfo = { currency: "CNY", total: "20.50", granted: "5.00", toppedUp: "15.50" };
const usage: BalanceUsage = { available: true, balances: [balance] };

test("total balance is essential, nonzero gifts are spare-width detail already included in total", () => {
	assert.deepEqual(balanceRender(usage, styles), {
		essentials: [
			{ label: "Bal ¥20.50", upgrades: ["Bal ¥20.50 (gift ¥5.00)"] },
			{ label: "", upgrades: [] },
		],
	});
	for (const granted of ["0", "0.00", "000.00000000"])
		assert.deepEqual(
			balanceRender({ ...usage, balances: [{ ...balance, granted }] }, styles).essentials[0]?.upgrades,
			[],
		);
	assert.match(
		balanceRender({ ...usage, balances: [{ ...balance, granted: "0.00000001" }] }, styles).essentials[0]?.upgrades[0] ??
			"",
		/gift ¥0\.00000001/,
	);
});

test("keeps currencies distinct, uses ASCII currency codes, and marks API unavailability as failure", () => {
	const multi: BalanceUsage = {
		...usage,
		balances: [...usage.balances, { currency: "USD", total: "1.25", granted: "0.25", toppedUp: "1.00" }],
	};
	assert.equal(balanceRender(multi, styles).essentials[0]?.label, "Bal ¥20.50 / $1.25");
	assert.equal(
		balanceRender(multi, styles, ASCII_GLYPHS).essentials[0]?.upgrades[0],
		"Bal CNY 20.50 / USD 1.25 (gift CNY 5.00 / USD 0.25)",
	);
	const tokens: string[] = [];
	const colored: ChromeStyles = {
		fg: (token, text) => {
			tokens.push(token);
			return text;
		},
	};
	const unavailable = balanceRender(
		{ available: false, balances: [{ currency: "CNY", total: "-0.01", granted: "0.00", toppedUp: "-0.01" }] },
		colored,
	);
	assert.equal(unavailable.essentials[0]?.label, "Bal ¥-0.01 unavailable");
	assert.deepEqual(tokens, ["error"]);
});
