import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ModelInfo } from "../lib/border.ts";
import { ASCII_GLYPHS, NERD_GLYPHS } from "../lib/chrome.ts";
import { buildFramedEditor } from "../test-support/editor-harness.ts";
import type { HealthState } from "./framed-editor.ts";

test("never trades useful text for the cache icon under real styled themes", () => {
	// Regression (audit round 1, refined in rounds 2–3): the picker used to strip decoration from
	// already-styled ANSI strings, so under a real theme `.startsWith(icon)` never matched and the
	// md-database icon still bought its width by truncating the model. The icon now replaces the
	// equal-width `CH` label, so a cache reading is either labelled or absent — never a bare number.
	const plainHealth = (usage: HealthState["usage"]): HealthState => ({
		snapshot: { usedTokens: 0, contextWindow: 100_000 },
		usage,
		quota: undefined,
		speed: null,
		frame: 0,
		activity: "idle",
		prompt: "success",
	});
	const cache98 = { cost: 0, cacheHitRate: 98, cacheHitRateAvg: undefined };
	const long: ModelInfo = { id: "a-very-long-model-name", reasoning: false };
	const thinking: ModelInfo = { id: "gpt", reasoning: true };
	const routed: ModelInfo = {
		id: "router/auto",
		reasoning: true,
		routed: { id: "openai/gpt-test", thinkingLevel: "medium" },
	};
	for (const colorMode of ["256color", "truecolor"] as const) {
		const bottom = (model: ModelInfo, health: HealthState, level: string, width: number): string =>
			stripVTControlCharacters(
				buildFramedEditor(NERD_GLYPHS, model, health, level, colorMode).render(width).at(-1) ?? "",
			);
		// Styling is really active in this mode.
		const styled = buildFramedEditor(NERD_GLYPHS, long, plainHealth(cache98), "off", colorMode).render(34).at(-1) ?? "";
		assert.ok(styled.includes(colorMode === "256color" ? "\x1b[38;5;" : "\x1b[38;2;"), styled);

		const tight = bottom(long, plainHealth(cache98), "off", 34);
		assert.ok(tight.includes("a-very-long-mod…"), tight);
		assert.ok(tight.includes(`${NERD_GLYPHS.cache} 98%`), tight);
		assert.ok(bottom(long, plainHealth(cache98), "off", 36).includes("a-very-long-model-name"));
		assert.ok(bottom(long, plainHealth(cache98), "off", 36).includes(`${NERD_GLYPHS.cache} 98%`));

		const thinkTight = bottom(thinking, plainHealth(cache98), "medium", 24);
		assert.ok(!thinkTight.includes("medium") && thinkTight.includes(`${NERD_GLYPHS.cache} 98%`), thinkTight);
		const thinkRoomy = bottom(thinking, plainHealth(cache98), "medium", 26);
		assert.ok(thinkRoomy.includes("gpt · medium") && thinkRoomy.includes(`${NERD_GLYPHS.cache} 98%`), thinkRoomy);

		const costTight = bottom(thinking, plainHealth({ ...cache98, cost: 1.61 }), "medium", 31);
		assert.ok(!costTight.includes("medium") && costTight.includes(`${NERD_GLYPHS.cache} 98%  $1.61`), costTight);
		const costRoomy = bottom(thinking, plainHealth({ ...cache98, cost: 1.61 }), "medium", 33);
		assert.ok(costRoomy.includes("gpt · medium") && costRoomy.includes(`${NERD_GLYPHS.cache} 98%`), costRoomy);

		const routeTight = bottom(routed, plainHealth(cache98), "medium", 27);
		assert.ok(routeTight.includes("auto · medium") && routeTight.includes(`${NERD_GLYPHS.cache} 98%`), routeTight);
		assert.ok(!routeTight.includes("→"), routeTight);
		const routeRoomy = bottom(routed, plainHealth(cache98), "medium", 29);
		assert.ok(routeRoomy.includes("auto → gpt-test") && routeRoomy.includes(`${NERD_GLYPHS.cache} 98%`), routeRoomy);
	}
});

