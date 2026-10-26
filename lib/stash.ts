/**
 * Pure draft-stash decisions. Pi has no native stash API, so the extension owns one in-memory
 * draft per session; this module only decides what an edit action should do.
 */

/** Alt+S is not bound by Pi's defaults or its reserved extension keys. */
export const STASH_SHORTCUT = "alt+s";
export const STASH_SUBCOMMAND = "stash";

export type StashDecision =
	| Readonly<{ action: "stash" | "restore"; text: string }>
	| Readonly<{ action: "refuse" | "none" }>;

/**
 * Alt+S: stash a non-empty editor, restore into an empty one, never overwrite either side.
 * Text is preserved byte-for-byte, including whitespace.
 */
export const stashDecision = (editorText: string, held: string | undefined): StashDecision => {
	if (editorText.length > 0) return held === undefined ? { action: "stash", text: editorText } : { action: "refuse" };
	return held === undefined ? { action: "none" } : { action: "restore", text: held };
};

/**
 * `/context-bar stash` runs after Pi's editor already cleared the submitted command line, so it can
 * only restore. A non-empty editor is still refused rather than overwritten.
 */
export const restoreDecision = (editorText: string, held: string | undefined): StashDecision => {
	if (held === undefined) return { action: "none" };
	return editorText.length > 0 ? { action: "refuse" } : { action: "restore", text: held };
};

/** Effective keybindings as Pi resolves them; every action is checked, not only reserved ones. */
export type EffectiveKeybindings = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * Alt+S is claimed only when no action (built-in, extension, or user override) already owns it.
 * An unavailable/unknown binding map is not proof of freedom, so the key passes through.
 */
export const stashShortcutFree = (bindings: EffectiveKeybindings | undefined): boolean => {
	if (bindings === undefined) return false;
	return !Object.values(bindings).some((value) =>
		Array.isArray(value) ? value.includes(STASH_SHORTCUT) : value === STASH_SHORTCUT,
	);
};
