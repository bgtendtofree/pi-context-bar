/** Optional user config: ~/.pi/agent/pi-context-bar.json. Missing or corrupt files mean defaults. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type ContextBarConfig = Readonly<{
	/** ASCII glyphs (C/O/0) for terminals without a Nerd Font; default keeps the icons. */
	asciiFallback: boolean;
}>;

export const DEFAULT_CONFIG: ContextBarConfig = { asciiFallback: false };

/**
 * `/context-bar ascii-fallback [on|off|toggle]`: the glyphs to use next, or undefined when the command
 * line means nothing. An omitted mode toggles, and the live value decides the result.
 */
export const nextAsciiFallback = (args: string, current: boolean): boolean | undefined => {
	const [command, mode, ...extra] = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (command !== "ascii-fallback" || extra.length > 0) return undefined;
	if (mode === undefined || mode === "toggle") return !current;
	if (mode === "on") return true;
	if (mode === "off") return false;
	return undefined;
};

export const configPath = (): string => join(getAgentDir(), "pi-context-bar.json");

/** One optional knob; unknown keys and bad JSON stay silent defaults so config never breaks the editor. */
export const readConfig = (path: string): ContextBarConfig => {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return DEFAULT_CONFIG;
		return { asciiFallback: (parsed as Readonly<Record<string, unknown>>).asciiFallback === true };
	} catch {
		return DEFAULT_CONFIG;
	}
};
