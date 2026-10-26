/** Shared chrome-test inputs; kept outside lib/ui so production scans never see test helpers. */

import type { ChromeStyles } from "../lib/chrome.ts";
import type { ContextSnapshot, SessionUsage } from "../lib/context.ts";

export const usage = (partial: Partial<SessionUsage> = {}): SessionUsage => ({
	cost: 0,
	cacheHitRate: undefined,
	cacheHitRateAvg: undefined,
	...partial,
});

export const snapshot = (partial: Partial<ContextSnapshot> = {}): ContextSnapshot => ({
	usedTokens: 0,
	contextWindow: 200_000,
	...partial,
});

export const identityStyles: ChromeStyles = { fg: (_token, text) => text };

export const markedStyles: ChromeStyles = { fg: (token, text) => `<${token}>${text}</${token}>` };

/** Foreground-only painter: the chrome must never emit a background escape. */
export const fgOnlyStyles: ChromeStyles = {
	fg: (_token, text) => `\x1b[38;5;7m${text}\x1b[39m`,
};

export const recorder = (): Readonly<{ styles: ChromeStyles; seen: Array<readonly [string, string]> }> => {
	const seen: Array<readonly [string, string]> = [];
	return {
		styles: {
			fg: (token, text) => {
				seen.push([token, text]);
				return text;
			},
		},
		seen,
	};
};

export const dominantSnapshot = snapshot({
	usedTokens: 57_976,
	contextWindow: 372_000,
});
