import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ASCII_GLYPHS, NERD_GLYPHS } from "../lib/chrome.ts";
import { buildFramedEditor } from "../test-support/editor-harness.ts";
import type { HealthState } from "./framed-editor.ts";

const health: HealthState = {
	snapshot: { usedTokens: 20000, contextWindow: 100000 },
	usage: { cost: 1.61, cacheHitRate: 98, cacheHitRateAvg: 98 },
	quota: undefined,
	balance: { available: true, balances: [{ currency: "CNY", total: "20.50", granted: "5.00", toppedUp: "15.50" }] },
	speed: null,
	frame: 0,
	activity: "idle",
	prompt: "success",
};

test("balances share the quota slot; gifts drop before total, cache, or cost without adding rows", () => {
	for (const glyphs of [NERD_GLYPHS, ASCII_GLYPHS]) {
		const model = { id: "ds", reasoning: false };
		const editor = buildFramedEditor(glyphs, model, health);
		const noGift = buildFramedEditor(glyphs, model, {
			...health,
			balance: { available: true, balances: [{ currency: "CNY", total: "20.50", granted: "0.00", toppedUp: "20.50" }] },
		});
		let sawNarrow = false;
		for (let width = 16; width <= 140; width++) {
			const rows = editor.render(width);
			const line = stripVTControlCharacters(rows.at(-1) ?? "");
			const baseRows = noGift.render(width);
			const base = stripVTControlCharacters(baseRows.at(-1) ?? "");
			assert.equal(rows.length, baseRows.length);
			assert.equal(visibleWidth(line), width);
			for (const reading of ["ds", "Bal", "20.50", "98%", "$1.61"])
				if (base.includes(reading)) assert.ok(line.includes(reading), `${width}: ${line}`);
			if (line.includes("Bal") && line.includes("$1.61") && !line.includes("gift")) sawNarrow = true;
			assert.doesNotMatch(base, /gift/);
		}
		assert.ok(sawNarrow);
		const wide = stripVTControlCharacters(editor.render(140).at(-1) ?? "");
		assert.match(wide, glyphs.ascii ? /Bal CNY 20\.50 \(gift CNY 5\.00\)/ : /Bal ¥20\.50 \(gift ¥5\.00\)/);
		assert.match(wide, /\$1\.61/);
	}
});

test("balance snapshot changes invalidate the same editor's bottom memo", () => {
	const editor = buildFramedEditor(NERD_GLYPHS, { id: "ds", reasoning: false }, health);
	const bottom = () => stripVTControlCharacters(editor.render(120).at(-1) ?? "");
	assert.match(bottom(), /gift ¥5\.00/);
	editor.setHealth({
		...health,
		balance: { available: true, balances: [{ currency: "USD", total: "3.00", granted: "0.00", toppedUp: "3.00" }] },
	});
	assert.match(bottom(), /Bal \$3\.00/);
	assert.doesNotMatch(bottom(), /gift|¥20\.50/);
	editor.setHealth({ ...health, balance: undefined });
	assert.doesNotMatch(bottom(), /Bal/);
});
