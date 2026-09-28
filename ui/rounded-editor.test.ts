import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ASCII_GLYPHS } from "../lib/chrome.ts";
import { registerRoundedEditor, remapEditorMouse, splitEditorRender } from "./rounded-editor.ts";

test("keeps autocomplete outside editor shell", () => {
	assert.deepEqual(splitEditorRender(["────", "prompt", "────", "command 1", "command 2"]), {
		editor: ["────", "prompt", "────"],
		autocomplete: ["command 1", "command 2"],
	});
	assert.deepEqual(splitEditorRender(["prompt"]), { editor: ["prompt"], autocomplete: [] });
	assert.deepEqual(
		splitEditorRender(["── ↑ 3 more ──", "prompt", "── ↓ 9 more ──", "command 1", "command 2"], "── ↓ 9 more ──"),
		{
			editor: ["── ↑ 3 more ──", "prompt", "── ↓ 9 more ──"],
			autocomplete: ["command 1", "command 2"],
		},
	);
});

test("remaps popup clicks above editor and cursor clicks inside padded shell", () => {
	const event = {
		type: "click" as const,
		button: "left" as const,
		x: 5,
		y: 0,
		screenX: 5,
		screenY: 0,
		width: 40,
		height: 7,
		shift: false,
		alt: false,
		ctrl: false,
	};
	assert.deepEqual(remapEditorMouse(event, 2, 5), { ...event, x: 3, y: 5, width: 36 });
	assert.deepEqual(remapEditorMouse({ ...event, y: 3 }, 2, 5), { ...event, x: 2, y: 1, width: 36 });
});

test("long editor keeps both native scroll counts inside rounded borders", () => {
	let editor: ReturnType<NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>> | undefined;
	const ctx = {
		mode: "tui",
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setEditorComponent: (factory: Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]) => {
				if (factory) {
					const tui = { requestRender: () => {}, terminal: { rows: 20 } } as unknown as TUI;
					const theme = { borderColor: (text: string) => text } as EditorTheme;
					editor = factory(tui, theme, { matches: () => false } as unknown as Parameters<typeof factory>[2]);
				}
			},
		},
	} as unknown as ExtensionContext;
	registerRoundedEditor(ctx, {
		getModel: () => ({ id: "a-very-long-model-name", reasoning: false }),
		getThinkingLevel: () => "off",
		getHealth: () => ({
			snapshot: { usedTokens: 0, contextWindow: 100_000 },
			usage: { cost: 0, cacheHitRate: undefined, cacheHitRateAvg: undefined },
			quota: undefined,
			speed: null,
			frame: 0,
			activity: "idle",
		}),
		glyphs: ASCII_GLYPHS,
		onTui: () => {},
	});
	assert.ok(editor);
	editor.setText(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"));
	const scrolledDown = editor.render(80).map(stripVTControlCharacters);
	assert.match(scrolledDown[0] ?? "", /↑\d+/);
	for (let i = 0; i < 20; i++) editor.handleInput("\x1b[A");
	const scrolledUp = editor.render(80).map(stripVTControlCharacters);
	assert.match(scrolledUp.at(-1) ?? "", /↓\d+/);
	assert.ok(scrolledUp.every((line) => visibleWidth(line) === 80));
	const narrow = editor.render(24).map(stripVTControlCharacters);
	assert.match(narrow.at(-1) ?? "", /↓/);
	assert.ok(narrow.every((line) => visibleWidth(line) === 24));
});
