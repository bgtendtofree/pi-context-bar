import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { editorModelOptions, pickEditorBorderLabels, renderLabeledBorder } from "./border.ts";
import { plainWidth } from "./text.ts";

describe("editor model labels", () => {
	test("keeps model before optional thinking", () => {
		assert.deepEqual(editorModelOptions(null, "high"), ["no-model", "?"]);
		const options = editorModelOptions({ id: "anthropic/claude-opus", provider: "anthropic", reasoning: true }, "high");
		assert.equal(options[0], "anthropic/claude-opus · high");
		assert.ok(options.includes("claude-opus · high"));
		assert.ok(options.includes("claude-opus"));
		assert.deepEqual(editorModelOptions({ id: "gpt-4o", provider: "openai", reasoning: false }, "high"), ["gpt-4o"]);
		assert.ok(
			editorModelOptions({ id: "provider/a-very-long-model-name", provider: "p", reasoning: false }, "off").some(
				(option) => option.endsWith("…"),
			),
		);
	});
});

describe("rounded editor border", () => {
	test("fits both labels when possible", () => {
		const picked = pickEditorBorderLabels(["gpt-5.6-sol · medium", "gpt-5.6-sol"], ["⎇ main ?1", "⎇ main"], 48);
		assert.deepEqual(picked, { modelLabel: "gpt-5.6-sol · medium", gitLabel: "⎇ main ?1" });
		const border = renderLabeledBorder(48, "╰", "╯", picked.modelLabel, picked.gitLabel, (text) => text);
		assert.equal(plainWidth(border), 48);
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
		assert.equal(plainWidth(renderLabeledBorder(12, "╰", "╯", "", "", (text) => text)), 12);
	});

	test("fits labels by terminal columns", () => {
		assert.deepEqual(pickEditorBorderLabels(["模型"], ["⎇ 分支"], 18), {
			modelLabel: "模型",
			gitLabel: "",
		});
		assert.equal(plainWidth(renderLabeledBorder(14, "╰", "╯", "模型", "", (text) => text)), 14);
	});
});
