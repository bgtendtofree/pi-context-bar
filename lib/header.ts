/** Pure startup header: quiet welcome lines. */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type HeaderStyles = Readonly<{
	accent: (text: string) => string;
	dim: (text: string) => string;
	muted: (text: string) => string;
}>;

/** One resolved keybinding hint: display key plus what it does. */
export type Hint = Readonly<{ key: string; action: string }>;

/** Keybinding ids mirrored from pi's built-in header, compact row. */
export const COMPACT_HINT_DEFS = [
	{ id: "app.interrupt", action: "interrupt" },
	{ id: "app.exit", action: "exit" },
	{ id: "", action: "commands", rawKey: "/" },
	{ id: "", action: "bash", rawKey: "!" },
	{ id: "app.tools.expand", action: "more" },
] as const;

/** Keybinding ids mirrored from pi's built-in header, expanded list. */
export const EXPANDED_HINT_DEFS = [
	{ id: "app.interrupt", action: "interrupt" },
	{ id: "app.clear", action: "clear" },
	{ id: "app.exit", action: "exit (empty)" },
	{ id: "app.suspend", action: "suspend" },
	{ id: "app.thinking.cycle", action: "cycle thinking" },
	{ id: "app.model.cycleForward", action: "cycle models" },
	{ id: "app.model.select", action: "select model" },
	{ id: "app.editor.external", action: "external editor" },
	{ id: "app.message.followUp", action: "queue follow-up" },
	{ id: "app.clipboard.pasteImage", action: "paste image" },
] as const;

const styledHint = (hint: Hint, styles: HeaderStyles): string =>
	hint.key ? `${styles.muted(hint.key)} ${styles.dim(hint.action)}` : "";

const hintLine = (hints: readonly Hint[], styles: HeaderStyles, width: number): string => {
	let line = "";
	for (const hint of hints) {
		const text = styledHint(hint, styles);
		if (!text) continue;
		const next = line ? `${line}${styles.dim(" · ")}${text}` : text;
		if (visibleWidth(next) > width) continue;
		line = next;
	}
	return line;
};

/** Quiet welcome lines. Collapsed: logo row + one hint row. Expanded: logo row + hint list. */
export const renderWelcome = (
	version: string,
	compactHints: readonly Hint[],
	expandedHints: readonly Hint[],
	expanded: boolean,
	width: number,
	styles: HeaderStyles,
): readonly string[] => {
	if (width <= 0) return [];
	// Match the editor's border + prompt columns; leave room for the logo on tiny terminals.
	const padding = Math.min(3, width - 1);
	const prefix = " ".repeat(padding);
	const contentWidth = width - padding;
	const logo = prefix + truncateToWidth(styles.accent("pi") + styles.dim(` v${version}`), contentWidth);
	if (!expanded) {
		const hints = width >= 40 ? hintLine(compactHints, styles, contentWidth) : "";
		return hints ? ["", logo, prefix + hints] : ["", logo];
	}
	const rows = expandedHints
		.map((hint) => styledHint(hint, styles))
		.filter(Boolean)
		.filter((row) => visibleWidth(row) <= contentWidth)
		.map((row) => prefix + row);
	return ["", logo, ...rows];
};
