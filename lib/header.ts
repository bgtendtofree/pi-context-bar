/** Pure startup header: quiet welcome lines. */

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
	hint.key ? `${styles.dim(hint.key)} ${styles.muted(hint.action)}` : "";

const hintLine = (hints: readonly Hint[], styles: HeaderStyles): string =>
	hints
		.map((hint) => styledHint(hint, styles))
		.filter(Boolean)
		.join(styles.dim(" · "));

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
	const logo = styles.accent("pi") + styles.dim(` v${version}`);
	if (!expanded) {
		const hints = width >= 40 ? hintLine(compactHints, styles) : "";
		return hints ? ["", logo, hints] : ["", logo];
	}
	const rows = expandedHints.map((hint) => styledHint(hint, styles)).filter(Boolean);
	return ["", logo, ...rows];
};
