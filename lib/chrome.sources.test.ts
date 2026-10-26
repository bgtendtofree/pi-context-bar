import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";

describe("chrome color sources", () => {
	// Omarchy's palette lives in the active pi theme file, so the extension must never carry its own
	// colors: every value comes from a theme token, and no surface fills a background.
	const ESC = String.fromCharCode(0x1b);
	const chromeSources = (): readonly string[] => {
		const root = new URL("../", import.meta.url);
		const sources = ["index.ts"];
		for (const dir of ["lib", "ui"]) {
			for (const name of readdirSync(new URL(`${dir}/`, root))) {
				if (name.endsWith(".ts") && !name.endsWith(".test.ts")) sources.push(`${dir}/${name}`);
			}
		}
		return sources;
	};

	test("uses theme tokens only, with no hex colors and no raw ANSI escapes", () => {
		const root = new URL("../", import.meta.url);
		const sources = chromeSources();
		assert.ok(sources.length >= 10);
		for (const source of sources) {
			const text = readFileSync(new URL(source, root), "utf8");
			assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(text), `${source} hardcodes a hex color`);
			assert.ok(!text.includes(ESC), `${source} embeds a raw escape character`);
			assert.ok(!/\\x1b|\\033|\\u001b/.test(text), `${source} embeds a raw escape literal`);
		}
	});
});
