import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	bottomBorderFits,
	decorateModel,
	editorModelOptions,
	providerBadge,
	renderLabeledBorder,
	withThinkingGlyph,
} from "./border.ts";
import { ASCII_GLYPHS, NERD_GLYPHS } from "./chrome.ts";

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

describe("provider badges", () => {
	test("badges only exact known non-virtual providers", () => {
		assert.equal(providerBadge("openai", NERD_GLYPHS), NERD_GLYPHS.providerOpenai);
		assert.equal(providerBadge("openai-codex", NERD_GLYPHS), NERD_GLYPHS.providerOpenai);
		assert.equal(providerBadge("anthropic", NERD_GLYPHS), NERD_GLYPHS.providerAnthropic);
		for (const provider of [undefined, "", "pi-virtual", "azure", "openai-codex-fake", "OpenAI"])
			assert.equal(providerBadge(provider, NERD_GLYPHS), "", String(provider));
		assert.equal(providerBadge("openai", ASCII_GLYPHS), "");
	});
});

describe("thinking brain", () => {
	test("decorates every thinking label including routed ones", () => {
		assert.equal(
			withThinkingGlyph("auto · high → gpt-test · medium", NERD_GLYPHS.thinking),
			`auto · ${NERD_GLYPHS.thinking} high → gpt-test · ${NERD_GLYPHS.thinking} medium`,
		);
		assert.equal(withThinkingGlyph("gpt-test · medium", ""), "gpt-test · medium");
		assert.equal(withThinkingGlyph("gpt-test", NERD_GLYPHS.thinking), "gpt-test");
		assert.equal(withThinkingGlyph("auto → gpt-test", NERD_GLYPHS.thinking), "auto → gpt-test");
	});
});

describe("decorated model fitting", () => {
	const info = { id: "claude", reasoning: true, provider: "anthropic" } as const;

	test("keeps badge and brain when they fit", () => {
		assert.equal(
			decorateModel("claude · high", info, NERD_GLYPHS, 200, "", "", 2, 0),
			`${NERD_GLYPHS.providerAnthropic} claude · ${NERD_GLYPHS.thinking} high`,
		);
	});

	test("drops brain before badge and both before the model text", () => {
		assert.equal(
			decorateModel("claude · high", info, NERD_GLYPHS, 21, "", "", 2, 0),
			`${NERD_GLYPHS.providerAnthropic} claude · high`,
		);
		assert.equal(decorateModel("claude · high", info, NERD_GLYPHS, 20, "", "", 2, 0), "claude · high");
	});

	test("drops decorations before quota and metrics", () => {
		const model = "gpt · high";
		assert.equal(decorateModel(model, info, NERD_GLYPHS, 33, "5h 30%", "$1.61", 2, 0), model);
		assert.equal(
			decorateModel(model, info, NERD_GLYPHS, 34, "5h 30%", "$1.61", 2, 0),
			`${NERD_GLYPHS.providerAnthropic} gpt · high`,
		);
	});

	test("ASCII glyphs keep the plain label", () => {
		assert.equal(decorateModel("claude · high", info, ASCII_GLYPHS, 200, "", "", 2, 0), "claude · high");
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

describe("rounded editor border", () => {
	test("renders left and right labels", () => {
		const border = renderLabeledBorder(48, "╰", "╯", "gpt-5.6-sol · medium", "CH98%  $1.61", (text) => text);
		assert.equal(visibleWidth(border), 48);
		assert.ok(border.startsWith("╰─ gpt-5.6-sol · medium "));
		assert.ok(border.endsWith(" CH98%  $1.61 ──╯"));
	});

	test("handles tiny widths", () => {
		assert.equal(
			renderLabeledBorder(0, "╰", "╯", "", "", (text) => text),
			"",
		);
		assert.equal(
			renderLabeledBorder(1, "╰", "╯", "", "", (text) => text),
			"─",
		);
		assert.equal(visibleWidth(renderLabeledBorder(12, "╰", "╯", "", "", (text) => text)), 12);
	});

	test("embeds middle content and fills the rest", () => {
		const border = renderLabeledBorder(
			30,
			"╰",
			"╯",
			"model",
			"CH98%",
			(text) => text,
			(middleWidth) => "x".repeat(Math.min(middleWidth, 10)),
		);
		assert.equal(visibleWidth(border), 30);
		assert.ok(border.includes("xxxxxxxxxx"));
		const withoutMiddle = renderLabeledBorder(
			30,
			"╰",
			"╯",
			"model",
			"CH98%",
			(text) => text,
			() => "",
		);
		assert.equal(visibleWidth(withoutMiddle), 30);
		assert.ok(!withoutMiddle.includes("x"));
	});

	test("measures labels by terminal columns", () => {
		assert.equal(visibleWidth(renderLabeledBorder(14, "╰", "╯", "模型", "", (text) => text)), 14);
	});
});
