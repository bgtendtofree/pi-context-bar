import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { CustomEditor, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import {
	CURSOR_MARKER,
	getKeybindings,
	isFocusable,
	parseColor,
	renderFakeCursor,
	setKeybindings,
	styleText,
	type TerminalColorMode,
	TUI_KEYBINDINGS,
	KeybindingsManager as TuiKeybindingsManager,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ModelInfo } from "../lib/border.ts";
import { ASCII_GLYPHS, NERD_GLYPHS, type QuotaUsage, renderLaneStrip } from "../lib/chrome.ts";
import type { PromptState } from "../lib/prompt.ts";
import type { TokenSpeedSnapshot } from "../lib/speed.ts";
import {
	BODY_INDENT,
	type HealthState,
	POPUP_INDENT,
	RIGHT_GUTTER,
	registerFramedEditor,
	remapEditorMouse,
	sameKey,
	splitEditorRender,
	type WorkingStatusKind,
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
	const bodyX = event.x - BODY_INDENT;
	const popupX = event.x - POPUP_INDENT;
	const width = event.width - (RIGHT_GUTTER + BODY_INDENT);
	assert.deepEqual(remapEditorMouse(event, 2, 5), { ...event, x: popupX, y: 5, width });
	assert.deepEqual(remapEditorMouse({ ...event, y: 3 }, 2, 5), { ...event, x: bodyX, y: 1, width });
});

