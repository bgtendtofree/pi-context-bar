import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { CustomEditor, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import {
	CURSOR_MARKER,
	isFocusable,
	parseColor,
	renderFakeCursor,
	styleText,
	type TerminalColorMode,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ModelInfo } from "../lib/border.ts";
import { ASCII_GLYPHS, NERD_GLYPHS, type QuotaUsage } from "../lib/chrome.ts";
import type { PromptState } from "../lib/prompt.ts";
import type { TokenSpeedSnapshot } from "../lib/speed.ts";
import {
	BODY_INDENT,
	FRAME_COLUMNS,
	type HealthState,
	POPUP_INDENT,
	registerFramedEditor,
	remapEditorMouse,
	sameKey,
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
	assert.deepEqual(splitEditorRender(["────", "prompt", "────", "command 1", "command 2"], "────"), {
		editor: ["────", "prompt", "────"],
		autocomplete: ["command 1", "command 2"],
	});
	assert.deepEqual(splitEditorRender(["prompt", "────"], "────"), { editor: ["prompt", "────"], autocomplete: [] });
	assert.deepEqual(
		splitEditorRender(["── ↑ 3 more ──", "prompt", "── ↓ 9 more ──", "command 1", "command 2"], "── ↓ 9 more ──"),
		{
			editor: ["── ↑ 3 more ──", "prompt", "── ↓ 9 more ──"],
			autocomplete: ["command 1", "command 2"],
		},
	);
	// A body row that happens to repeat the border string is not the border; the last match is.
	assert.deepEqual(splitEditorRender(["────", "────", "tail"], "────"), {
		editor: ["────", "────"],
		autocomplete: ["tail"],
	});
});

test("refuses to frame a render whose bottom border it cannot find", () => {
	// Pi's render shape changed: the caller keeps pi's own layout instead of framing arbitrary rows.
	assert.equal(splitEditorRender(["prompt"], "────"), undefined);
	assert.equal(splitEditorRender(["────", "prompt", "──── "], "────"), undefined);
	// An empty captured border would otherwise match every blank body row.
	assert.equal(splitEditorRender(["────", "", "autocomplete"], ""), undefined);
});

test("compares memo keys by length and identity", () => {
	const shared = {};
	assert.equal(sameKey([1, "a", shared], [1, "a", shared]), true);
	assert.equal(sameKey([1, "a", shared], [1, "a", {}]), false);
	assert.equal(sameKey([1, 2], [1, 2, 3]), false);
	// Object.is keeps a NaN entry stable so an idle quota does not churn the cache.
	assert.equal(sameKey([Number.NaN], [Number.NaN]), true);
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
			quota: { limits: [{ label: "5h", percent: 30 }] },
			speed,
			frame: 0,
			activity: "idle",
			prompt,
		}),
		getGlyphs: () => NERD_GLYPHS,
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
	assert.equal(seenTokens.get(" · medium")?.at(-1), "dim");

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

	// Text that reads like pi's scroll cue is still body text: framed and indented like any other.
	editor.setText("↑ 3 more");
	assert.equal(stripVTControlCharacters(editor.render(80)[1] ?? "").indexOf("↑ 3 more"), 5);

	// Guard pi's mouse convention: a body click lands the cursor on the clicked column. This is the
	// check that fails if pi ever changes how handleMouse reads x, y, or width.
	editor.setText("input");
	editor.render(80);
	const mouse = editor as unknown as {
		handleMouse(event: TuiMouseEvent): unknown;
		getCursor(): { line: number; col: number };
	};
	const click = (x: number, y: number): void => {
		mouse.handleMouse({
			type: "click",
			button: "left",
			x,
			y,
			screenX: x,
			screenY: y,
			width: 80,
			height: 5,
			shift: false,
			alt: false,
			ctrl: false,
		});
	};
	for (const column of [0, 2, 5]) {
		click(FRAME_COLUMNS + BODY_INDENT + column, 1);
		assert.deepEqual(mouse.getCursor(), { line: 0, col: column }, `column=${column}`);
	}
	// A frame row is not a text row: clicking the top border leaves the cursor where it was.
	click(FRAME_COLUMNS + BODY_INDENT + 3, 0);
	assert.deepEqual(mouse.getCursor(), { line: 0, col: 5 });

	// Pi 1.2 resolves the fake cursor in TUI; preserve its marker and framed IME position.
	assert.ok(isFocusable(editor));
	editor.focused = true;
	for (const text of ["", "input", "中文😀", "first\n中文😀"]) {
		editor.setText(text);
		for (const width of [24, 80]) {
			const lines = editor.render(width);
			const cursorLines = lines.filter((line) => line.includes(CURSOR_MARKER));
			assert.equal(cursorLines.length, 1);
			const line = cursorLines[0] ?? "";
			const marker = line.indexOf(CURSOR_MARKER);
			assert.equal(
				visibleWidth(line.slice(0, marker)),
				FRAME_COLUMNS + BODY_INDENT + visibleWidth(text.split("\n").at(-1) ?? ""),
			);
			assert.ok(line.slice(marker + CURSOR_MARKER.length).startsWith(renderFakeCursor(" ")));
			assert.ok(lines.every((row) => visibleWidth(row) === width));
		}
	}
	editor.focused = false;
	assert.ok(editor.render(80).every((line) => !line.includes(CURSOR_MARKER)));

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