test("labels the cache reading instead of spending a bare number on a longer model", () => {
	// Regression (audit rounds 1 and 3): the picker once let the database icon narrow the model, then
	// fell back to an unlabelled `98%` when the icon did not fit. The icon now replaces the equal-width
	// `CH` label, so the reading is always identifiable; without room for it, cache degrades to absent.
	const model: ModelInfo = { id: "a-very-long-model-name", reasoning: false };
	const health: HealthState = {
		snapshot: { usedTokens: 0, contextWindow: 100_000 },
		usage: { cost: 0, cacheHitRate: 98, cacheHitRateAvg: undefined },
		quota: undefined,
		speed: null,
		frame: 0,
		activity: "idle",
		prompt: "success",
	};
	const bottom = (width: number): string =>
		stripVTControlCharacters(buildFramedEditor(NERD_GLYPHS, model, health).render(width).at(-1) ?? "");
	for (let width = 8; width <= 40; width++) {
		const line = bottom(width);
		if (line.includes("98%")) assert.ok(line.includes(`${NERD_GLYPHS.cache} 98%`), `width=${width}: ${line}`);
	}
	// The labelled reading narrows the model id to its short form…
	const tight = bottom(34);
	assert.ok(tight.includes("a-very-long-mod…"), tight);
	assert.ok(tight.includes(`${NERD_GLYPHS.cache} 98%`), tight);
	// …and the full id returns as soon as the label fits beside it.
	const roomy = bottom(36);
	assert.ok(roomy.includes("a-very-long-model-name"), roomy);
	assert.ok(roomy.includes(`${NERD_GLYPHS.cache} 98%`), roomy);
});

test("decorative icons never push useful bottom-border info out", () => {
	const model: ModelInfo = { id: "claude-opus", reasoning: true };
	const health: HealthState = {
		snapshot: { usedTokens: 20_000, contextWindow: 100_000 },
		usage: { cost: 1.61, cacheHitRate: 98, cacheHitRateAvg: undefined },
		quota: {
			limits: [
				{ label: "5h", percent: 75, resetAt: Date.now() + 150 * 60_000 },
				{ label: "7d", percent: 43, resetAt: Date.now() + 5 * 86_400_000 },
			],
			resetCredits: 3,
		},
		speed: { tokensPerSecond: 42.25, estimated: true },
		frame: 0,
		activity: "idle",
		prompt: "success",
	};
	const lines = (glyphs: typeof NERD_GLYPHS, width: number): readonly string[] =>
		buildFramedEditor(glyphs, model, health).render(width).map(stripVTControlCharacters);
	const top = (glyphs: typeof NERD_GLYPHS, width: number): string => lines(glyphs, width)[0] ?? "";
	const bottom = (glyphs: typeof NERD_GLYPHS, width: number): string => lines(glyphs, width).at(-1) ?? "";

	// Wide: Nerd decorates the same information; ASCII keeps CH and no icons.
	const wideNerd = bottom(NERD_GLYPHS, 120);
	const wideAscii = bottom(ASCII_GLYPHS, 120);
	assert.ok(wideNerd.includes(NERD_GLYPHS.cache));
	assert.ok(wideNerd.includes(NERD_GLYPHS.reset));
	assert.ok(wideNerd.includes(NERD_GLYPHS.credit));
	assert.ok(top(NERD_GLYPHS, 120).includes(NERD_GLYPHS.speed));
	assert.ok(!wideAscii.includes(NERD_GLYPHS.cache));
	assert.ok(wideAscii.includes("CH98%"));
	assert.ok(wideAscii.includes("R3"));

	// Guard the guard: the baseline really does show every metric we compare against.
	const asciiWideTop = top(ASCII_GLYPHS, 160);
	const asciiWideBottom = bottom(ASCII_GLYPHS, 160);
	for (const token of ["(100K)", "42.3t/s"]) assert.ok(asciiWideTop.includes(token), token);
	for (const token of ["claude-opus", "5h 75%", "7d 43%", "CH98", "$1.61"])
		assert.ok(asciiWideBottom.includes(token), token);

	for (let width = 16; width <= 160; width++) {
		const nerdTop = top(NERD_GLYPHS, width);
		const nerdBottom = bottom(NERD_GLYPHS, width);
		const asciiTop = top(ASCII_GLYPHS, width);
		const asciiBottom = bottom(ASCII_GLYPHS, width);
		assert.doesNotMatch(nerdTop + asciiTop, /─/);
		assert.equal(visibleWidth(nerdTop), width);
		assert.equal(visibleWidth(asciiTop), width);
		if (asciiBottom.includes("claude-opus")) assert.ok(nerdBottom.includes("claude-opus"), `model width=${width}`);
		if (asciiBottom.includes("5h 75%")) assert.ok(nerdBottom.includes("5h 75%"), `quota width=${width}`);
		if (asciiBottom.includes("7d 43%")) assert.ok(nerdBottom.includes("7d 43%"), `quota width=${width}`);
		if (asciiBottom.includes("CH98")) assert.ok(nerdBottom.includes("98%"), `cache width=${width}`);
		if (asciiBottom.includes("$1.61")) assert.ok(nerdBottom.includes("$1.61"), `cost width=${width}`);
		if (asciiTop.includes("(100K)")) assert.ok(nerdTop.includes("(100K)"), `window width=${width}`);
		if (asciiTop.includes("42.3t/s")) assert.ok(nerdTop.includes("42.3t/s"), `speed width=${width}`);
	}
});