test("editor uses a full-width lane, bottom rule, open sides, and a flush-left prompt", () => {
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
	assert.equal(rendered.length, 3);
	assert.ok(!rendered.join("").includes("\x1b[48"), "chrome must not emit background escapes");
	assert.doesNotMatch(plain.join(""), /[┌┐└┘│╭╮╰╯]/);
	// The lane owns the full top row, without rule caps or unused border columns.
	assert.equal(
		plain[0],
		renderLaneStrip({ usedTokens: 20_000, contextWindow: 100_000 }, 80, { fg: (_token, text) => text }),
	);
	assert.doesNotMatch(plain[0] ?? "", /─/);
	// The bottom rule uses borderMuted; the right gutter stays blank.
	assert.ok(plain[1]?.startsWith("❯ "));
	assert.ok(plain[1]?.endsWith(" "));
	assert.ok(plain[2]?.startsWith("── "));
	assert.ok(plain[2]?.endsWith("─"));
	assert.equal(seenTokens.get("─")?.at(-1), "borderMuted");
	// Prompt starts at the left edge; the bottom model label keeps column 3.
	assert.equal(plain[2]?.slice(0, 3), "── ");
	assert.equal(plain[1]?.indexOf("❯"), 0);
	assert.equal(plain[2]?.indexOf("a-very-long-model-name"), 3);
	// Two spaces separate the model group from the quota group.
	assert.ok(plain[2]?.includes("medium  5h 30%"));
	// Ready glyph accent; model id accent; thinking and arrow dim.
	assert.equal(seenTokens.get("❯")?.at(-1), "accent");
	assert.equal(seenTokens.get("a-very-long-model-name")?.at(-1), "accent");
	assert.equal(seenTokens.get(" · medium")?.at(-1), "dim");

	// Bash mode recolors the bottom rule without adding top rule caps.
	editor.setText("!ls");
	assert.doesNotMatch(stripVTControlCharacters(editor.render(80)[0] ?? ""), /─/);
	assert.equal(seenTokens.get("─")?.at(-1), "bashMode");
	editor.setText("");

	// Failure glyph error.
	prompt = "error";
	assert.ok(stripVTControlCharacters(editor.render(80)[1] ?? "").startsWith("✗ "));
	assert.equal(seenTokens.get("✗")?.at(-1), "error");

	// Typed input follows the flush-left glyph and one space.
	editor.setText("input");
	assert.equal(stripVTControlCharacters(editor.render(80)[1] ?? "").indexOf("input"), 2);

	editor.setText("first\nsecond");
	const multiline = editor.render(80).map(stripVTControlCharacters);
	assert.ok(multiline[1]?.startsWith("✗ first"));
	assert.ok(multiline[2]?.startsWith("  second"));

	// Text that reads like pi's scroll cue is still body text: framed and indented like any other.
	editor.setText("↑ 3 more");
	assert.equal(stripVTControlCharacters(editor.render(80)[1] ?? "").indexOf("↑ 3 more"), 2);

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
		click(BODY_INDENT + column, 1);
		assert.deepEqual(mouse.getCursor(), { line: 0, col: column }, `column=${column}`);
	}
	// A frame row is not a text row: clicking the top border leaves the cursor where it was.
	click(BODY_INDENT + 3, 0);
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
			assert.equal(visibleWidth(line.slice(0, marker)), BODY_INDENT + visibleWidth(text.split("\n").at(-1) ?? ""));
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
	assert.doesNotMatch(scrolledDown[0] ?? "", /─/);
	assert.ok(scrolledDown.every((line) => visibleWidth(line) === 80));
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
			for (let width = 3; width <= 200; width++) {
				const rows = editor.render(width);
				assert.ok(
					rows.every((line) => visibleWidth(line) <= width),
					`editor width=${width}, speed=${Boolean(speed)}`,
				);
				assert.doesNotMatch(rows.map(stripVTControlCharacters).join(""), /[┌┐└┘│╭╮╰╯]/);
				if (width >= 6) {
					assert.doesNotMatch(stripVTControlCharacters(rows[0] ?? ""), /─/);
					assert.ok(stripVTControlCharacters(rows[1] ?? "").startsWith("✗ "));
					for (const row of rows.slice(1, -1)) {
						const plainRow = stripVTControlCharacters(row);
						assert.ok(plainRow.endsWith(" "), `right gutter width=${width}`);
					}
					assert.ok(
						rows.slice(2, -1).every((row) => stripVTControlCharacters(row).startsWith("  ")),
						`continuation indent width=${width}`,
					);
				}
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
	setPaddingX: (padding: number) => void;
	getPaddingX: () => number;
	setFocused: (focused: boolean) => void;
	handleMouse: (event: TuiMouseEvent) => unknown;
	getCursor: () => { line: number; col: number };
	tokenCalls: () => number;
	forceBorderMismatch: () => void;
	layoutNotices: () => readonly string[];
	setWorkingStatus: (kind: WorkingStatusKind | undefined) => void;
	statusKinds: () => readonly (WorkingStatusKind | undefined)[];
	embedsWorkingStatus: () => boolean;
} => {
	let editor: ReturnType<NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>> | undefined;
	let fgCalls = 0;
	let currentHealth = health;
	const layoutNotices: string[] = [];
	const statusKinds: (WorkingStatusKind | undefined)[] = [];
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
		onWorkingStatus: (kind) => statusKinds.push(kind),
		onUnrecognizedLayout: () => layoutNotices.push("unrecognized"),
		onTui: () => {},
	});
	const built = editor as unknown as {
		render: (width: number) => readonly string[];
		setText: (text: string) => void;
		setPaddingX: (padding: number) => void;
		getPaddingX: () => number;
		focused: boolean;
		handleMouse: (event: TuiMouseEvent) => unknown;
		getCursor: () => { line: number; col: number };
		renderBottomBorder: (width: number, hiddenLineCount: number) => string;
		bottomBorder: string;
		setWorkingStatusIndicator: (indicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]) => void;
		embedWorkingStatus: boolean;
	};
	return {
		render: (width) => built.render(width),
		setText: (text) => built.setText(text),
		setHealth: (next) => {
			currentHealth = next;
		},
		setPaddingX: (padding) => built.setPaddingX(padding),
		getPaddingX: () => built.getPaddingX(),
		setFocused: (focused) => {
			built.focused = focused;
		},
		handleMouse: (event) => built.handleMouse(event),
		getCursor: () => built.getCursor(),
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
		setWorkingStatus: (kind) => {
			// Duck-typed indicator: the frame keeps only `kind`; Pi's own rendering is discarded.
			const indicator =
				kind === undefined
					? undefined
					: ({
							kind,
							renderInBorder: () => "",
							renderSpinnerInBorder: () => "",
							dispose: () => {},
						} as unknown as Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]);
			built.setWorkingStatusIndicator(indicator);
		},
		statusKinds: () => statusKinds,
		embedsWorkingStatus: () => built.embedWorkingStatus === true,
	};
};