const buildFramedEditor = (
	glyphs: typeof NERD_GLYPHS,
	model: ModelInfo,
	health: HealthState,
	thinkingLevel = "high",
	colorMode?: TerminalColorMode,
): {
	render: (width: number) => readonly string[];
	setText: (text: string) => void;
	setHealth: (next: HealthState) => void;
	tokenCalls: () => number;
	forceBorderMismatch: () => void;
	layoutNotices: () => readonly string[];
} => {
	let editor: ReturnType<NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>> | undefined;
	let fgCalls = 0;
	let currentHealth = health;
	const layoutNotices: string[] = [];
	const ctx = {
		mode: "tui",
		ui: {
			theme: {
				fg: (token: string, text: string) => {
					fgCalls++;
					return colorMode ? styleText(text, { fg: parseColor(TOKEN_HEX[token] ?? "#888888") }, colorMode) : text;
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
		getThinkingLevel: () => thinkingLevel,
		getHealth: () => currentHealth,
		getGlyphs: () => glyphs,
		onUnrecognizedLayout: () => layoutNotices.push("unrecognized"),
		onTui: () => {},
	});
	const built = editor as unknown as {
		render: (width: number) => readonly string[];
		setText: (text: string) => void;
		renderBottomBorder: (width: number, hiddenLineCount: number) => string;
		bottomBorder: string;
	};
	return {
		render: (width) => built.render(width),
		setText: (text) => built.setText(text),
		setHealth: (next) => {
			currentHealth = next;
		},
		tokenCalls: () => fgCalls,
		layoutNotices: () => layoutNotices,
		// Force the frame to lose the border it captured this render pass, as if pi changed its render
		// shape: the fallback must re-render pi's own layout at the full width.
		forceBorderMismatch: () => {
			const original = built.renderBottomBorder.bind(built);
			built.renderBottomBorder = (width, hiddenLineCount) => {
				const line = original(width, hiddenLineCount);
				built.bottomBorder = "SENTINEL";
				return line;
			};
		},
	};
};

test("never trades useful text for the cache icon under real styled themes", () => {
	// Regression (audit round 1, refined in round 2): the picker used to strip decoration from
	// already-styled ANSI strings, so under a real theme `.startsWith(icon)` never matched and the
	// md-database icon still bought its width by truncating the model. The styled formatter now
	// carries explicit plain/decorated readings, so these assertions must hold for 256color and
	// truecolor alike, not just with an identity fg.
	const plainHealth = (usage: HealthState["usage"]): HealthState => ({
		snapshot: { usedTokens: 0, contextWindow: 100_000 },
		usage,
		quota: undefined,
		speed: null,
		frame: 0,
		activity: "idle",
		prompt: "success",
	});
	const cache98 = { cost: 0, cacheHitRate: 98, cacheHitRateAvg: undefined };
	const long: ModelInfo = { id: "a-very-long-model-name", reasoning: false };
	const thinking: ModelInfo = { id: "gpt", reasoning: true };
	const routed: ModelInfo = {
		id: "router/auto",
		reasoning: true,
		routed: { id: "openai/gpt-test", thinkingLevel: "medium" },
	};
	for (const colorMode of ["256color", "truecolor"] as const) {
		const bottom = (model: ModelInfo, health: HealthState, level: string, width: number): string =>
			stripVTControlCharacters(
				buildFramedEditor(NERD_GLYPHS, model, health, level, colorMode).render(width).at(-1) ?? "",
			);
		// Styling is really active in this mode.
		const styled = buildFramedEditor(NERD_GLYPHS, long, plainHealth(cache98), "off", colorMode).render(34).at(-1) ?? "";
		assert.ok(styled.includes(colorMode === "256color" ? "\x1b[38;5;" : "\x1b[38;2;"), styled);

		const tight = bottom(long, plainHealth(cache98), "off", 34);
		assert.ok(tight.includes("a-very-long-model-name") && !tight.includes("…"), tight);
		assert.ok(tight.includes("98%") && !tight.includes(NERD_GLYPHS.cache), tight);
		assert.ok(bottom(long, plainHealth(cache98), "off", 36).includes(`${NERD_GLYPHS.cache} 98%`));

		const thinkTight = bottom(thinking, plainHealth(cache98), "medium", 24);
		assert.ok(thinkTight.includes("gpt · medium  98%") && !thinkTight.includes(NERD_GLYPHS.cache), thinkTight);
		assert.ok(bottom(thinking, plainHealth(cache98), "medium", 26).includes(`${NERD_GLYPHS.cache} 98%`));

		const costTight = bottom(thinking, plainHealth({ ...cache98, cost: 1.61 }), "medium", 31);
		assert.ok(costTight.includes("98%  $1.61") && !costTight.includes(NERD_GLYPHS.cache), costTight);
		assert.ok(
			bottom(thinking, plainHealth({ ...cache98, cost: 1.61 }), "medium", 33).includes(
				`${NERD_GLYPHS.cache} 98%  $1.61`,
			),
		);

		const routeTight = bottom(routed, plainHealth(cache98), "medium", 27);
		assert.ok(routeTight.includes("auto → gpt-test  98%") && !routeTight.includes(NERD_GLYPHS.cache), routeTight);
		assert.ok(bottom(routed, plainHealth(cache98), "medium", 29).includes(`${NERD_GLYPHS.cache} 98%`));
	}
});

test("keeps the full model name before the decorative cache icon", () => {
	// Regression (audit round 1): the metric tier ran outside the model tier, so the md-database icon
	// kept its place by truncating the selected model, even though the full model name plus the bare
	// cache number fit. Decoration must drop before model text and before optional detail.
	const model: ModelInfo = { id: "a-very-long-model-name", reasoning: false };
	const health: HealthState = {
		snapshot: { usedTokens: 0, contextWindow: 100_000 },
		usage: { cost: 0, cacheHitRate: 98, cacheHitRateAvg: undefined },
		quota: undefined,
		speed: null,
		frame: 0,
		activity: "idle",
		prompt: "success",
	};
	const bottom = (width: number): string =>
		stripVTControlCharacters(buildFramedEditor(NERD_GLYPHS, model, health).render(width).at(-1) ?? "");
	const tight = bottom(34);
	assert.ok(tight.includes("a-very-long-model-name"), tight);
	assert.ok(!tight.includes("…"), tight);
	assert.ok(tight.includes("98%"), tight);
	assert.ok(!tight.includes(NERD_GLYPHS.cache), tight);
	// Two columns wider and the icon fits beside the same full model and number.
	const roomy = bottom(36);
	assert.ok(roomy.includes("a-very-long-model-name"), roomy);
	assert.ok(roomy.includes(`${NERD_GLYPHS.cache} 98%`), roomy);
});

test("falls back to pi's own layout when the frame cannot fit", () => {
	const health: HealthState = {
		snapshot: { usedTokens: 20_000, contextWindow: 100_000 },
		usage: { cost: 1.61, cacheHitRate: 98, cacheHitRateAvg: undefined },
		quota: undefined,
		speed: null,
		frame: 0,
		activity: "idle",
		prompt: "success",
	};
	const framed = buildFramedEditor(NERD_GLYPHS, { id: "gpt-test", reasoning: false }, health);
	// The stock editor is the oracle: below the frame's minimum width the extension must render
	// exactly what pi would, so a pi layout change shows up here instead of as a mangled frame.
	const tui = { requestRender: () => {}, terminal: { rows: 20 } } as unknown as TUI;
	const stock = new CustomEditor(
		tui,
		{ borderColor: (text: string) => text } as EditorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
		{ paddingX: 0 },
	);
	for (const width of [1, 4, 8]) {
		stock.setText("input");
		framed.setText("input");
		assert.deepEqual(framed.render(width), stock.render(width), `width=${width}`);
	}
	// One column more and the frame takes over.
	assert.ok(stripVTControlCharacters(framed.render(9)[0] ?? "").includes("┌"));
});

test("re-renders pi's layout at full width when the frame loses its captured border", () => {
	// Regression: the fallback returned the body rendered six columns narrower (the frame's body
	// indent) while handleMouse used full-width coordinates, so a pi render-shape change left a short
	// editor with misaligned clicks. The fallback must be pi's own full-width layout.
	const health: HealthState = {
		snapshot: { usedTokens: 20_000, contextWindow: 100_000 },
		usage: { cost: 1.61, cacheHitRate: 98, cacheHitRateAvg: undefined },
		quota: undefined,
		speed: null,
		frame: 0,
		activity: "idle",
		prompt: "success",
	};
	const framed = buildFramedEditor(NERD_GLYPHS, { id: "gpt-test", reasoning: false }, health);
	framed.setText("input");
	// The frame captures a border this render pass and then cannot find it again: force the mismatch.
	framed.forceBorderMismatch();
	const tui = { requestRender: () => {}, terminal: { rows: 20 } } as unknown as TUI;
	const stock = new CustomEditor(
		tui,
		{ borderColor: (text: string) => text } as EditorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
		{ paddingX: 0 },
	);
	for (const width of [24, 80]) {
		stock.setText("input");
		const rows = framed.render(width);
		assert.deepEqual(rows, stock.render(width), `width=${width}`);
		assert.ok(
			rows.every((row) => visibleWidth(row) === width),
			`width=${width}`,
		);
		assert.ok(!stripVTControlCharacters(rows.join("\n")).includes("┌"), `width=${width}`);
	}
});

test("reports an unrecognized pi layout once, and never for a known narrow fallback", () => {
	const health: HealthState = {
		snapshot: { usedTokens: 20_000, contextWindow: 100_000 },
		usage: { cost: 1.61, cacheHitRate: 98, cacheHitRateAvg: undefined },
		quota: undefined,
		speed: null,
		frame: 0,
		activity: "idle",
		prompt: "success",
	};
	const framed = buildFramedEditor(NERD_GLYPHS, { id: "gpt-test", reasoning: false }, health);
	framed.setText("input");
	// Too narrow to frame is a known, intended fallback: it must not read as a changed pi.
	framed.render(8);
	assert.deepEqual(framed.layoutNotices(), []);

	// A frame that lost the border it captured is a pi change, and the frame retries every render.
	framed.forceBorderMismatch();
	framed.render(80);
	framed.render(80);
	framed.render(24);
	assert.deepEqual(framed.layoutNotices(), ["unrecognized"]);
});

test("memoizes the bottom border while its inputs hold", (t) => {
	// Regression for the streamed-token hot path: every delta re-renders the lane, but the expensive
	// bottom border must only restyle when one of its inputs actually changes.
	t.mock.method(Date, "now", () => 1_700_000_000_000);
	const quota: QuotaUsage = { limits: [{ label: "5h", percent: 72, resetAt: 1_700_003_600_000 }] };
	const base: HealthState = {
		snapshot: { usedTokens: 20_000, contextWindow: 100_000 },
		usage: { cost: 1.61, cacheHitRate: 98, cacheHitRateAvg: undefined },
		quota,
		speed: { tokensPerSecond: 12, estimated: true },
		frame: 4,
		activity: "working",
		prompt: "success",
	};
	const editor = buildFramedEditor(NERD_GLYPHS, { id: "gpt-test", reasoning: false }, base);
	editor.setText("input");
	editor.render(80);
	const first = editor.tokenCalls();
	editor.render(80);
	const repeated = editor.tokenCalls() - first;
	assert.ok(repeated > 0 && repeated < first, `first=${first} repeated=${repeated}`);
	// A new usage identity invalidates the cache and restyles the metrics again.
	editor.setHealth({ ...base, usage: { cost: 2.5, cacheHitRate: 40, cacheHitRateAvg: undefined } });
	editor.render(80);
	const changed = editor.tokenCalls() - first - repeated;
	assert.ok(changed > repeated, `repeated=${repeated} changed=${changed}`);
});

test("decorative icons never push useful bottom-border info out", () => {
	const model: ModelInfo = { id: "claude-opus", reasoning: true };
	const health: HealthState = {
		snapshot: { usedTokens: 20_000, contextWindow: 100_000 },
		usage: { cost: 1.61, cacheHitRate: 98, cacheHitRateAvg: undefined },
		quota: {
			limits: [
				{ label: "5h", percent: 75, resetAt: Date.now() + 150 * 60_000 },
				{ label: "7d", percent: 43, resetAt: Date.now() + 5 * 86_400_000 },
			],
			resetCredits: 3,
		},
		speed: { tokensPerSecond: 42.25, estimated: true },
		frame: 0,
		activity: "idle",
		prompt: "success",
	};
	const lines = (glyphs: typeof NERD_GLYPHS, width: number): readonly string[] =>
		buildFramedEditor(glyphs, model, health).render(width).map(stripVTControlCharacters);
	const top = (glyphs: typeof NERD_GLYPHS, width: number): string => lines(glyphs, width)[0] ?? "";
	const bottom = (glyphs: typeof NERD_GLYPHS, width: number): string => lines(glyphs, width).at(-1) ?? "";

	// Wide: Nerd decorates the same information; ASCII keeps CH and no icons.
	const wideNerd = bottom(NERD_GLYPHS, 120);
	const wideAscii = bottom(ASCII_GLYPHS, 120);
	assert.ok(wideNerd.includes(NERD_GLYPHS.cache));
	assert.ok(wideNerd.includes(NERD_GLYPHS.reset));
	assert.ok(wideNerd.includes(NERD_GLYPHS.credit));
	assert.ok(top(NERD_GLYPHS, 120).includes(NERD_GLYPHS.speed));
	assert.ok(!wideAscii.includes(NERD_GLYPHS.cache));
	assert.ok(wideAscii.includes("CH98%"));
	assert.ok(wideAscii.includes("R3"));

	// Guard the guard: the baseline really does show every metric we compare against.
	const asciiWideTop = top(ASCII_GLYPHS, 160);
	const asciiWideBottom = bottom(ASCII_GLYPHS, 160);
	for (const token of ["(100K)", "42.3t/s"]) assert.ok(asciiWideTop.includes(token), token);
	for (const token of ["claude-opus", "5h 75%", "7d 43%", "CH98", "$1.61"])
		assert.ok(asciiWideBottom.includes(token), token);

	for (let width = 16; width <= 160; width++) {
		const nerdTop = top(NERD_GLYPHS, width);
		const nerdBottom = bottom(NERD_GLYPHS, width);
		const asciiTop = top(ASCII_GLYPHS, width);
		const asciiBottom = bottom(ASCII_GLYPHS, width);
		if (asciiBottom.includes("claude-opus")) assert.ok(nerdBottom.includes("claude-opus"), `model width=${width}`);
		if (asciiBottom.includes("5h 75%")) assert.ok(nerdBottom.includes("5h 75%"), `quota width=${width}`);
		if (asciiBottom.includes("7d 43%")) assert.ok(nerdBottom.includes("7d 43%"), `quota width=${width}`);
		if (asciiBottom.includes("CH98")) assert.ok(nerdBottom.includes("98%"), `cache width=${width}`);
		if (asciiBottom.includes("$1.61")) assert.ok(nerdBottom.includes("$1.61"), `cost width=${width}`);
		if (asciiTop.includes("(100K)")) assert.ok(nerdTop.includes("(100K)"), `window width=${width}`);
		if (asciiTop.includes("42.3t/s")) assert.ok(nerdTop.includes("42.3t/s"), `speed width=${width}`);
	}
});

test("keeps window percents and cost when quota detail cannot fit", (t) => {
	// Regression: width 51 where the Nerd reset/credit icons (two extra columns vs ASCII) used to
	// drop the cost even though shrinking optional quota detail back to percentages fits everything.
	const now = Date.parse("2026-07-01T00:00:00Z");
	t.mock.method(Date, "now", () => now);
	const health: HealthState = {
		snapshot: { usedTokens: 20_000, contextWindow: 100_000 },
		usage: { cost: 0.042, cacheHitRate: undefined, cacheHitRateAvg: undefined },
		quota: {
			limits: [
				{ label: "5h", percent: 92, resetAt: now + 150 * 60_000 },
				{ label: "7d", percent: 43, resetAt: now + 150 * 60_000 },
			],
			resetCredits: 1,
		},
		speed: null,
		frame: 0,
		activity: "idle",
		prompt: "success",
	};
	for (const glyphs of [NERD_GLYPHS, ASCII_GLYPHS]) {
		const line = stripVTControlCharacters(buildFramedEditor(glyphs, null, health).render(51).at(-1) ?? "");
		assert.ok(line.includes("no-model"), line);
		assert.ok(line.includes("5h 92%"), line);
		assert.ok(line.includes("7d 43%"), line);
		assert.ok(line.includes("$0.042"), line);
	}
	// The optional detail really does fit at 51 in ASCII, so the guard is meaningful.
	const ascii = stripVTControlCharacters(buildFramedEditor(ASCII_GLYPHS, null, health).render(51).at(-1) ?? "");
	assert.ok(ascii.includes("r2h 30m") && ascii.includes("R1"), ascii);
});

test("keeps window percentages and cache before optional thinking on narrow borders", () => {
	// Regression: fitting every model variant against an empty quota let the optional thinking level
	// win, so `gpt-5.6 · medium` hid both window percentages and cache at widths where the bare model
	// plus that essential reading fits. Nerd and ASCII must agree on which numbers survive.
	const model: ModelInfo = { id: "gpt-5.6", reasoning: true };
	const health: HealthState = {
		snapshot: { usedTokens: 20_000, contextWindow: 100_000 },
		usage: { cost: 1.61, cacheHitRate: 98, cacheHitRateAvg: undefined },
		quota: {
			limits: [
				{ label: "5h", percent: 75 },
				{ label: "7d", percent: 43 },
			],
		},
		speed: null,
		frame: 0,
		activity: "idle",
		prompt: "success",
	};
	for (const glyphs of [NERD_GLYPHS, ASCII_GLYPHS]) {
		const bottom = (width: number): string =>
			stripVTControlCharacters(buildFramedEditor(glyphs, model, health, "medium").render(width).at(-1) ?? "");
		for (const width of [37, 40]) {
			const line = bottom(width);
			assert.ok(line.includes("gpt-5.6"), `model width=${width}: ${line}`);
			assert.ok(line.includes("5h 75%") && line.includes("7d 43%"), `quota width=${width}: ${line}`);
			assert.ok(line.includes("98"), `cache width=${width}: ${line}`);
			assert.ok(!line.includes("medium"), `thinking squeezed numbers width=${width}: ${line}`);
		}
		const wide = bottom(120);
		assert.ok(wide.includes("medium") && wide.includes("$1.61"), wide);
	}
});
