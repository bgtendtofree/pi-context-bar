import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { parseColor, styleText, type TerminalColorMode, visibleWidth } from "@earendil-works/pi-tui";
import type { ModelInfo } from "../lib/border.ts";
import { ASCII_GLYPHS, NERD_GLYPHS } from "../lib/chrome.ts";
import type { PromptState } from "../lib/prompt.ts";
import type { TokenSpeedSnapshot } from "../lib/speed.ts";
import {
	BODY_INDENT,
	FRAME_COLUMNS,
	type HealthState,
	POPUP_INDENT,
	registerFramedEditor,
	remapEditorMouse,
	splitEditorRender,
} from "./framed-editor.ts";

const TOKEN_HEX: Readonly<Record<string, string>> = {
	text: "#dddddd",
	accent: "#a0a0ff",
	muted: "#888888",
	dim: "#666666",
	borderMuted: "#555555",
	bashMode: "#ffaa00",
	warning: "#ff9900",
	success: "#00cc66",
	error: "#ff5555",
};

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

test("remaps popup clicks and body clicks from the frame/indent constants", () => {
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
	const bodyX = event.x - (FRAME_COLUMNS + BODY_INDENT);
	const popupX = event.x - POPUP_INDENT;
	const width = event.width - (FRAME_COLUMNS * 2 + BODY_INDENT);
	assert.deepEqual(remapEditorMouse(event, 2, 5), { ...event, x: popupX, y: 5, width });
	assert.deepEqual(remapEditorMouse({ ...event, y: 3 }, 2, 5), { ...event, x: bodyX, y: 1, width });
});

test("framed editor uses square frame tokens, no fills, and a four-column body indent", () => {
	let editor: ReturnType<NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>> | undefined;
	let colorMode: TerminalColorMode = "256color";
	let speed: TokenSpeedSnapshot | null = null;
	let prompt: PromptState = "success";
	let model: ModelInfo = { id: "a-very-long-model-name", reasoning: true };
	const seenTokens = new Map<string, string[]>();
	const ctx = {
		mode: "tui",
		ui: {
			theme: {
				fg: (token: string, text: string) => {
					const list = seenTokens.get(text) ?? [];
					list.push(token);
					seenTokens.set(text, list);
					return styleText(text, { fg: parseColor(TOKEN_HEX[token] ?? "#888888") }, colorMode);
				},
			},
			setEditorComponent: (factory: Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]) => {
				if (factory) {
					const tui = { requestRender: () => {}, terminal: { rows: 20 } } as unknown as TUI;
					const theme = { borderColor: (text: string) => text } as EditorTheme;
					editor = factory(tui, theme, { matches: () => false } as unknown as Parameters<typeof factory>[2]);
				}
			},
		},
	} as unknown as ExtensionContext;
	registerFramedEditor(ctx, {
		getModel: () => model,
		getThinkingLevel: () => "medium",
		getHealth: () => ({
			snapshot: { usedTokens: 20_000, contextWindow: 100_000 },
			usage: { cost: 0, cacheHitRate: undefined, cacheHitRateAvg: undefined },
			quota: { weeklyPercent: undefined, limits: [{ label: "5h", percent: 30 }] },
			speed,
			frame: 0,
			activity: "idle",
			prompt,
		}),
		glyphs: NERD_GLYPHS,
		onTui: () => {},
	});
	assert.ok(editor);

	const rendered = editor.render(80);
	const plain = rendered.map(stripVTControlCharacters);
	assert.ok(!rendered.join("").includes("\x1b[48"), "chrome must not emit background escapes");
	for (const rounded of ["╭", "╮", "╰", "╯"]) assert.ok(!rendered.join("").includes(rounded));
	// Square corners; frame in borderMuted.
	assert.ok(plain[0]?.startsWith("┌─ "));
	assert.ok(plain[0]?.endsWith("┐"));
	assert.ok(plain[1]?.startsWith("│"));
	assert.ok(plain[1]?.endsWith("│"));
	assert.ok(plain[2]?.startsWith("└─ "));
	assert.ok(plain[2]?.endsWith("┘"));
	assert.equal(seenTokens.get("┌")?.at(-1), "borderMuted");
	assert.equal(seenTokens.get("┐")?.at(-1), "borderMuted");
	assert.equal(seenTokens.get("│")?.at(-1), "borderMuted");
	// Body indent is four columns; lane, prompt glyph, and model label start at column 3.
	assert.equal(plain[0]?.slice(0, 3), "┌─ ");
	assert.equal(plain[1]?.slice(0, 3), "│  ");
	assert.equal(plain[2]?.slice(0, 3), "└─ ");
	assert.equal(plain[1]?.indexOf("❯"), 3);
	assert.equal(plain[2]?.indexOf("a-very-long-model-name"), 3);
	// Two spaces separate the model group from the quota group.
	assert.ok(plain[2]?.includes("medium  5h 30%"));
	// Ready glyph accent; model id accent; thinking and arrow dim.
	assert.equal(seenTokens.get("❯")?.at(-1), "accent");
	assert.equal(seenTokens.get("a-very-long-model-name")?.at(-1), "accent");
	assert.equal(seenTokens.get(` · ${NERD_GLYPHS.thinking} medium`)?.at(-1), "dim");

	// Bash mode recolors the whole frame.
	editor.setText("!ls");
	editor.render(80);
	assert.equal(seenTokens.get("┌")?.at(-1), "bashMode");
	assert.equal(seenTokens.get("│")?.at(-1), "bashMode");
	editor.setText("");

	// Failure glyph error.
	prompt = "error";
	assert.match(stripVTControlCharacters(editor.render(80)[1] ?? ""), /✗/);
	assert.equal(seenTokens.get("✗")?.at(-1), "error");

	// Typed input starts at column 5 (frame + two spaces + glyph + space).
	editor.setText("input");
	assert.equal(stripVTControlCharacters(editor.render(80)[1] ?? "").indexOf("input"), 5);

	// Routed labels keep accent ids and a dim arrow.
	model = { id: "router/auto", reasoning: true, routed: { id: "openai/gpt-test", thinkingLevel: "medium" } };
	editor.render(80);
	assert.equal(seenTokens.get("router/auto")?.at(-1), "accent");
	assert.equal(seenTokens.get("openai/gpt-test")?.at(-1), "accent");
	assert.equal(seenTokens.get(" → ")?.at(-1), "dim");
	model = { id: "a-very-long-model-name", reasoning: true };

	colorMode = "truecolor";
	assert.ok(editor.render(80)[0]?.includes("\x1b[38;2;"));
	colorMode = "256color";
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
	for (const value of [null, { tokensPerSecond: 42.3, estimated: true }]) {
		speed = value;
		for (const text of [
			"",
			"中文😀 long input ".repeat(30),
			Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"),
		]) {
			editor.setText(text);
			for (let width = 6; width <= 200; width++) {
				assert.ok(
					editor.render(width).every((line) => visibleWidth(line) <= width),
					`editor width=${width}, speed=${Boolean(speed)}`,
				);
			}
		}
	}
});

