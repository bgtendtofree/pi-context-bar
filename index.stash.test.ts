import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { stashHarness } from "./test-support/stash-harness.ts";

test("Alt+S stashes without sending anything, and the command only restores", async () => {
	const h = stashHarness();
	const command = h.commands.get("context-bar");
	assert.ok(command);
	assert.equal(h.appendCount(), 0);

	await command("stash", h.ctx as ExtensionCommandContext);
	assert.match(h.notices.at(-1)?.message ?? "", /No stashed draft/);

	h.setEditorText("  draft 中文\nsecond line  ");
	h.stash();
	assert.equal(h.editorText(), "");
	assert.match(h.notices.at(-1)?.message ?? "", /Draft stashed/);
	assert.match(await h.status(), /Stash: 1 draft held in memory/);
	assert.equal(h.appendCount(), 0);

	// The command runs after Pi already cleared the submitted line, so it restores.
	await command("stash", h.ctx as ExtensionCommandContext);
	assert.equal(h.editorText(), "  draft 中文\nsecond line  ");
	assert.match(h.notices.at(-1)?.message ?? "", /restored/);
	assert.match(await h.status(), /Stash: none/);

	// Both sides hold text: refuse and leave both untouched.
	h.setEditorText("first");
	h.stash();
	h.setEditorText("second");
	h.stash();
	assert.equal(h.editorText(), "second");
	assert.match(h.notices.at(-1)?.message ?? "", /nothing was overwritten/);
	await command("stash", h.ctx as ExtensionCommandContext);
	assert.equal(h.editorText(), "second");
	assert.match(h.notices.at(-1)?.message ?? "", /not overwriting/);

	// Emptying the editor lets the restore happen; nothing was lost.
	h.setEditorText("");
	await command("stash", h.ctx as ExtensionCommandContext);
	assert.equal(h.editorText(), "first");
	assert.equal(h.appendCount(), 0);
	h.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, h.ctx);
});

test("a failed editor restore keeps the stash for a retry", async () => {
	const h = stashHarness();
	h.setEditorText("retry me");
	h.stash();
	assert.equal(h.editorText(), "");
	assert.match(await h.status(), /Stash: 1 draft held in memory/);

	h.failNextEditorSet();
	h.stash();
	assert.equal(h.editorText(), "");
	assert.match(h.notices.at(-1)?.message ?? "", /still held and can be retried/);
	assert.match(await h.status(), /Stash: 1 draft held in memory/);

	// Clearing the stash happens only after the editor accepted the text.
	h.stash();
	assert.equal(h.editorText(), "retry me");
	assert.match(await h.status(), /Stash: none/);
	h.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, h.ctx);
});

test("a held stash blocks session replacement until it is restored", async () => {
	const h = stashHarness();
	h.setEditorText("held draft");
	h.stash();
	assert.equal(h.editorText(), "");
	assert.equal(h.appendCount(), 0);

	for (const [name, event] of [
		["session_before_switch", { type: "session_before_switch", reason: "new" }],
		["session_before_switch", { type: "session_before_switch", reason: "resume", targetSessionFile: "x" }],
		["session_before_fork", { type: "session_before_fork", entryId: "e", position: "at" }],
		["session_before_tree", { type: "session_before_tree" }],
	] as const) {
		assert.deepEqual(h.handlers.get(name)?.(event, h.ctx), { cancel: true }, name);
		assert.match(h.notices.at(-1)?.message ?? "", /cancelled/);
	}
	assert.equal(h.appendCount(), 0);

	// Restore through the command, then the same transitions are free again.
	await h.commands.get("context-bar")?.("stash", h.ctx as ExtensionCommandContext);
	assert.equal(h.editorText(), "held draft");
	assert.equal(
		h.handlers.get("session_before_switch")?.({ type: "session_before_switch", reason: "new" }, h.ctx),
		undefined,
	);
	h.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, h.ctx);
});

test("shutdown restores a stash into an empty editor and reports the non-empty boundary", async () => {
	const h = stashHarness();
	h.setEditorText("recoverable");
	h.stash();
	h.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" }, h.ctx);
	// Reload keeps editor text; the free editor received the draft before the runtime reset.
	assert.equal(h.editorText(), "recoverable");
	assert.match(await h.status(), /Stash: none/);

	// A non-empty editor cannot take the draft without overwriting it; the SDK has no cancellable
	// shutdown, so this is the documented loss boundary rather than a silent state-only clear.
	h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
	h.setEditorText("held again");
	h.stash();
	h.setEditorText("typed over");
	h.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, h.ctx);
	assert.equal(h.editorText(), "typed over");
	assert.match(h.notices.at(-1)?.message ?? "", /Stash lost during quit shutdown/);
	h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
	await h.commands.get("context-bar")?.("stash", h.ctx as ExtensionCommandContext);
	assert.match(h.notices.at(-1)?.message ?? "", /No stashed draft/);
	h.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, h.ctx);
});