test("keeps window percents and cost when quota detail cannot fit", (t) => {
	// Regression: width 51 where the Nerd reset/credit icons (two extra columns vs ASCII) used to
	// drop the cost even though shrinking optional quota detail back to percentages fits everything.
	const now = Date.parse("2026-07-01T00:00:00Z");
	t.mock.method(Date, "now", () => now);
	const health: HealthState = {
		snapshot: { usedTokens: 20_000, contextWindow: 100_000 },
		usage: { cost: 0.042, cacheHitRate: undefined, cacheHitRateAvg: undefined },
		quota: {
			limits: [
				{ label: "5h", percent: 92, resetAt: now + 150 * 60_000 },
				{ label: "7d", percent: 43, resetAt: now + 150 * 60_000 },
			],
			resetCredits: 1,
		},
		speed: null,
		frame: 0,
		activity: "idle",
		prompt: "success",
	};
	for (const glyphs of [NERD_GLYPHS, ASCII_GLYPHS]) {
		const line = stripVTControlCharacters(buildFramedEditor(glyphs, null, health).render(51).at(-1) ?? "");
		assert.ok(line.includes("no-model"), line);
		assert.ok(line.includes("5h 92%"), line);
		assert.ok(line.includes("7d 43%"), line);
		assert.ok(line.includes("$0.042"), line);
	}
	// The optional detail really does fit at 51 in ASCII, so the guard is meaningful.
	const ascii = stripVTControlCharacters(buildFramedEditor(ASCII_GLYPHS, null, health).render(51).at(-1) ?? "");
	assert.ok(ascii.includes("r2h 30m") && ascii.includes("R1"), ascii);
});

test("keeps window percentages and cache before optional thinking on narrow borders", () => {
	// Regression: fitting every model variant against an empty quota let the optional thinking level
	// win, so `gpt-5.6 · medium` hid both window percentages and cache at widths where the bare model
	// plus that essential reading fits. Nerd and ASCII must agree on which numbers survive.
	const model: ModelInfo = { id: "gpt-5.6", reasoning: true };
	const health: HealthState = {
		snapshot: { usedTokens: 20_000, contextWindow: 100_000 },
		usage: { cost: 1.61, cacheHitRate: 98, cacheHitRateAvg: undefined },
		quota: {
			limits: [
				{ label: "5h", percent: 75 },
				{ label: "7d", percent: 43 },
			],
		},
		speed: null,
		frame: 0,
		activity: "idle",
		prompt: "success",
	};
	for (const glyphs of [NERD_GLYPHS, ASCII_GLYPHS]) {
		const bottom = (width: number): string =>
			stripVTControlCharacters(buildFramedEditor(glyphs, model, health, "medium").render(width).at(-1) ?? "");
		for (const width of [37, 40]) {
			const line = bottom(width);
			assert.ok(line.includes("gpt-5.6"), `model width=${width}: ${line}`);
			assert.ok(line.includes("5h 75%") && line.includes("7d 43%"), `quota width=${width}: ${line}`);
			assert.ok(line.includes("98"), `cache width=${width}: ${line}`);
			assert.ok(!line.includes("medium"), `thinking squeezed numbers width=${width}: ${line}`);
		}
		const wide = bottom(120);
		assert.ok(wide.includes("medium") && wide.includes("$1.61"), wide);
	}
});

