/** Pure startup header: quiet welcome lines. */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type HeaderStyles = Readonly<{
	accent: (text: string) => string;
	dim: (text: string) => string;
}>;

/** Startup mark: the block mark, or the text wordmark where half blocks misalign. */
export type HeaderMark = "block" | "text";

/**
 * pi's 4x4 pixel mark rewritten as half blocks, one theme token per cell: `▀▀█` over `█▀ █`.
 * Same silhouette as pi's own logo, but solid `accent`/`dim` instead of fixed brand colors.
 * Omarchy prints its logo the same way: a single-color block wordmark, then a blank line.
 */
export const PI_MARK_LINES = ["▀▀█", "█▀ █"] as const;

/** Mark column: the frame plus the editor's two-column gutter, where the `❯` prompt sits. */
export const HEADER_INDENT = 3;

/** Gap between the mark's second row and the compact hints sharing that row. */
const MARK_GAP = "  ";

/** One resolved keybinding hint: display key plus what it does. */
export type Hint = Readonly<{ key: string; action: string }>;

/** Keybinding ids mirrored from pi's built-in header, compact row. `/` and `!` are plain keys, not bindings. */
export const COMPACT_HINT_DEFS = [
	{ id: "app.interrupt", action: "interrupt" },
	{ id: "app.exit", action: "exit" },
	{ action: "commands", rawKey: "/" },
	{ action: "bash", rawKey: "!" },
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
	hint.key ? `${styles.accent(hint.key)} ${styles.dim(hint.action)}` : "";

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

const hintRows = (hints: readonly Hint[], styles: HeaderStyles, contentWidth: number): readonly string[] =>
	hints.map((hint) => styledHint(hint, styles)).filter((row) => row !== "" && visibleWidth(row) <= contentWidth);

/**
 * Quiet welcome lines. Collapsed: mark rows + one hint row. Expanded: mark rows + hint list.
 * The mark row keeps the version on its first line and, when collapsed, the hints on its second.
 */
export const renderWelcome = (
	version: string,
	compactHints: readonly Hint[],
	expandedHints: readonly Hint[],
	expanded: boolean,
	mark: HeaderMark,
	width: number,
	styles: HeaderStyles,
): readonly string[] => {
	if (width <= 0) return [];
	// Match the editor's border + prompt columns; leave room for the mark on tiny terminals.
	const padding = Math.min(HEADER_INDENT, Math.max(width - 1, 0));
	const prefix = " ".repeat(padding);
	const contentWidth = width - padding;
	const versionLabel = styles.dim(`v${version}`);
	const [top, bottom] = PI_MARK_LINES;
	const markWidth = Math.max(visibleWidth(top), visibleWidth(bottom));
	const fit = (text: string): string => prefix + truncateToWidth(text, contentWidth);

	if (mark !== "block" || padding + markWidth > width) {
		// Text wordmark: narrow terminals and terminals that misalign half blocks.
		const logo = fit(`${styles.accent("pi")} ${versionLabel}`);
		if (!expanded) {
			const hints = width >= 40 ? hintLine(compactHints, styles, contentWidth) : "";
			return hints ? ["", logo, prefix + hints] : ["", logo];
		}
		return ["", logo, ...hintRows(expandedHints, styles, contentWidth).map((row) => prefix + row)];
	}

	const markTop = fit(`${styles.accent(top)} ${versionLabel}`);
	const markBottom = prefix + styles.accent(bottom);
	if (expanded) {
		return ["", markTop, markBottom, ...hintRows(expandedHints, styles, contentWidth).map((row) => prefix + row)];
	}

	const hints =
		width >= 40 ? hintLine(compactHints, styles, contentWidth - visibleWidth(bottom) - MARK_GAP.length) : "";
	return hints ? ["", markTop, `${markBottom}${MARK_GAP}${hints}`] : ["", markTop, markBottom];
};