test("decorative icons never push useful bottom-border info out", () => {
	const model: ModelInfo = { id: "claude-opus", reasoning: true, provider: "anthropic" };
	const health: HealthState = {
		snapshot: { usedTokens: 20_000, contextWindow: 100_000 },
		usage: { cost: 1.61, cacheHitRate: 98, cacheHitRateAvg: undefined },
		quota: { weeklyPercent: 40, limits: [{ label: "5h", percent: 30 }] },
		speed: { tokensPerSecond: 42.25, estimated: true },
		frame: 0,
		activity: "idle",
		prompt: "success",
	};
	const makeEditor = (glyphs: typeof NERD_GLYPHS): { render: (width: number) => readonly string[] } => {
		let editor: ReturnType<NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>> | undefined;
		const ctx = {
			mode: "tui",
			ui: {
				theme: { fg: (_token: string, text: string) => text },
				setEditorComponent: (factory: Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]) => {
					if (factory) {
						const tui = { requestRender: () => {}, terminal: { rows: 20 } } as unknown as TUI;
						const theme = { borderColor: (text: string) => text } as EditorTheme;
						editor = factory(tui, theme, { matches: () => false } as unknown as Parameters<typeof factory>[2]);
					}
				},
			},
		} as unknown as ExtensionContext;
		registerFramedEditor(ctx, {
			getModel: () => model,
			getThinkingLevel: () => "high",
			getHealth: () => health,
			glyphs,
			onTui: () => {},
		});
		return editor as unknown as { render: (width: number) => readonly string[] };
	};
	const lines = (glyphs: typeof NERD_GLYPHS, width: number): readonly string[] =>
		makeEditor(glyphs).render(width).map(stripVTControlCharacters);
	const top = (glyphs: typeof NERD_GLYPHS, width: number): string => lines(glyphs, width)[0] ?? "";
	const bottom = (glyphs: typeof NERD_GLYPHS, width: number): string => lines(glyphs, width).at(-1) ?? "";

	// Wide: Nerd decorates the same information; ASCII keeps CH and no icons.
	const wideNerd = bottom(NERD_GLYPHS, 120);
	const wideAscii = bottom(ASCII_GLYPHS, 120);
	assert.ok(wideNerd.includes(NERD_GLYPHS.providerAnthropic));
	assert.ok(wideNerd.includes(NERD_GLYPHS.thinking));
	assert.ok(wideNerd.includes(NERD_GLYPHS.cache));
	assert.ok(top(NERD_GLYPHS, 120).includes(NERD_GLYPHS.speed));
	assert.ok(!wideAscii.includes(NERD_GLYPHS.providerAnthropic));
	assert.ok(!wideAscii.includes(NERD_GLYPHS.thinking));
	assert.ok(!wideAscii.includes(NERD_GLYPHS.cache));
	assert.ok(wideAscii.includes("CH98%"));

	// Guard the guard: the baseline really does show every metric we compare against.
	const asciiWideTop = top(ASCII_GLYPHS, 160);
	const asciiWideBottom = bottom(ASCII_GLYPHS, 160);
	for (const token of ["(100K)", "42.3t/s"]) assert.ok(asciiWideTop.includes(token), token);
	for (const token of ["claude-opus", "5h 30%", "CH98", "$1.61"]) assert.ok(asciiWideBottom.includes(token), token);

	for (let width = 16; width <= 160; width++) {
		const nerdTop = top(NERD_GLYPHS, width);
		const nerdBottom = bottom(NERD_GLYPHS, width);
		const asciiTop = top(ASCII_GLYPHS, width);
		const asciiBottom = bottom(ASCII_GLYPHS, width);
		if (asciiBottom.includes("claude-opus")) assert.ok(nerdBottom.includes("claude-opus"), `model width=${width}`);
		if (asciiBottom.includes("5h 30%")) assert.ok(nerdBottom.includes("5h 30%"), `quota width=${width}`);
		if (asciiBottom.includes("CH98")) assert.ok(nerdBottom.includes("98%"), `cache width=${width}`);
		if (asciiBottom.includes("$1.61")) assert.ok(nerdBottom.includes("$1.61"), `cost width=${width}`);
		if (asciiTop.includes("(100K)")) assert.ok(nerdTop.includes("(100K)"), `window width=${width}`);
		if (asciiTop.includes("42.3t/s")) assert.ok(nerdTop.includes("42.3t/s"), `speed width=${width}`);
	}
});