test("keeps the labelled cache and cost before an optional quota countdown", (t) => {
	// The cache label and cost are essential readings; the countdown is spare-width detail. At width 35
	// the labelled reading plus the countdown does not fit, so the countdown waits two columns longer
	// instead of the cache losing its identity.
	const now = 1_800_000_000_000;
	t.mock.method(Date, "now", () => now);
	const health: HealthState = {
		snapshot: { usedTokens: 20_000, contextWindow: 100_000 },
		usage: { cost: 1.61, cacheHitRate: 98, cacheHitRateAvg: 98 },
		quota: { limits: [{ label: "5h", percent: 75, resetAt: now + 3_600_000 }] },
		speed: null,
		frame: 0,
		activity: "idle",
		prompt: "success",
	};
	const bottom = (width: number): string =>
		stripVTControlCharacters(
			buildFramedEditor(NERD_GLYPHS, { id: "gpt", reasoning: false }, health, "off").render(width).at(-1) ?? "",
		);
	const tight = bottom(35);
	assert.ok(tight.includes("gpt"), tight);
	assert.ok(tight.includes("5h 75%"), tight);
	assert.ok(tight.includes(`${NERD_GLYPHS.cache} 98%  $1.61`), tight);
	assert.ok(!tight.includes(NERD_GLYPHS.reset), tight);
	assert.equal(visibleWidth(tight), 35, tight);
	// Spare width brings the countdown back beside the same readings.
	const roomy = bottom(37);
	assert.ok(roomy.includes(`${NERD_GLYPHS.reset} 1h`), roomy);
	assert.ok(roomy.includes(`${NERD_GLYPHS.cache} 98%  $1.61`), roomy);
	assert.equal(visibleWidth(roomy), 37, roomy);
});

test("narrows to the most-used quota window with only its own countdown", (t) => {
	// Regression for the layout gap: a narrow border used to show either every window or none. It now
	// keeps the highest-used window, and that reading's countdown follows it instead of another
	// window's detail being grafted on.
	const now = 1_800_000_000_000;
	t.mock.method(Date, "now", () => now);
	const minute = 60_000;
	const health: HealthState = {
		snapshot: { usedTokens: 20_000, contextWindow: 100_000 },
		usage: { cost: 0, cacheHitRate: undefined, cacheHitRateAvg: undefined },
		quota: {
			limits: [
				{ label: "5h", percent: 10, resetAt: now + 30 * minute },
				{ label: "7d", percent: 75, resetAt: now + 150 * minute },
				{ label: "30d", percent: 40, resetAt: now + 300 * minute },
			],
		},
		speed: null,
		frame: 0,
		activity: "idle",
		prompt: "success",
	};
	const line = stripVTControlCharacters(
		buildFramedEditor(NERD_GLYPHS, { id: "gpt", reasoning: false }, health, "off").render(30).at(-1) ?? "",
	);
	assert.equal(visibleWidth(line), 30, line);
	assert.ok(line.includes("7d 75%"), line);
	// Only the high window's own countdown; the quiet siblings keep their own readings, not this one's.
	assert.ok(line.includes(`${NERD_GLYPHS.reset} 2h 30m`), line);
	assert.ok(!line.includes("5h 10%"), line);
	assert.ok(!line.includes("30d 40%"), line);
});

test("invalidates the bottom memo when the relative countdown crosses its bucket", (t) => {
	// The old key used Math.floor(now / 60_000), so a render that stayed inside one absolute minute
	// kept a countdown the new relative reading had already crossed.
	let now = 1_800_000_000_000; // Exact minute; +31s stays inside the same absolute minute.
	t.mock.method(Date, "now", () => now);
	const health: HealthState = {
		snapshot: { usedTokens: 20_000, contextWindow: 100_000 },
		usage: { cost: 0, cacheHitRate: undefined, cacheHitRateAvg: undefined },
		quota: { limits: [{ label: "5h", percent: 75, resetAt: now + 90_000 }] },
		speed: null,
		frame: 0,
		activity: "idle",
		prompt: "success",
	};
	const editor = buildFramedEditor(ASCII_GLYPHS, { id: "gpt", reasoning: false }, health, "off");
	const bottom = (): string => stripVTControlCharacters(editor.render(80).at(-1) ?? "");
	assert.match(bottom(), /r1m/);
	now += 31_000;
	assert.equal(Math.floor(now / 60_000), Math.floor((now - 31_000) / 60_000));
	assert.match(bottom(), /r<1m/);
	assert.doesNotMatch(bottom(), /r1m/);
});
