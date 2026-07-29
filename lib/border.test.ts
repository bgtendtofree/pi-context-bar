import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { editorModelOptions, pickEditorBorderLabels, renderLabeledBorder } from "./border.ts";

describe("editor model labels", () => {
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

describe("rounded editor border", () => {
	test("fits both labels when possible", () => {
		const picked = pickEditorBorderLabels(["gpt-5.6-sol · medium", "gpt-5.6-sol"], ["⎇ main ?1", "⎇ main"], 48);
		assert.deepEqual(picked, { modelLabel: "gpt-5.6-sol · medium", gitLabel: "⎇ main ?1" });
		const border = renderLabeledBorder(48, "╰", "╯", picked.modelLabel, picked.gitLabel, (text) => text);
		assert.equal(visibleWidth(border), 48);
		assert.ok(border.startsWith("╰─ gpt-5.6-sol · medium "));
		assert.ok(border.endsWith(" ⎇ main ?1 ──╯"));
	});

	test("degrades labels and handles tiny widths", () => {
		assert.deepEqual(pickEditorBorderLabels(["model"], ["⎇ branch"], 14), {
			modelLabel: "model",
			gitLabel: "",
		});
		assert.deepEqual(pickEditorBorderLabels(["long-model"], ["⎇ branch"], 5), {
			modelLabel: "",
			gitLabel: "",
		});
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
			"⎇ main",
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
			"⎇ main",
			(text) => text,
			() => "",
		);
		assert.equal(visibleWidth(withoutMiddle), 30);
		assert.ok(!withoutMiddle.includes("x"));
	});

	test("fits labels by terminal columns", () => {
		assert.deepEqual(pickEditorBorderLabels(["模型"], ["⎇ 分支"], 18), {
			modelLabel: "模型",
			gitLabel: "",
		});
		assert.equal(visibleWidth(renderLabeledBorder(14, "╰", "╯", "模型", "", (text) => text)), 14);
	});
});
