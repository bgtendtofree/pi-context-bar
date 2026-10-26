/** Shared framed-editor harness; root test-support keeps it out of runtime scans and the package. */

import type { CustomEditor, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TerminalColorMode, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { parseColor, styleText } from "@earendil-works/pi-tui";
import type { ModelInfo } from "../lib/border.ts";
import type { NERD_GLYPHS } from "../lib/chrome.ts";
import { type HealthState, registerFramedEditor, type WorkingStatusKind } from "../ui/framed-editor.ts";

export const TOKEN_HEX: Readonly<Record<string, string>> = {
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

export const buildFramedEditor = (
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
