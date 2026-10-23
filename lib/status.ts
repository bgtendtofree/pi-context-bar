/** Read-only diagnostics; external statuses are text, never commands or terminal control. */

import { stripVTControlCharacters } from "node:util";
import { formatCost, type QuotaUsage } from "./chrome.ts";
import type { ContextSnapshot, SessionUsage } from "./context.ts";
import { formatTokenSpeed, type TokenSpeedSnapshot } from "./speed.ts";

const ESC = String.fromCharCode(27);
// Node's VT stripper does not reliably remove OSC/DCS payloads; discard complete control strings first.
const CONTROL_STRINGS = new RegExp(
	`(?:${ESC}(?:\\]|P|X|\\^|_)|[\u0090\u0098\u009d-\u009f])[\\s\\S]*?(?:\u0007|${ESC}\\\\|\u009c)`,
	"g",
);

/** Bound before stripping so an extension cannot make inspection process an unbounded string. */
export const diagnosticText = (value: string): string =>
	stripVTControlCharacters(value.slice(0, 4096).replace(CONTROL_STRINGS, ""))
		.replace(/[\p{Cc}\p{Cf}]/gu, "")
		.trim();

export type StatusSnapshot = Readonly<{
	mode: string;
	model: string;
	ascii: boolean;
	config: string;
	context: ContextSnapshot;
	usage: SessionUsage;
	speed: TokenSpeedSnapshot | null;
	quota: QuotaUsage | undefined;
	quotaSource: string | undefined;
	quotaUpdatedAt: number | undefined;
	quotaIssue: string | undefined;
	statuses: ReadonlyMap<string, string> | undefined;
}>;

export const renderStatus = (snapshot: StatusSnapshot): string => {
	const { context, usage, quota, statuses } = snapshot;
	const quotaText = quota?.limits.length
		? quota.limits.map((limit) => `${limit.label} ${limit.percent}%`).join(" · ")
		: "unavailable";
	const rows = [
		"pi-context-bar",
		`Mode: ${snapshot.mode} · glyphs: ${snapshot.ascii ? "ASCII" : "Nerd Font"}`,
		`Model: ${diagnosticText(snapshot.model) || "none"}`,
		`Config: ${diagnosticText(snapshot.config)} (read at session start; glyph toggle is runtime-only)`,
		`Context: ${context.usedTokens ?? "?"} / ${context.contextWindow || "?"} tokens (Pi's current estimate)`,
		`Cache: latest ${usage.cacheHitRate?.toFixed(1) ?? "?"}% · weighted session ${usage.cacheHitRateAvg?.toFixed(1) ?? "?"}%`,
		`Cost: ${formatCost(usage.cost) || "$0"} (recorded estimate, not an invoice)`,
		`Speed: ${formatTokenSpeed(snapshot.speed) || "unavailable"} (~ = characters / 4; excludes first-token wait and tool gaps)`,
		`Quota: ${quotaText}`,
		`Quota source: ${snapshot.quotaSource ?? "none"}${snapshot.quotaUpdatedAt === undefined ? "" : ` · ${new Date(snapshot.quotaUpdatedAt).toISOString()}`}`,
		`Quota note: ${snapshot.mode !== "tui" ? "chrome quota is disabled outside TUI" : (snapshot.quotaIssue ?? "waiting for a usable quota snapshot")}`,
		"Other extension statuses (display-only):",
	];
	if (statuses === undefined) rows.push("  unavailable (this extension no longer owns the footer)");
	else if (statuses.size === 0) rows.push("  none");
	else {
		let count = 0;
		for (const [key, value] of statuses) {
			if (count++ === 64) break;
			rows.push(`  ${diagnosticText(key)}: ${diagnosticText(value)}`);
		}
		if (statuses.size > 64) rows.push(`  … ${statuses.size - 64} more`);
	}
	return rows.join("\n");
};
