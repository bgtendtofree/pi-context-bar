import { stripVTControlCharacters } from "node:util";
import { CustomEditor, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { editorModelOptions, type ModelInfo, renderLabeledBorder } from "../lib/border.ts";
import {
	breathingBorderColor,
	type ChromeStyles,
	freeMetricOptions,
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
	breathFrame: number;
}>;

export type RoundedEditorOptions = Readonly<{
	getModel: () => ModelInfo;
	getThinkingLevel: () => string;
	getHealth: () => HealthState;
	onTui: (tui: TUI) => void;
}>;

const isHorizontalBorder = (text: string): boolean => {
	const plain = stripVTControlCharacters(text);
	return plain.length > 0 && plain.replace(/─/g, "") === "";
};

export const splitEditorRender = (
	lines: readonly string[],
): Readonly<{ editor: readonly string[]; autocomplete: readonly string[] }> => {
	const bottomIndex = lines.findLastIndex((line, index) => index > 0 && isHorizontalBorder(line));
	if (bottomIndex === -1) return { editor: lines, autocomplete: [] };
	return { editor: lines.slice(0, bottomIndex + 1), autocomplete: lines.slice(bottomIndex + 1) };
};

const styleModelLabel = (label: string, ctx: ExtensionContext): string => {
	const separator = label.lastIndexOf(" · ");
	if (separator < 0) return ctx.ui.theme.fg(label === "no-model" ? "muted" : "accent", label);
	return ctx.ui.theme.fg("accent", label.slice(0, separator)) + ctx.ui.theme.fg("dim", label.slice(separator));
};

export const registerRoundedEditor = (ctx: ExtensionContext, options: RoundedEditorOptions): void => {
	if (ctx.mode !== "tui") return;

	class ContextBarEditor extends CustomEditor {
		constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
			super(tui, theme, keybindings, { paddingX: 0 });
			this.setAutocompleteMaxVisible(3);
			options.onTui(tui);
		}

		override render(width: number): string[] {
			if (width < 6) return super.render(width);
			const innerWidth = width - 2;
			const rendered = super.render(innerWidth - 2);
			if (rendered.length < 2) return rendered;
			const { editor: lines, autocomplete } = splitEditorRender(rendered);

			const health = options.getHealth();
			const borderColor =
				health.activity === "idle"
					? (text: string) => this.borderColor(text)
					: breathingBorderColor(health.breathFrame);
			const healthStyles: ChromeStyles = {
				dim: (text) => ctx.ui.theme.fg("dim", text),
				warning: (text) => ctx.ui.theme.fg("warning", text),
				error: (text) => ctx.ui.theme.fg("error", text),
			};
			const prompt = `${ctx.ui.theme.fg("accent", "›")} `;
			const wrap = (line: string, left: string, right: string, prefix: string): string => {
				const borderLike = stripVTControlCharacters(line).endsWith("─");
				const content = borderLike ? line : prefix + line;
				const gap = Math.max(0, innerWidth - visibleWidth(content));
				const fill = borderLike ? borderColor("─".repeat(gap)) : " ".repeat(gap);
				return borderColor(left) + content + fill + borderColor(right);
			};

			const body = lines.slice(1, -1);
			const result = [
				renderLabeledBorder(width, "╭", "╮", "", "", borderColor, (middleWidth) =>
					renderLaneStrip(health.snapshot, middleWidth, healthStyles, health.frame, health.activity, health.speed),
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
						2 + visibleWidth(model) + (quotaText ? visibleWidth(quotaText) + 1 : 0) + 3 + 1 <= width,
				);
			const modelLabel = picked ? styleModelLabel(picked.model, ctx) : "";
			const leftLabel = picked?.model && picked.quotaText ? `${modelLabel} ${picked.quotaText}` : modelLabel;
			const usedByModel = picked
				? visibleWidth(picked.model) + (picked.quotaText ? visibleWidth(picked.quotaText) + 1 : 0) + 3
				: 1;
			const metrics =
				freeMetricOptions(health.usage, healthStyles).find(
					(value) => value === "" || visibleWidth(value) + 4 <= width - 2 - usedByModel,
				) ?? "";
			result.push(renderLabeledBorder(width, "╰", "╯", leftLabel, metrics, borderColor));
			const popup = autocomplete.map((line) => `  ${line}${" ".repeat(Math.max(0, width - visibleWidth(line) - 2))}`);
			return [...popup, ...result];
		}
	}

	ctx.ui.setEditorComponent((tui, theme, keybindings) => new ContextBarEditor(tui, theme, keybindings));
};
