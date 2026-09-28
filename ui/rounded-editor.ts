import { stripVTControlCharacters } from "node:util";
import { CustomEditor, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { editorModelOptions, type ModelInfo, renderLabeledBorder } from "../lib/border.ts";
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
import type { TokenSpeedSnapshot } from "../lib/speed.ts";

export type HealthState = Readonly<{
	snapshot: ContextSnapshot;
	usage: SessionUsage;
	quota: QuotaUsage | undefined;
	speed: TokenSpeedSnapshot | null;
	frame: number;
	activity: LaneActivity;
}>;

export type RoundedEditorOptions = Readonly<{
	getModel: () => ModelInfo;
	getThinkingLevel: () => string;
	getHealth: () => HealthState;
	glyphs: GlyphSet;
	onTui: (tui: TUI) => void;
}>;

const isHorizontalBorder = (text: string): boolean => /^─+$/.test(stripVTControlCharacters(text));

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
		x: event.x - (popup ? 2 : 3),
		y: popup ? editorRows + event.y : event.y - popupRows,
		width: event.width - 4,
	};
};

const styleModelLabel = (label: string, ctx: ExtensionContext): string => {
	const separator = label.lastIndexOf(" · ");
	if (separator < 0) return ctx.ui.theme.fg(label === "no-model" ? "muted" : "accent", label);
	return ctx.ui.theme.fg("accent", label.slice(0, separator)) + ctx.ui.theme.fg("dim", label.slice(separator));
};

export const registerRoundedEditor = (ctx: ExtensionContext, options: RoundedEditorOptions): void => {
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
			if (width < 6) {
				this.editorRows = 0;
				return super.render(width);
			}
			const innerWidth = width - 2;
			const rendered = super.render(innerWidth - 2);
			if (rendered.length < 2) return rendered;
			const { editor: lines, autocomplete } = splitEditorRender(rendered, this.bottomBorder);
			this.editorRows = lines.length;
			this.popupRows = autocomplete.length;

			const health = options.getHealth();
			const healthStyles: ChromeStyles = {
				dim: (text) => ctx.ui.theme.fg("dim", text),
				warning: (text) => ctx.ui.theme.fg("warning", text),
				error: (text) => ctx.ui.theme.fg("error", text),
			};
			const scrollUp =
				this.hiddenAbove && width >= 12
					? healthStyles.dim(truncateToWidth(`↑${this.hiddenAbove}`, Math.floor(width / 4), ""))
					: "";
			const scrollDown = this.hiddenBelow ? healthStyles.dim(`↓${this.hiddenBelow}`) : "";
			const scrollReserve = scrollDown ? 1 : 0;
			const prompt = `${ctx.ui.theme.fg("accent", "›")} `;
			const wrap = (line: string, left: string, right: string, prefix: string): string => {
				const borderLike = stripVTControlCharacters(line).endsWith("─");
				const content = borderLike ? line : prefix + line;
				const gap = Math.max(0, innerWidth - visibleWidth(content));
				const fill = borderLike ? this.borderColor("─".repeat(gap)) : " ".repeat(gap);
				return this.borderColor(left) + content + fill + this.borderColor(right);
			};

			const body = lines.slice(1, -1);
			const result = [
				renderLabeledBorder(
					width,
					"╭",
					"╮",
					scrollUp,
					"",
					(text: string) => this.borderColor(text),
					(middleWidth) =>
						renderLaneStrip(
							health.snapshot,
							middleWidth,
							healthStyles,
							health.frame,
							health.activity,
							health.speed,
							options.glyphs,
						),
				),
			];

			for (const [index, line] of body.entries()) {
				result.push(wrap(line, "│", "│", index === 0 ? prompt : "  "));
			}
			const quota = health.quota ? quotaMetricOptions(health.quota, healthStyles) : [""];
			// Quota sits beside the model it belongs to; the model survives before quota.
			const picked = editorModelOptions(options.getModel(), options.getThinkingLevel())
				.flatMap((model) => quota.map((quotaText) => ({ model, quotaText })))
				.find(
					({ model, quotaText }) =>
						2 + visibleWidth(model) + (quotaText ? visibleWidth(quotaText) + 1 : 0) + 3 + 1 + scrollReserve <= width,
				);
			const modelLabel = picked ? styleModelLabel(picked.model, ctx) : "";
			const leftLabel = picked?.model && picked.quotaText ? `${modelLabel} ${picked.quotaText}` : modelLabel;
			const usedByModel = picked
				? visibleWidth(picked.model) + (picked.quotaText ? visibleWidth(picked.quotaText) + 1 : 0) + 3
				: 1;
			const metrics =
				freeMetricOptions(health.usage, healthStyles).find(
					(value) => value === "" || visibleWidth(value) + 4 <= width - 2 - usedByModel - scrollReserve,
				) ?? "";
			result.push(
				renderLabeledBorder(
					width,
					"╰",
					"╯",
					leftLabel,
					metrics,
					(text: string) => this.borderColor(text),
					(space) => {
						if (!scrollDown || space < 1) return "";
						const label = truncateToWidth(scrollDown, space, "");
						return this.borderColor("─".repeat(Math.floor((space - visibleWidth(label)) / 2))) + label;
					},
				),
			);
			const popup = autocomplete.map((line) => `  ${line}${" ".repeat(Math.max(0, width - visibleWidth(line) - 2))}`);
			return [...popup, ...result];
		}
	}

	ctx.ui.setEditorComponent((tui, theme, keybindings) => new ContextBarEditor(tui, theme, keybindings));
};