test("never trades useful text for the cache icon under real styled themes", () => {
	// Regression (audit round 1, refined in rounds 2–3): the picker used to strip decoration from
	// already-styled ANSI strings, so under a real theme `.startsWith(icon)` never matched and the
	// md-database icon still bought its width by truncating the model. The icon now replaces the
	// equal-width `CH` label, so a cache reading is either labelled or absent — never a bare number.
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
		assert.ok(tight.includes("a-very-long-mod…"), tight);
		assert.ok(tight.includes(`${NERD_GLYPHS.cache} 98%`), tight);
		assert.ok(bottom(long, plainHealth(cache98), "off", 36).includes("a-very-long-model-name"));
		assert.ok(bottom(long, plainHealth(cache98), "off", 36).includes(`${NERD_GLYPHS.cache} 98%`));

		const thinkTight = bottom(thinking, plainHealth(cache98), "medium", 24);
		assert.ok(!thinkTight.includes("medium") && thinkTight.includes(`${NERD_GLYPHS.cache} 98%`), thinkTight);
		const thinkRoomy = bottom(thinking, plainHealth(cache98), "medium", 26);
		assert.ok(thinkRoomy.includes("gpt · medium") && thinkRoomy.includes(`${NERD_GLYPHS.cache} 98%`), thinkRoomy);

		const costTight = bottom(thinking, plainHealth({ ...cache98, cost: 1.61 }), "medium", 31);
		assert.ok(!costTight.includes("medium") && costTight.includes(`${NERD_GLYPHS.cache} 98%  $1.61`), costTight);
		const costRoomy = bottom(thinking, plainHealth({ ...cache98, cost: 1.61 }), "medium", 33);
		assert.ok(costRoomy.includes("gpt · medium") && costRoomy.includes(`${NERD_GLYPHS.cache} 98%`), costRoomy);

		const routeTight = bottom(routed, plainHealth(cache98), "medium", 27);
		assert.ok(routeTight.includes("auto · medium") && routeTight.includes(`${NERD_GLYPHS.cache} 98%`), routeTight);
		assert.ok(!routeTight.includes("→"), routeTight);
		const routeRoomy = bottom(routed, plainHealth(cache98), "medium", 29);
		assert.ok(routeRoomy.includes("auto → gpt-test") && routeRoomy.includes(`${NERD_GLYPHS.cache} 98%`), routeRoomy);
	}
});

test("labels the cache reading instead of spending a bare number on a longer model", () => {
	// Regression (audit rounds 1 and 3): the picker once let the database icon narrow the model, then
	// fell back to an unlabelled `98%` when the icon did not fit. The icon now replaces the equal-width
	// `CH` label, so the reading is always identifiable; without room for it, cache degrades to absent.
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
	for (let width = 8; width <= 40; width++) {
		const line = bottom(width);
		if (line.includes("98%")) assert.ok(line.includes(`${NERD_GLYPHS.cache} 98%`), `width=${width}: ${line}`);
	}
	// The labelled reading narrows the model id to its short form…
	const tight = bottom(34);
	assert.ok(tight.includes("a-very-long-mod…"), tight);
	assert.ok(tight.includes(`${NERD_GLYPHS.cache} 98%`), tight);
	// …and the full id returns as soon as the label fits beside it.
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
	for (const width of [1, 4, 5]) {
		stock.setText("input");
		framed.setText("input");
		assert.deepEqual(framed.render(width), stock.render(width), `width=${width}`);
	}
	// One column more and the frame takes over.
	assert.ok(stripVTControlCharacters(framed.render(6)[1] ?? "").startsWith("❯ "));
});

