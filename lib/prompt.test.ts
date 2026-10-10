import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { ASCII_GLYPHS, NERD_GLYPHS } from "./chrome.ts";
import type { AssistantMessage } from "./context.ts";
import {
	INITIAL_PROMPT_STATE,
	type PromptStopReason,
	promptColor,
	promptGlyph,
	promptStateAfterTurn,
	promptStateFromEntries,
} from "./prompt.ts";

const assistantEntry = (id: string, stopReason: PromptStopReason): SessionEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "",
	message: {
		role: "assistant",
		content: [],
		api: "test",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	} as AssistantMessage,
});

const userEntry: SessionEntry = {
	type: "message",
	id: "user",
	parentId: null,
	timestamp: "",
	message: { role: "user", content: "hello", timestamp: 0 },
};

describe("prompt state", () => {
	test("starts neutral with the accent ready glyph", () => {
		assert.equal(INITIAL_PROMPT_STATE, "success");
		assert.equal(promptGlyph(INITIAL_PROMPT_STATE, NERD_GLYPHS), "❯");
		assert.equal(promptGlyph(INITIAL_PROMPT_STATE, ASCII_GLYPHS), ">");
		assert.equal(promptColor(INITIAL_PROMPT_STATE), "accent");
	});

	test("provider error shows the cross in the error color with an ASCII fallback", () => {
		const failed = promptStateAfterTurn(INITIAL_PROMPT_STATE, "error");
		assert.equal(failed, "error");
		assert.equal(promptGlyph(failed, NERD_GLYPHS), "✗");
		assert.equal(promptGlyph(failed, ASCII_GLYPHS), "x");
		assert.equal(promptColor(failed), "error");
	});

	test("aborted keeps the previous state; other non-error reasons restore the ready glyph", () => {
		assert.equal(promptStateAfterTurn("error", "aborted"), "error");
		assert.equal(promptStateAfterTurn("success", "aborted"), "success");
		for (const reason of [
			"stop",
			"length",
			"toolUse",
			"deferred",
			"pending",
		] as const satisfies readonly PromptStopReason[]) {
			assert.equal(promptStateAfterTurn("error", reason), "success");
			assert.equal(promptStateAfterTurn("success", reason), "success");
		}
	});

	test("derives from a branch, skipping non-assistant entries", () => {
		assert.equal(promptStateFromEntries([]), "success");
		assert.equal(promptStateFromEntries([userEntry]), "success");
		assert.equal(promptStateFromEntries([userEntry, assistantEntry("a", "stop")]), "success");
		assert.equal(promptStateFromEntries([assistantEntry("a", "stop"), assistantEntry("b", "error")]), "error");
	});

	test("an aborted turn preserves a branch's failure, and a later turn clears it", () => {
		const errored = assistantEntry("a", "error");
		const aborted = assistantEntry("b", "aborted");
		assert.equal(promptStateFromEntries([errored, aborted]), "error");
		assert.equal(promptStateFromEntries([errored, aborted, assistantEntry("c", "stop")]), "success");
	});
});
