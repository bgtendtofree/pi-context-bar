import { CustomEditor, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { editorModelOptions, type ModelInfo, pickEditorBorderLabels, renderLabeledBorder } from "../lib/border.ts";
import { type GitState, gitLabelOptions, gitLabelTone } from "../lib/git.ts";
import { stripAnsi } from "../lib/text.ts";

export type RoundedEditorOptions = Readonly<{
	getModel: () => ModelInfo;
	getThinkingLevel: () => string;
	getGit: () => GitState | null;
	onTui: (tui: TUI) => void;
}>;

const isHorizontalBorder = (text: string): boolean => {
	const plain = stripAnsi(text);
	return plain.length > 0 && plain.replace(/─/g, "") === "";
};

const styleModelLabel = (label: string, ctx: ExtensionContext): string => {
	const separator = label.lastIndexOf(" · ");
	if (separator < 0) return ctx.ui.theme.fg(label === "no-model" ? "muted" : "accent", label);
	return (
		ctx.ui.theme.fg("accent", label.slice(0, separator)) +
		ctx.ui.theme.fg("dim", " · ") +
		ctx.ui.theme.fg("dim", label.slice(separator + 3))
	);
};

const styleGitLabel = (label: string, ctx: ExtensionContext): string => {
	if (!label) return "";
	return label
		.split(" ")
		.map((part, index) => ctx.ui.theme.fg(gitLabelTone(part, index), part))
		.join(" ");
};

export const registerRoundedEditor = (ctx: ExtensionContext, options: RoundedEditorOptions): void => {
	if (ctx.mode !== "tui") return;

	class ContextBarEditor extends CustomEditor {
		constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
			super(tui, theme, keybindings, { paddingX: 0 });
			options.onTui(tui);
		}

		override render(width: number): string[] {
			if (width < 6) return super.render(width);
			const innerWidth = width - 2;
			const lines = super.render(innerWidth - 2);
			if (lines.length < 2) return lines;

			const borderColor = (text: string) => this.borderColor(text);
			const prompt = `${ctx.ui.theme.fg("accent", "›")} `;
			const wrap = (line: string, left: string, right: string, prefix: string): string => {
				const borderLike = stripAnsi(line).endsWith("─");
				const content = borderLike ? line : prefix + line;
				const gap = Math.max(0, innerWidth - visibleWidth(content));
				const fill = borderLike ? borderColor("─".repeat(gap)) : " ".repeat(gap);
				return borderColor(left) + content + fill + borderColor(right);
			};

			const bottomIndex = lines.findLastIndex((line, index) => index > 0 && isHorizontalBorder(line));
			const endOfEditor = bottomIndex === -1 ? lines.length : bottomIndex;
			const body = lines.slice(1, endOfEditor);
			const extra = bottomIndex === -1 ? [] : lines.slice(bottomIndex + 1);
			const result = [renderLabeledBorder(width, "╭", "╮", "", "", borderColor)];

			for (const [index, line] of body.entries()) {
				result.push(wrap(line, "│", "│", index === 0 ? prompt : "  "));
			}
			for (const line of extra) result.push(wrap(line, "│", "│", "  "));

			const picked = pickEditorBorderLabels(
				editorModelOptions(options.getModel(), options.getThinkingLevel()),
				gitLabelOptions(options.getGit()),
				width,
			);
			result.push(
				renderLabeledBorder(
					width,
					"╰",
					"╯",
					styleModelLabel(picked.modelLabel, ctx),
					styleGitLabel(picked.gitLabel, ctx),
					borderColor,
				),
			);
			return result;
		}
	}

	ctx.ui.setEditorComponent((tui, theme, keybindings) => new ContextBarEditor(tui, theme, keybindings));
};
