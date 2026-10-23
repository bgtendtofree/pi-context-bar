import { CustomEditor, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	bottomBorderFits,
	editorModelOptions,
	MODEL_ARROW,
	type ModelInfo,
	pickBottomBorderContent,
	renderLabeledBorder,
} from "../lib/border.ts";
import {
	type ChromeStyles,
	type GlyphSet,
	type LaneActivity,
	metricOptions,
	type QuotaUsage,
	quotaRender,
	renderLaneStrip,
} from "../lib/chrome.ts";
import type { ContextSnapshot, SessionUsage } from "../lib/context.ts";
import { type PromptState, promptColor, promptGlyph } from "../lib/prompt.ts";
import type { TokenSpeedSnapshot } from "../lib/speed.ts";

export type HealthState = Readonly<{
	snapshot: ContextSnapshot;
	usage: SessionUsage;
	quota: QuotaUsage | undefined;
	speed: TokenSpeedSnapshot | null;
	frame: number;
	activity: LaneActivity;
	prompt: PromptState;
}>;

export type FramedEditorOptions = Readonly<{
	getModel: () => ModelInfo;
	getThinkingLevel: () => string;
	getHealth: () => HealthState;
	/**
	 * Read per render rather than captured once: the ASCII fallback is switchable at runtime, and the
	 * bottom-border memo key below needs the live set to notice the switch.
	 */
	getGlyphs: () => GlyphSet;
	/**
	 * Reported once per editor when pi's render shape is not the one the frame assumes, so a pi update
	 * shows up as a message instead of chrome that quietly stopped appearing.
	 */
	onUnrecognizedLayout?: () => void;
	onTui: (tui: TUI) => void;
}>;

/** Open side gutters occupy one column each; popup rows get a two-column gutter. */
export const FRAME_COLUMNS = 1;
export const POPUP_INDENT = 2;
/** Body text sits behind a four-column indent (two spaces, glyph, space). */
export const BODY_INDENT = 4;
/** Two spaces separate the model label group from the quota group. */
export const MODEL_QUOTA_GAP = 2;

/**
 * Split pi's editor render into the editor rows the frame wraps and the autocomplete rows shown above
 * it. The bottom border is matched by the exact string `renderBottomBorder` handed us in this same
 * render pass, never by guessing from text; an empty or missing border (pi changed its render shape,
 * or never rendered one) returns undefined so the caller can keep pi's own layout instead of framing
 * rows it cannot identify — a blank line must never count as a border match.
 */
export const splitEditorRender = (
	lines: readonly string[],
	bottomBorder: string,
): Readonly<{ editor: readonly string[]; autocomplete: readonly string[] }> | undefined => {
	if (!bottomBorder) return undefined;
	const bottomIndex = lines.findLastIndex((line, index) => index > 0 && line === bottomBorder);
	if (bottomIndex === -1) return undefined;
	return { editor: lines.slice(0, bottomIndex + 1), autocomplete: lines.slice(bottomIndex + 1) };
};

export const remapEditorMouse = (event: TuiMouseEvent, popupRows: number, editorRows: number): TuiMouseEvent => {
	const popup = event.y < popupRows;
	return {
		...event,
		x: event.x - (popup ? POPUP_INDENT : FRAME_COLUMNS + BODY_INDENT),
		y: popup ? editorRows + event.y : event.y - popupRows,
		width: event.width - (FRAME_COLUMNS * 2 + BODY_INDENT),
	};
};

/** Element-wise identity compare for memo keys; object entries compare by reference. */
export const sameKey = (a: readonly unknown[], b: readonly unknown[]): boolean =>
	a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

/** Model id in accent, thinking and routed arrow dim; no fill, no padding. */
const styleModelLabel = (label: string, ctx: ExtensionContext): string => {
	return label
		.split(MODEL_ARROW)
		.map((part) => {
			const separator = part.lastIndexOf(" · ");
			const id = separator < 0 ? part : part.slice(0, separator);
			const thinking = separator < 0 ? "" : ctx.ui.theme.fg("dim", part.slice(separator));
			return ctx.ui.theme.fg("accent", id) + thinking;
		})
		.join(ctx.ui.theme.fg("dim", " → "));
};

