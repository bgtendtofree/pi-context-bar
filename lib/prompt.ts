/** Prompt-state glyph borrowed from Omarchy's default Starship prompt. */

import type { SessionEntry, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { GlyphSet } from "./chrome.ts";
import type { AssistantMessage } from "./context.ts";

/** Latest completed turn's outcome; only provider errors latch the failure glyph. */
export type PromptState = "success" | "error";

export type PromptStopReason = AssistantMessage["stopReason"];

/** A branch with no assistant turns shows the neutral prompt. */
export const INITIAL_PROMPT_STATE: PromptState = "success";

/**
 * Provider `error` fails the prompt; `aborted` (user cancel) keeps whatever state was there; every
 * other completed reason restores the neutral prompt.
 */
export const promptStateAfterTurn = (state: PromptState, stopReason: PromptStopReason): PromptState => {
	if (stopReason === "error") return "error";
	if (stopReason === "aborted") return state;
	return "success";
};

/** Rebuild the prompt from a session branch: assistant turns fold left, aborting a pending failure. */
export const promptStateFromEntries = (entries: readonly SessionEntry[]): PromptState =>
	entries.reduce<PromptState>(
		(state, entry) =>
			entry.type === "message" && entry.message.role === "assistant"
				? promptStateAfterTurn(state, entry.message.stopReason)
				: state,
		INITIAL_PROMPT_STATE,
	);

/** Single-column prompt glyph for a state; the glyph set carries the ASCII fallback. */
export const promptGlyph = (state: PromptState, glyphs: GlyphSet): string =>
	state === "error" ? glyphs.promptFailure : glyphs.promptReady;

/** Only failure leaves the accent color for the theme's error token. */
export const promptColor = (state: PromptState): ThemeColor => (state === "error" ? "error" : "accent");
