import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { bottomBorderFits, editorModelOptions, pickBottomBorderContent, renderLabeledBorder } from "./border.ts";
import { ASCII_GLYPHS, type MetricOption, metricOptions, NERD_GLYPHS } from "./chrome.ts";

/** Plain reading, optionally with the same reading behind the cache icon. */
const pair = (plain: string, decorated = plain): MetricOption => ({ plain, decorated });

describe("editor model labels", () => {
	test("shows virtual selection and routed thinking before narrow fallbacks", () => {
		const options = editorModelOptions(
			{
				id: "router/auto",
				reasoning: true,
				routed: { id: "openai/gpt-test", thinkingLevel: "medium" },
			},
			"high",
		);
		assert.equal(options[0], "router/auto · high → openai/gpt-test · medium");
		assert.ok(options.includes("auto → gpt-test"));
		assert.ok(options.includes("auto"));
		assert.equal(
			editorModelOptions(
				{
					id: "auto",
					reasoning: false,
					routed: { id: "a-very-long-physical-model", thinkingLevel: "off" },
				},
				"high",
			)[0],
			"auto → a-very-long-physical-model",
		);
		assert.ok(
			editorModelOptions(
				{
					id: "auto",
					reasoning: false,
					routed: { id: "a-very-long-physical-model", thinkingLevel: undefined },
				},
				"off",
			).includes("auto → a-very-long-phy…"),
		);
	});

	test("keeps model before optional thinking", () => {
		assert.deepEqual(editorModelOptions(null, "high"), ["no-model", "?"]);
		const options = editorModelOptions({ id: "anthropic/claude-opus", reasoning: true }, "high");
		assert.equal(options[0], "anthropic/claude-opus · high");
		assert.ok(options.includes("claude-opus · high"));
		assert.ok(options.includes("claude-opus"));
		assert.deepEqual([...new Set(editorModelOptions({ id: "gpt-4o", reasoning: false }, "high"))], ["gpt-4o"]);
		assert.ok(
			editorModelOptions({ id: "provider/a-very-long-model-name", reasoning: false }, "off").some((option) =>
				option.endsWith("…"),
			),
		);
	});
});

describe("bottom border fitting", () => {
	test("counts decoration, quota, and metric widths", () => {
		assert.equal(
			bottomBorderFits({ width: 40, model: "gpt", quota: "5h 30%", metric: "CH98%", gap: 2, scrollReserve: 0 }),
			true,
		);
		assert.equal(
			bottomBorderFits({
				width: 10,
				model: "a-very-long-model-name",
				quota: "",
				metric: "",
				gap: 2,
				scrollReserve: 0,
			}),
			false,
		);
		assert.equal(bottomBorderFits({ width: 20, model: "gpt", quota: "", metric: "", gap: 2, scrollReserve: 0 }), true);
		assert.equal(
			bottomBorderFits({ width: 12, model: "gpt", quota: "", metric: "CH98%", gap: 2, scrollReserve: 0 }),
			false,
		);
	});
});

describe("bottom border content priority", () => {
	const models = ["gpt-5.6 · medium", "gpt-5.6"];
	const quotas = ["5h 75%  7d 43%", ""];
	const metrics = [pair("CH98%  $1.61"), pair("CH98%"), pair("")];
	const pick = (width: number): ReturnType<typeof pickBottomBorderContent> =>
		pickBottomBorderContent({ width, models, quotas, metrics, gap: 2, scrollReserve: 0 });

	test("keeps cache and window percentages over optional thinking detail", () => {
		assert.deepEqual(pick(40), { model: "gpt-5.6", quota: "5h 75%  7d 43%", metric: "CH98%" });
		// One column tighter still keeps both window percentages with cache.
		assert.deepEqual(pick(37), { model: "gpt-5.6", quota: "5h 75%  7d 43%", metric: "CH98%" });
	});

	test("drops cost before cache and cache before window percentages", () => {
		assert.deepEqual(pick(200), { model: "gpt-5.6 · medium", quota: "5h 75%  7d 43%", metric: "CH98%  $1.61" });
		assert.deepEqual(pick(13), { model: "gpt-5.6", quota: "", metric: "" });
	});

	test("returns undefined only when nothing fits", () => {
		assert.equal(pickBottomBorderContent({ width: 7, models, quotas, metrics, gap: 2, scrollReserve: 0 }), undefined);
	});
});