export const registerFramedEditor = (ctx: ExtensionContext, options: FramedEditorOptions): void => {
	if (ctx.mode !== "tui") return;

	class ContextBarEditor extends CustomEditor {
		private bottomBorder = "";
		private hiddenAbove = 0;
		private hiddenBelow = 0;
		private popupRows = 0;
		private editorRows = 0;
		private bottomKey: readonly unknown[] | null = null;
		private bottomResult: Readonly<{ leftLabel: string; metrics: string }> | null = null;
		private layoutReported = false;

		constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
			super(tui, theme, keybindings, { paddingX: 0 });
			this.setAutocompleteMaxVisible(3);
			options.onTui(tui);
		}

		/**
		 * Pi copies its default editor's padding onto this editor after the factory returns, and /settings
		 * calls the setter again. The frame draws its own body indent, so native padding stays 0: a copied
		 * padding shifts every typed column and, at the frame's minimum width, makes pi's layout recurse
		 * on a wide grapheme.
		 */
		override setPaddingX(_padding: number): void {
			super.setPaddingX(0);
		}

		override renderTopBorder(width: number, hiddenLineCount: number): string {
			this.hiddenAbove = hiddenLineCount;
			return super.renderTopBorder(width, hiddenLineCount);
		}

		override renderBottomBorder(width: number, hiddenLineCount: number): string {
			this.hiddenBelow = hiddenLineCount;
			this.bottomBorder = super.renderBottomBorder(width, hiddenLineCount);
			return this.bottomBorder;
		}

		override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
			return super.handleMouse(this.editorRows ? remapEditorMouse(event, this.popupRows, this.editorRows) : event);
		}

		/** Pi's theme Proxy is stable across setTheme, so the memo key cannot see a palette swap. */
		override invalidate(): void {
			super.invalidate();
			this.bottomKey = null;
			this.bottomResult = null;
		}

		override render(width: number): string[] {
			// Pi reserves a cursor column; a one-column wrap recurses on wide graphemes.
			// Below the frame's four-column indent there is no room for a wrapped cell.
			if (width < FRAME_COLUMNS * 2 + BODY_INDENT + 3) {
				this.editorRows = 0;
				return super.render(width);
			}
			const innerWidth = width - FRAME_COLUMNS * 2;
			// Keep the side gutter and body indent so text, mouse, and IME columns stay aligned.
			const rendered = super.render(innerWidth - BODY_INDENT);
			const split = splitEditorRender(rendered, this.bottomBorder);
			// No captured bottom border means pi's render shape is not the one the frame assumes. Keep
			// pi's own layout rather than framing rows we cannot identify; handleMouse then passes the
			// event through untouched, matching pi's unshifted geometry. Re-render at the full width:
			// `rendered` above is pi's layout narrowed by the frame's body indent, which would leave the
			// editor six columns short of the terminal.
			if (!split) {
				this.editorRows = 0;
				// Once per editor, not per render: the frame retries every frame and pi's shape does not
				// change back mid-session, so a repeated notice would only be noise.
				if (!this.layoutReported) {
					this.layoutReported = true;
					options.onUnrecognizedLayout?.();
				}
				return super.render(width);
			}
			const { editor: lines, autocomplete } = split;
			this.editorRows = lines.length;
			this.popupRows = autocomplete.length;

			const health = options.getHealth();
			const styles: ChromeStyles = { fg: (token, text) => ctx.ui.theme.fg(token, text) };
			const frameToken = this.getText().trimStart().startsWith("!") ? "bashMode" : "borderMuted";
			const frame = (text: string): string => ctx.ui.theme.fg(frameToken, text);
			const scrollUp =
				this.hiddenAbove && width >= 12
					? styles.fg("dim", truncateToWidth(`↑${this.hiddenAbove}`, Math.floor(width / 4), ""))
					: "";
			const scrollDown = this.hiddenBelow ? styles.fg("dim", `↓${this.hiddenBelow}`) : "";
			const scrollReserve = scrollDown ? 1 : 0;
			const prompt = `${" ".repeat(BODY_INDENT - 2)}${ctx.ui.theme.fg(promptColor(health.prompt), promptGlyph(health.prompt, options.getGlyphs()))} `;
			const wrap = (line: string, prefix: string): string => {
				const content = prefix + line;
				const gap = Math.max(0, innerWidth - visibleWidth(content));
				return ` ${content}${" ".repeat(gap)} `;
			};

			const body = lines.slice(1, -1);
			const result = [
				renderLabeledBorder(width, "─", "─", scrollUp, "", frame, (middleWidth) =>
					renderLaneStrip(
						health.snapshot,
						middleWidth,
						styles,
						health.frame,
						health.activity,
						health.speed,
						options.getGlyphs(),
					),
				),
			];

			for (const [index, line] of body.entries()) {
				result.push(wrap(line, index === 0 ? prompt : " ".repeat(BODY_INDENT)));
			}
			const now = Date.now();
			const modelInfo = options.getModel();
			const thinkingLevel = options.getThinkingLevel();
			// The bottom border is the most expensive chrome to style and it changes far less often than the
			// lane. Memoize it on the values it is built from so a streamed token only re-renders the lane;
			// object identity catches new usage/quota, while a theme switch reaches this memo through
			// invalidate() because pi's theme Proxy keeps its identity across setTheme.
			const key: readonly unknown[] = [
				width,
				scrollReserve,
				ctx.ui.theme,
				options.getGlyphs(),
				health.usage,
				health.quota,
				Math.floor(now / 60_000),
				modelInfo?.id ?? null,
				modelInfo?.reasoning ?? null,
				modelInfo?.routed ?? null,
				thinkingLevel,
			];
			let bottom = this.bottomKey && sameKey(this.bottomKey, key) ? this.bottomResult : null;
			if (!bottom) {
				bottom = this.renderBottomContent(width, scrollReserve, health, modelInfo, thinkingLevel, styles, now);
				this.bottomKey = key;
				this.bottomResult = bottom;
			}
			const { leftLabel, metrics } = bottom;
			result.push(
				renderLabeledBorder(width, "─", "─", leftLabel, metrics, frame, (space) => {
					if (!scrollDown || space < 1) return "";
					const label = truncateToWidth(scrollDown, space, "");
					return frame("─".repeat(Math.floor((space - visibleWidth(label)) / 2))) + label;
				}),
			);
			const popup = autocomplete.map((line) => `  ${line}${" ".repeat(Math.max(0, width - visibleWidth(line) - 2))}`);
			return [...popup, ...result];
		}

		/** Bottom-border label + metrics, styled once and reused while its memo key holds. */
		private renderBottomContent(
			width: number,
			scrollReserve: number,
			health: HealthState,
			modelInfo: ModelInfo,
			thinkingLevel: string,
			styles: ChromeStyles,
			now: number,
		): Readonly<{ leftLabel: string; metrics: string }> {
			const quota = health.quota
				? quotaRender(health.quota, styles, now, options.getGlyphs())
				: { essentials: [""], upgrades: [] };
			// Essential reading first: selected model id + window percentages + cache/cost. Optional model
			// detail (thinking level, route arrow) and quota countdowns/credits only spend spare width.
			const picked = pickBottomBorderContent({
				width,
				models: editorModelOptions(modelInfo, thinkingLevel),
				quotas: quota.essentials,
				metrics: metricOptions(health.usage, styles, options.getGlyphs()),
				gap: MODEL_QUOTA_GAP,
				scrollReserve,
			});
			const metrics = picked?.metric ?? "";
			// Optional quota detail (countdowns, credits) expands only into width left after model +
			// window percentages + cache/cost; it never displaces those essential readings.
			const quotaText = picked
				? (quota.upgrades.find((candidate) =>
						bottomBorderFits({
							width,
							model: picked.model,
							quota: candidate,
							metric: metrics,
							gap: MODEL_QUOTA_GAP,
							scrollReserve,
						}),
					) ?? picked.quota)
				: "";
			// The chosen model label is used verbatim; no decorative provider badge.
			const chosenModel = picked?.model ?? "";
			const modelLabel = chosenModel ? styleModelLabel(chosenModel, ctx) : "";
			const leftLabel =
				chosenModel && quotaText ? `${modelLabel}${" ".repeat(MODEL_QUOTA_GAP)}${quotaText}` : modelLabel;
			return { leftLabel, metrics };
		}
	}

	ctx.ui.setEditorComponent((tui, theme, keybindings) => new ContextBarEditor(tui, theme, keybindings));
};
