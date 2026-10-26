import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { KeybindingsManager, type KeyId, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { restoreDecision, STASH_SHORTCUT, STASH_SUBCOMMAND, stashDecision, stashShortcutFree } from "./stash.ts";

describe("Alt+S stash toggle", () => {
	test("stashes a non-empty editor byte-for-byte and clears the editor", () => {
		const draft = "  line one\n\tline two — 中文  ";
		assert.deepEqual(stashDecision(draft, undefined), { action: "stash", text: draft });
	});

	test("restores into an empty editor and clears the stash", () => {
		assert.deepEqual(stashDecision("", "held draft"), { action: "restore", text: "held draft" });
	});

	test("never overwrites either draft when both sides have text", () => {
		assert.deepEqual(stashDecision("typed now", "held"), { action: "refuse" });
	});

	test("does nothing when both sides are empty", () => {
		assert.deepEqual(stashDecision("", undefined), { action: "none" });
	});
});

describe("slash command restore", () => {
	test("restores only, because Pi has already cleared the submitted command line", () => {
		assert.deepEqual(restoreDecision("", "held"), { action: "restore", text: "held" });
		assert.deepEqual(restoreDecision("", undefined), { action: "none" });
	});

	test("refuses to overwrite a non-empty editor", () => {
		assert.deepEqual(restoreDecision("still typing", "held"), { action: "refuse" });
	});

	test("public entry points stay discoverable and non-conflicting", () => {
		assert.equal(STASH_SHORTCUT, "alt+s");
		assert.equal(STASH_SUBCOMMAND, "stash");
	});
});

test("the stash key is free only when every resolved binding avoids it", () => {
	assert.equal(stashShortcutFree(undefined), false);
	assert.equal(stashShortcutFree({}), true);
	assert.equal(stashShortcutFree({ "tui.editor.cursorWordLeft": "alt+left" }), true);
	assert.equal(stashShortcutFree({ "tui.editor.cursorWordLeft": "alt+s" }), false);
	assert.equal(stashShortcutFree({ "tui.editor.cursorWordLeft": ["alt+left", "alt+s"] }), false);
});

test("a resolved override with different case still owns the stash key", () => {
	// Pi's parser lowercases key ids, so `Alt+S` matches the terminal input while the resolved map
	// keeps the user's spelling. Claiming the key here would shadow the user's binding.
	assert.equal(stashShortcutFree({ "tui.editor.undo": "Alt+S" }), false);
	assert.equal(stashShortcutFree({ "tui.editor.undo": ["Ctrl+Z", "ALT+S"] }), false);
	const manager = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.editor.undo": "Alt+S" as KeyId });
	const resolved = manager.getResolvedBindings();
	assert.equal(manager.matches("\x1bs", "tui.editor.undo"), true);
	assert.deepEqual(resolved["tui.editor.undo"], "Alt+S");
	assert.equal(stashShortcutFree(resolved), false);
});
