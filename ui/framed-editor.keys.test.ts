import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
	getKeybindings,
	setKeybindings,
	TUI_KEYBINDINGS,
	KeybindingsManager as TuiKeybindingsManager,
} from "@earendil-works/pi-tui";
import { ASCII_GLYPHS, NERD_GLYPHS } from "../lib/chrome.ts";
import { buildFramedEditor } from "../test-support/editor-harness.ts";
import { type HealthState, registerFramedEditor } from "./framed-editor.ts";

test("puts wait/phase notices in the speed slot and mirrors Pi's indicator kind", () => {
	const health = (notice?: HealthState["notice"]): HealthState => ({
		snapshot: { usedTokens: 20_000, contextWindow: 100_000 },
		usage: { cost: 0, cacheHitRate: undefined, cacheHitRateAvg: undefined },
		quota: undefined,
		speed: { tokensPerSecond: 42.3, estimated: true },
		frame: 0,
		activity: "idle",
		prompt: "success",
		notice,
	});
	const framed = buildFramedEditor(NERD_GLYPHS, { id: "gpt-test", reasoning: false }, health());
	const before = framed.render(80).map(stripVTControlCharacters);
	assert.match(before[0] ?? "", /~42\.3t\/s/);

	framed.setHealth(health("retrying…"));
	const after = framed.render(80).map(stripVTControlCharacters);
	// The phase glyph replaces the speedometer; the last reading stays beside it.
	assert.match(after[0] ?? "", new RegExp(NERD_GLYPHS.retrying));
	assert.doesNotMatch(after[0] ?? "", /retrying…/);
	assert.match(after[0] ?? "", /~42\.3t\/s/);
	assert.doesNotMatch(after[0] ?? "", new RegExp(NERD_GLYPHS.speed));
	// Both readings share one reserved field; the percent cannot move.
	assert.equal(after[0]?.indexOf("20.0%"), before[0]?.indexOf("20.0%"));

	// Pi routes its public indicator here instead of a separate status row; the frame keeps only
	// the kind through the public override and discards the native bordered text.
	assert.equal(framed.embedsWorkingStatus(), true);
	assert.deepEqual(framed.statusKinds(), []);
	framed.setWorkingStatus("retry");
	framed.setWorkingStatus("compaction");
	framed.setWorkingStatus(undefined);
	assert.deepEqual(framed.statusKinds(), ["retry", "compaction", undefined]);
	assert.equal(framed.render(80).length, 3);
});

test("claims Alt+S only when no effective editor binding owns it", () => {
	const health: HealthState = {
		snapshot: { usedTokens: 0, contextWindow: 100_000 },
		usage: { cost: 0, cacheHitRate: undefined, cacheHitRateAvg: undefined },
		quota: undefined,
		speed: null,
		frame: 0,
		activity: "idle",
		prompt: "success",
	};
	type Editor = ReturnType<NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>> & {
		setText: (text: string) => void;
		getText: () => string;
		handleInput: (data: string) => void;
		getCursor: () => { line: number; col: number };
		onExtensionShortcut?: (data: string) => boolean;
	};
	const build = (
		bindings: Readonly<Record<string, string | readonly string[] | undefined>> | undefined,
		matches: (data: string, key: string) => boolean,
		noConfig = false,
	) => {
		let editor: Editor | undefined;
		let stashes = 0;
		let configReads = 0;
		const calls: [string, string][] = [];
		const ctx = {
			mode: "tui",
			ui: {
				theme: { fg: (_token: string, text: string) => text },
				setEditorComponent: (factory: Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]) => {
					if (!factory) return;
					const tui = { requestRender: () => {}, terminal: { rows: 20 } } as unknown as TUI;
					const theme = { borderColor: (text: string) => text } as EditorTheme;
					const keybindings = {
						...(noConfig
							? {}
							: {
									getEffectiveConfig: () => {
										configReads++;
										return bindings;
									},
								}),
						matches: (data: string, key: string) => {
							calls.push([data, key]);
							return matches(data, key);
						},
					} as unknown as Parameters<NonNullable<typeof factory>>[2];
					editor = factory(tui, theme, keybindings) as Editor;
				},
			},
		} as unknown as ExtensionContext;
		registerFramedEditor(ctx, {
			getModel: () => ({ id: "gpt-test", reasoning: false }),
			getThinkingLevel: () => "off",
			getHealth: () => health,
			getGlyphs: () => ASCII_GLYPHS,
			onStash: () => {
				stashes++;
			},
			onTui: () => {},
		});
		assert.ok(editor);
		return { editor, stashes: () => stashes, configReads: () => configReads, calls };
	};

	// Free key: consume it for the stash instead of inserting an "s" into the draft.
	const free = build(
		{ "tui.editor.cursorWordLeft": "alt+left", "tui.input.submit": ["enter", "ctrl+enter"] },
		() => false,
	);
	// Ordinary input never reads the binding map, and only the stash key skips `super`.
	free.editor.setText("");
	free.editor.handleInput("a");
	assert.equal(free.configReads(), 0);
	assert.equal(free.editor.getText(), "a");
	const typingChecks = free.calls.length;

	free.editor.setText("keep");
	free.editor.handleInput("\x1bs");
	assert.equal(free.stashes(), 1);
	assert.equal(free.configReads(), 1);
	assert.equal(free.editor.getText(), "keep");
	assert.equal(free.calls.length, typingChecks);

	// User override wins: the original action receives the key through super, not the stash. Pi's
	// editor reads the global keybindings manager, so install a real one with alt+s bound.
	const previous = getKeybindings();
	const manager = new TuiKeybindingsManager(TUI_KEYBINDINGS, { "tui.editor.cursorWordLeft": "alt+s" });
	setKeybindings(manager);
	try {
		const conflict = build(manager.getResolvedBindings(), (data, key) =>
			manager.matches(data, key as Parameters<TuiKeybindingsManager["matches"]>[1]),
		);
		conflict.editor.setText("one two three");
		const before = conflict.editor.getCursor().col;
		conflict.editor.handleInput("\x1bs");
		assert.equal(conflict.stashes(), 0);
		assert.ok(conflict.editor.getCursor().col < before, "bound action still ran");
	} finally {
		setKeybindings(previous);
	}

	// Another extension's shortcut keeps the priority Pi gives it; the stash does not steal it.
	const otherExtension = build({ "tui.editor.cursorWordLeft": "alt+left" }, () => false);
	otherExtension.editor.onExtensionShortcut = () => true;
	otherExtension.editor.handleInput("\x1bs");
	assert.equal(otherExtension.stashes(), 0);

	// Multi-key bindings are checked too.
	const multi = build({ "tui.editor.cursorWordLeft": ["alt+s", "ctrl+left"] }, () => false);
	multi.editor.handleInput("\x1bs");
	assert.equal(multi.stashes(), 0);

	// Without a resolved binding map the frame cannot prove Alt+S is free, so it passes through.
	const unknown = build(undefined, () => false, true);
	unknown.editor.handleInput("\x1bs");
	assert.equal(unknown.stashes(), 0);
});
