/** Pure startup header: Pac-Man sweep frame + quiet welcome lines. */

import { renderPacmanLane } from "./chrome.ts";
import type { ContextSnapshot } from "./context.ts";

/** Sweep crosses the lane in this many frames (~600ms at 60ms/frame). */
export const SWEEP_FRAMES = 10;

export type HeaderStyles = Readonly<{
	accent: (text: string) => string;
	dim: (text: string) => string;
	muted: (text: string) => string;
}>;

export type WelcomeInfo = Readonly<{
	version: string;
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

/** "+"/"/" combos like pi's keyText: ctrl+c, cmd on darwin shows alt as option. */
export const formatKeyText = (keys: readonly string[], platform: NodeJS.Platform): string =>
	keys
		.map((key) =>
			key
				.split("+")
				.map((part) => (platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part))
				.join("+"),
		)
		.join("/");

/** Sweep frame: Pac-Man eats left → right across the width, frame SWEEP_FRAMES = all eaten. */
export const renderSweepLine = (frame: number, width: number): string => {
	if (width <= 2) return "";
	const ratio = Math.min(1, Math.max(0, frame / SWEEP_FRAMES));
	const snapshot: ContextSnapshot = { usedTokens: Math.round(ratio * 1000), contextWindow: 1000 };
	return renderPacmanLane(snapshot, width, frame, "working");
};

const styledHint = (hint: Hint, styles: HeaderStyles): string =>
	hint.key ? `${styles.dim(hint.key)} ${styles.muted(hint.action)}` : "";

const hintLine = (hints: readonly Hint[], styles: HeaderStyles): string =>
	hints
		.map((hint) => styledHint(hint, styles))
		.filter(Boolean)
		.join(styles.dim(" · "));

/** Quiet welcome lines. Collapsed: logo row + one hint row. Expanded: logo row + hint list. */
export const renderWelcome = (
	info: WelcomeInfo,
	compactHints: readonly Hint[],
	expandedHints: readonly Hint[],
	expanded: boolean,
	width: number,
	styles: HeaderStyles,
): readonly string[] => {
	if (width <= 0) return [];
	const logo = styles.accent("pi") + styles.dim(` v${info.version}`);
	if (!expanded) {
		const hints = width >= 40 ? hintLine(compactHints, styles) : "";
		return hints ? ["", logo, hints] : ["", logo];
	}
	const rows = expandedHints.map((hint) => styledHint(hint, styles)).filter(Boolean);
	return ["", logo, ...rows];
};