describe("bottom border decoration priority", () => {
	const styles = { fg: (_token: string, text: string) => text };
	const pick = (width: number, models: readonly string[], usage: Parameters<typeof metricOptions>[0]) =>
		pickBottomBorderContent({
			width,
			models,
			quotas: [""],
			metrics: metricOptions(usage, styles, NERD_GLYPHS),
			gap: 2,
			scrollReserve: 0,
		});

	test("keeps the cache reading labelled instead of trading the label for a longer model", () => {
		// The database icon and the `CH` label occupy the same columns, so the icon costs nothing
		// against useful text: the reading either keeps its label or degrades to no metric at all.
		const models = ["a-very-long-model-name", "a-very-long-mod…"];
		const usage = { cost: 0, cacheHitRate: 98, cacheHitRateAvg: undefined };
		for (const glyphs of [NERD_GLYPHS, ASCII_GLYPHS]) {
			for (let width = 8; width <= 40; width++) {
				const picked = pickBottomBorderContent({
					width,
					models,
					quotas: [""],
					metrics: metricOptions(usage, styles, glyphs),
					gap: 2,
					scrollReserve: 0,
				});
				if (!picked || picked.metric === "") continue;
				assert.ok(
					picked.metric === "CH98%" || picked.metric === `${NERD_GLYPHS.cache} 98%`,
					`${width}: ${picked.metric}`,
				);
			}
		}
		// Two columns short of the labelled reading the metric tier is already gone, so the full model
		// returns; at 34 the reading narrows the model id to its short form instead of going unlabelled.
		assert.deepEqual(pick(34, models, usage), {
			model: "a-very-long-mod…",
			quota: "",
			metric: `${NERD_GLYPHS.cache} 98%`,
		});
		assert.deepEqual(pick(36, models, usage), {
			model: "a-very-long-model-name",
			quota: "",
			metric: `${NERD_GLYPHS.cache} 98%`,
		});
	});

	test("keeps optional thinking and route detail once the labelled reading allows it", () => {
		const usage = { cost: 0, cacheHitRate: 98, cacheHitRateAvg: undefined };
		const cache = `${NERD_GLYPHS.cache} 98%`;
		assert.deepEqual(pick(24, ["gpt · medium", "gpt"], usage), { model: "gpt", quota: "", metric: cache });
		assert.deepEqual(pick(26, ["gpt · medium", "gpt"], usage), { model: "gpt · medium", quota: "", metric: cache });
		assert.deepEqual(pick(27, ["auto → gpt-test", "auto → gpt-t…"], usage), {
			model: "auto → gpt-t…",
			quota: "",
			metric: cache,
		});
		assert.deepEqual(pick(29, ["auto → gpt-test", "auto → gpt-t…"], usage), {
			model: "auto → gpt-test",
			quota: "",
			metric: cache,
		});
		// Cost keeps its place beside cache; the thinking level returns two columns later.
		assert.deepEqual(pick(31, ["gpt · medium", "gpt"], { ...usage, cost: 1.61 }), {
			model: "gpt",
			quota: "",
			metric: `${cache}  $1.61`,
		});
		assert.deepEqual(pick(33, ["gpt · medium", "gpt"], { ...usage, cost: 1.61 }), {
			model: "gpt · medium",
			quota: "",
			metric: `${cache}  $1.61`,
		});
	});
});

describe("horizontal editor border", () => {
	test("renders left and right labels", () => {
		const border = renderLabeledBorder(48, "─", "─", "gpt-5.6-sol · medium", "CH98%  $1.61", (text) => text);
		assert.equal(visibleWidth(border), 48);
		assert.ok(border.startsWith("── gpt-5.6-sol · medium "));
		assert.ok(border.endsWith(" CH98%  $1.61 ───"));
	});

	test("handles tiny widths", () => {
		assert.equal(
			renderLabeledBorder(0, "─", "─", "", "", (text) => text),
			"",
		);
		assert.equal(
			renderLabeledBorder(1, "─", "─", "", "", (text) => text),
			"─",
		);
		assert.equal(visibleWidth(renderLabeledBorder(12, "─", "─", "", "", (text) => text)), 12);
	});

	test("shrinks labels instead of overflowing the frame", () => {
		const plain = (text: string): string => text;
		assert.equal(renderLabeledBorder(2, "─", "─", "m", "CH98%", plain), "──");
		assert.equal(renderLabeledBorder(3, "─", "─", "m", "CH98%", plain), "───");
		for (const width of [2, 3, 4, 5, 9, 12, 20, 48]) {
			const border = renderLabeledBorder(width, "─", "─", "verylongmodellabel · high", "CH98%  $1.61  ↑3", plain);
			assert.equal(visibleWidth(border), width, `width ${width} rendered ${border}`);
		}
	});

	test("keeps labels that already fit untouched", () => {
		const plain = (text: string): string => text;
		assert.equal(renderLabeledBorder(24, "─", "─", "m", "CH", plain), `── m ${"─".repeat(12)} CH ───`);
	});

	test("embeds middle content and fills the rest", () => {
		const border = renderLabeledBorder(
			30,
			"─",
			"─",
			"model",
			"CH98%",
			(text) => text,
			(middleWidth) => "x".repeat(Math.min(middleWidth, 10)),
		);
		assert.equal(visibleWidth(border), 30);
		assert.ok(border.includes("xxxxxxxxxx"));
		const withoutMiddle = renderLabeledBorder(
			30,
			"─",
			"─",
			"model",
			"CH98%",
			(text) => text,
			() => "",
		);
		assert.equal(visibleWidth(withoutMiddle), 30);
		assert.ok(!withoutMiddle.includes("x"));
	});

	test("measures labels by terminal columns", () => {
		assert.equal(visibleWidth(renderLabeledBorder(14, "─", "─", "模型", "", (text) => text)), 14);
	});
});