test("keeps native padding at zero across pi's host and /settings setters", () => {
	// Pi copies defaultEditor.getPaddingX() onto a custom editor after the factory returns
	// (setCustomEditorComponent) and /settings calls that setter again while the editor is live. The
	// frame draws its own two-column body indent, so native padding must stay 0: a copied padding
	// shifts every typed column and, at the frame's minimum width, makes pi's layout recurse on a
	// wide grapheme.
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
	const tui = { requestRender: () => {}, terminal: { rows: 20 } } as unknown as TUI;
	const stock = new CustomEditor(
		tui,
		{ borderColor: (text: string) => text } as EditorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
		{ paddingX: 0 },
	);
	const body = (width = 80): string => stripVTControlCharacters(framed.render(width)[1] ?? "");
	const bodyColumn = BODY_INDENT;

	// The host's padding copy must not move the frame's native padding, and typed text stays at the
	// designed text column (prompt glyph + space).
	assert.equal(framed.getPaddingX(), 0);
	framed.setPaddingX(1);
	assert.equal(framed.getPaddingX(), 0);
	framed.setText("hello");
	assert.equal(body().indexOf("hello"), bodyColumn);

	// /settings calls the setter again later; same contract.
	framed.setPaddingX(3);
	assert.equal(framed.getPaddingX(), 0);
	assert.equal(body().indexOf("hello"), bodyColumn);

	// Wide graphemes at the frame's minimum width used to overflow pi's padded layout into a stack.
	framed.setPaddingX(1);
	for (const text of ["中", "😀", "中文😀"]) {
		framed.setText(text);
		assert.doesNotThrow(() => framed.render(6), text);
		assert.ok(
			framed.render(6).every((line) => visibleWidth(line) === 6),
			text,
		);
	}

	// The narrow fallback is pi's own layout, so it stays the stock padding-0 editor, not a padded one.
	// Widths below 3 are ASCII-only: stock pi overflows on its own with a wide grapheme there, which is
	// outside this frame's contract. Wide graphemes are compared from the width stock can render.
	framed.setPaddingX(2);
	const lastFallbackWidth = RIGHT_GUTTER + BODY_INDENT + 2;
	for (const [text, firstWidth] of [
		["hello", 1],
		["中", 3],
		["emoji 😀", 3],
	] as const) {
		framed.setText(text);
		stock.setText(text);
		for (let width = firstWidth; width <= lastFallbackWidth; width++) {
			assert.deepEqual(framed.render(width), stock.render(width), `text=${text} width=${width}`);
		}
	}

	// Mouse and cursor geometry keep the frame's coordinates after the setters ran.
	framed.setPaddingX(1);
	framed.setText("input");
	framed.render(80);
	const click = (x: number, y: number): void => {
		framed.handleMouse({
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
	click(bodyColumn + 3, 1);
	assert.deepEqual(framed.getCursor(), { line: 0, col: 3 });
	framed.setFocused(true);
	framed.setText("中");
	const cursorLine = framed.render(6).find((line) => line.includes(CURSOR_MARKER)) ?? "";
	assert.equal(visibleWidth(cursorLine.slice(0, cursorLine.indexOf(CURSOR_MARKER))), bodyColumn + visibleWidth("中"));
	framed.setFocused(false);
});

test("re-renders pi's layout at full width when the frame loses its captured border", () => {
	// Regression: the fallback returned the body rendered narrower (the frame's body
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
	framed.render(5);
	assert.deepEqual(framed.layoutNotices(), []);

	// A frame that lost the border it captured is a pi change, and the frame retries every render.
	framed.forceBorderMismatch();
	framed.render(80);
	framed.render(80);
	framed.render(24);
	assert.deepEqual(framed.layoutNotices(), ["unrecognized"]);
});

test("invalidate() recolors the bottom border after pi swaps its stable theme proxy", (t) => {
	t.mock.method(Date, "now", () => 1_700_000_000_000);
	// Pi 1.3 hands extensions a stable theme Proxy: setTheme() swaps the backing palette while
	// ctx.ui.theme keeps its identity, so the memo key cannot see the change. Without invalidate()
	// the model/cache/cost colors stay stale until some other key input moves.
	const darkAccent = TOKEN_HEX.accent ?? "#a0a0ff";
	const darkDim = TOKEN_HEX.dim ?? "#666666";
	const lightAccent = "#010203";
	const lightDim = "#040506";
	let palette: Readonly<Record<string, string>> = TOKEN_HEX;
	let editor: ReturnType<NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>> | undefined;
	const ctx = {
		mode: "tui",
		ui: {
			theme: {
				fg: (token: string, text: string) =>
					styleText(text, { fg: parseColor(palette[token] ?? "#888888") }, "truecolor"),
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
	const health: HealthState = {
		snapshot: { usedTokens: 20_000, contextWindow: 100_000 },
		usage: { cost: 0, cacheHitRate: 98, cacheHitRateAvg: undefined },
		quota: undefined,
		speed: null,
		frame: 0,
		activity: "idle",
		prompt: "success",
	};
	registerFramedEditor(ctx, {
		getModel: () => ({ id: "gpt-test", reasoning: false }),
		getThinkingLevel: () => "high",
		getHealth: () => health,
		getGlyphs: () => ASCII_GLYPHS,
		onTui: () => {},
	});
	assert.ok(editor);
	const framed = editor;
	const accentText = (color: string): string => styleText("gpt-test", { fg: parseColor(color) }, "truecolor");
	const cacheText = (color: string): string => styleText("CH98", { fg: parseColor(color) }, "truecolor");
	const rendered = (): string => framed.render(80).join("\n");
	// Guard the baseline: both memoized groups are styled with the dark palette.
	assert.ok(rendered().includes(accentText(darkAccent)));
	assert.ok(rendered().includes(cacheText(darkDim)));

	// Same Proxy identity, new backing colors.
	palette = { ...TOKEN_HEX, accent: lightAccent, dim: lightDim };
	assert.ok(rendered().includes(accentText(darkAccent)), "memo holds before invalidate");
	framed.invalidate();
	const repainted = rendered();
	assert.ok(repainted.includes(accentText(lightAccent)), "model recolored");
	assert.ok(repainted.includes(cacheText(lightDim)), "cache recolored");
	assert.ok(!repainted.includes(accentText(darkAccent)), "old accent dropped");
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
		assert.doesNotMatch(nerdTop + asciiTop, /─/);
		assert.equal(visibleWidth(nerdTop), width);
		assert.equal(visibleWidth(asciiTop), width);
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

test("keeps the labelled cache and cost before an optional quota countdown", (t) => {
	// The cache label and cost are essential readings; the countdown is spare-width detail. At width 35
	// the labelled reading plus the countdown does not fit, so the countdown waits two columns longer
	// instead of the cache losing its identity.
	const now = 1_800_000_000_000;
	t.mock.method(Date, "now", () => now);
	const health: HealthState = {
		snapshot: { usedTokens: 20_000, contextWindow: 100_000 },
		usage: { cost: 1.61, cacheHitRate: 98, cacheHitRateAvg: 98 },
		quota: { limits: [{ label: "5h", percent: 75, resetAt: now + 3_600_000 }] },
		speed: null,
		frame: 0,
		activity: "idle",
		prompt: "success",
	};
	const bottom = (width: number): string =>
		stripVTControlCharacters(
			buildFramedEditor(NERD_GLYPHS, { id: "gpt", reasoning: false }, health, "off").render(width).at(-1) ?? "",
		);
	const tight = bottom(35);
	assert.ok(tight.includes("gpt"), tight);
	assert.ok(tight.includes("5h 75%"), tight);
	assert.ok(tight.includes(`${NERD_GLYPHS.cache} 98%  $1.61`), tight);
	assert.ok(!tight.includes(NERD_GLYPHS.reset), tight);
	assert.equal(visibleWidth(tight), 35, tight);
	// Spare width brings the countdown back beside the same readings.
	const roomy = bottom(37);
	assert.ok(roomy.includes(`${NERD_GLYPHS.reset} 1h`), roomy);
	assert.ok(roomy.includes(`${NERD_GLYPHS.cache} 98%  $1.61`), roomy);
	assert.equal(visibleWidth(roomy), 37, roomy);
});

test("narrows to the most-used quota window with only its own countdown", (t) => {
	// Regression for the layout gap: a narrow border used to show either every window or none. It now
	// keeps the highest-used window, and that reading's countdown follows it instead of another
	// window's detail being grafted on.
	const now = 1_800_000_000_000;
	t.mock.method(Date, "now", () => now);
	const minute = 60_000;
	const health: HealthState = {
		snapshot: { usedTokens: 20_000, contextWindow: 100_000 },
		usage: { cost: 0, cacheHitRate: undefined, cacheHitRateAvg: undefined },
		quota: {
			limits: [
				{ label: "5h", percent: 10, resetAt: now + 30 * minute },
				{ label: "7d", percent: 75, resetAt: now + 150 * minute },
				{ label: "30d", percent: 40, resetAt: now + 300 * minute },
			],
		},
		speed: null,
		frame: 0,
		activity: "idle",
		prompt: "success",
	};
	const line = stripVTControlCharacters(
		buildFramedEditor(NERD_GLYPHS, { id: "gpt", reasoning: false }, health, "off").render(30).at(-1) ?? "",
	);
	assert.equal(visibleWidth(line), 30, line);
	assert.ok(line.includes("7d 75%"), line);
	// Only the high window's own countdown; the quiet siblings keep their own readings, not this one's.
	assert.ok(line.includes(`${NERD_GLYPHS.reset} 2h 30m`), line);
	assert.ok(!line.includes("5h 10%"), line);
	assert.ok(!line.includes("30d 40%"), line);
});

test("invalidates the bottom memo when the relative countdown crosses its bucket", (t) => {
	// The old key used Math.floor(now / 60_000), so a render that stayed inside one absolute minute
	// kept a countdown the new relative reading had already crossed.
	let now = 1_800_000_000_000; // Exact minute; +31s stays inside the same absolute minute.
	t.mock.method(Date, "now", () => now);
	const health: HealthState = {
		snapshot: { usedTokens: 20_000, contextWindow: 100_000 },
		usage: { cost: 0, cacheHitRate: undefined, cacheHitRateAvg: undefined },
		quota: { limits: [{ label: "5h", percent: 75, resetAt: now + 90_000 }] },
		speed: null,
		frame: 0,
		activity: "idle",
		prompt: "success",
	};
	const editor = buildFramedEditor(ASCII_GLYPHS, { id: "gpt", reasoning: false }, health, "off");
	const bottom = (): string => stripVTControlCharacters(editor.render(80).at(-1) ?? "");
	assert.match(bottom(), /r1m/);
	now += 31_000;
	assert.equal(Math.floor(now / 60_000), Math.floor((now - 31_000) / 60_000));
	assert.match(bottom(), /r<1m/);
	assert.doesNotMatch(bottom(), /r1m/);
});

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
	// The icon carries the notice alone; the words survive only without icons.
	assert.match(after[0] ?? "", new RegExp(NERD_GLYPHS.retrying));
	assert.doesNotMatch(after[0] ?? "", /retrying…/);
	assert.doesNotMatch(after[0] ?? "", /t\/s/);
	// The notice replaces the reading inside the same reserved field; the percent cannot move.
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
