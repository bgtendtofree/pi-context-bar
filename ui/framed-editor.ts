import { stripVTControlCharacters } from "node:util";
import { CustomEditor, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { editorModelOptions, MODEL_ARROW, type ModelInfo, renderLabeledBorder } from "../lib/border.ts";
import {
	type ChromeStyles,
	freeMetricOptions,
	type GlyphSet,
	type LaneActivity,
	type QuotaUsage,
	quotaMetricOptions,
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
	glyphs: GlyphSet;
	onTui: (tui: TUI) => void;
}>;

const isHorizontalBorder = (text: string): boolean => /^─+$/.test(stripVTControlCharacters(text));

/** Frame side glyphs occupy one column each; popup rows get a two-column gutter. */
export const FRAME_COLUMNS = 1;
export const POPUP_INDENT = 2;
/** Body text sits behind a four-column indent (two spaces, glyph, space). */
export const BODY_INDENT = 4;
/** Two spaces separate the model label group from the quota group. */
export const MODEL_QUOTA_GAP = 2;

export const splitEditorRender = (
	lines: readonly string[],
	bottomBorder?: string,
): Readonly<{ editor: readonly string[]; autocomplete: readonly string[] }> => {
	const bottomIndex = lines.findLastIndex(
		(line, index) => index > 0 && (bottomBorder ? line === bottomBorder : isHorizontalBorder(line)),
	);
	if (bottomIndex === -1) return { editor: lines, autocomplete: [] };
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

		constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
			super(tui, theme, keybindings, { paddingX: 0 });
			this.setAutocompleteMaxVisible(3);
			options.onTui(tui);
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

		override render(width: number): string[] {
			// Pi reserves a cursor column; a one-column wrap recurses on wide graphemes.
			// Below the frame's four-column indent there is no room for a wrapped cell.
			if (width < FRAME_COLUMNS * 2 + BODY_INDENT + 3) {
				this.editorRows = 0;
				return super.render(width);
			}
			const innerWidth = width - FRAME_COLUMNS * 2;
			// Text sits four columns in (frame + two spaces + glyph + space), so the editor renders four narrower.
			const rendered = super.render(innerWidth - BODY_INDENT);
			if (rendered.length < 2) return rendered;
			const { editor: lines, autocomplete } = splitEditorRender(rendered, this.bottomBorder);
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
			const prompt = `${" ".repeat(BODY_INDENT - 2)}${ctx.ui.theme.fg(promptColor(health.prompt), promptGlyph(health.prompt, options.glyphs))} `;
			const wrap = (line: string, left: string, right: string, prefix: string): string => {
				const borderLike = stripVTControlCharacters(line).endsWith("─");
				const content = borderLike ? line : prefix + line;
				const gap = Math.max(0, innerWidth - visibleWidth(content));
				const fill = borderLike ? frame("─".repeat(gap)) : " ".repeat(gap);
				return frame(left) + content + fill + frame(right);
			};

			const body = lines.slice(1, -1);
			const result = [
				renderLabeledBorder(width, "┌", "┐", scrollUp, "", frame, (middleWidth) =>
					renderLaneStrip(
						health.snapshot,
						middleWidth,
						styles,
						health.frame,
						health.activity,
						health.speed,
						options.glyphs,
					),
				),
			];

			for (const [index, line] of body.entries()) {
				result.push(wrap(line, "│", "│", index === 0 ? prompt : " ".repeat(BODY_INDENT)));
			}
			const quota = health.quota ? quotaMetricOptions(health.quota, styles, Date.now(), options.glyphs) : [""];
			// Quota sits beside the model it belongs to; the model survives before quota.
			const picked = editorModelOptions(options.getModel(), options.getThinkingLevel())
				.flatMap((model) => quota.map((quotaText) => ({ model, quotaText })))
				.find(
					({ model, quotaText }) =>
						2 +
							visibleWidth(model) +
							(quotaText ? visibleWidth(quotaText) + MODEL_QUOTA_GAP : 0) +
							3 +
							1 +
							scrollReserve <=
						width,
				);
			const modelLabel = picked ? styleModelLabel(picked.model, ctx) : "";
			const leftLabel =
				picked?.model && picked.quotaText
					? `${modelLabel}${" ".repeat(MODEL_QUOTA_GAP)}${picked.quotaText}`
					: modelLabel;
			const usedByModel = picked
				? visibleWidth(picked.model) + (picked.quotaText ? visibleWidth(picked.quotaText) + MODEL_QUOTA_GAP : 0) + 3
				: 1;
			const metrics =
				freeMetricOptions(health.usage, styles).find(
					(value) => value === "" || visibleWidth(value) + 4 <= width - 2 - usedByModel - scrollReserve,
				) ?? "";
			result.push(
				renderLabeledBorder(width, "└", "┘", leftLabel, metrics, frame, (space) => {
					if (!scrollDown || space < 1) return "";
					const label = truncateToWidth(scrollDown, space, "");
					return frame("─".repeat(Math.floor((space - visibleWidth(label)) / 2))) + label;
				}),
			);
			const popup = autocomplete.map((line) => `  ${line}${" ".repeat(Math.max(0, width - visibleWidth(line) - 2))}`);
			return [...popup, ...result];
		}
	}

	ctx.ui.setEditorComponent((tui, theme, keybindings) => new ContextBarEditor(tui, theme, keybindings));
};
