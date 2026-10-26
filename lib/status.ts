/** Read-only diagnostics; external statuses are text, never commands or terminal control. */

import { stripVTControlCharacters } from "node:util";
import { formatCost, type QuotaUsage } from "./chrome.ts";
import type { ContextSnapshot, SessionUsage } from "./context.ts";
import {
	type ContextChange,
	type EffectiveContextSummary,
	formatCount,
	formatExactCount,
	type RequestUsage,
} from "./context-audit.ts";
import { formatTokenSpeed, type TokenSpeedSnapshot } from "./speed.ts";
import { STASH_SHORTCUT, STASH_SUBCOMMAND } from "./stash.ts";
import { formatElapsed, type TimingReport } from "./timing.ts";

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
	timing: TimingReport;
	requestUsage: RequestUsage | undefined;
	contextChange: ContextChange | undefined;
	effective: EffectiveContextSummary | undefined;
	effectiveIssue: string | undefined;
	stash: boolean;
	quota: QuotaUsage | undefined;
	quotaSource: string | undefined;
	quotaUpdatedAt: number | undefined;
	quotaIssue: string | undefined;
	statuses: ReadonlyMap<string, string> | undefined;
}>;

const formatChange = (change: ContextChange | undefined): string => {
	if (change === undefined) return "unavailable (no settled run to compare)";
	if ("unavailable" in change) return `unavailable (${diagnosticText(change.unavailable)})`;
	const sign = change.delta >= 0 ? "+" : "";
	return `${sign}${formatExactCount(change.delta)} tokens (${formatExactCount(change.before)} → ${formatExactCount(change.after)}; this run's start → settled reading)`;
};

const effectiveRows = (effective: EffectiveContextSummary | undefined, issue: string | undefined): string[] => {
	if (effective === undefined)
		return [`Effective context: unavailable (${diagnosticText(issue ?? "not observed yet")})`];
	const system =
		effective.systemChars === undefined ? "System: unavailable" : `System: ${formatCount(effective.systemChars)} chars`;
	const tools =
		effective.toolsChars === undefined
			? "Tools: unavailable"
			: `Tools: ${formatCount(effective.toolsChars)} chars${effective.unknownToolSchemas > 0 ? ` (+${effective.unknownToolSchemas} unknown schemas)` : ""}`;
	const images = effective.imageParts > 0 ? ` · ${effective.imageParts} images (not sized)` : "";
	const scanned = effective.truncated ? " · scan truncated" : "";
	const largest = effective.largestToolResults.length
		? effective.largestToolResults
				.map((result) => `${diagnosticText(result.name)} ${formatCount(result.chars)} chars`)
				.join(" · ")
		: "none in effective context";
	return [
		`Effective context (text volume, not provider tokens; last observed at context_with_system · ${new Date(effective.builtAt).toISOString()}; later handlers/provider may still transform it):`,
		`  ${system} · ${tools}`,
		`  Messages: ${formatCount(effective.messagesChars)} · Tool results: ${formatCount(effective.toolResultsChars)} · Summary: ${formatCount(effective.summaryChars)} · Other: ${formatCount(effective.otherChars)} chars${images}${scanned}`,
		`  Largest tool results: ${largest}`,
	];
};

export const renderStatus = (snapshot: StatusSnapshot): string => {
	const { context, usage, quota, statuses, timing } = snapshot;
	const quotaText = quota?.limits.length
		? quota.limits.map((limit) => `${limit.label} ${limit.percent}%`).join(" · ")
		: "unavailable";
	const ttft =
		timing.lastTtftMs !== undefined
			? `${formatElapsed(timing.lastTtftMs)} (last measured request; before_provider_request → first non-empty output, turn_start fallback)`
			: "unavailable (no request has produced non-empty output yet)";
	const run = timing.lastRun
		? `${formatElapsed(timing.lastRun.ms)} · ${timing.lastRun.turns} turns (last settled agent run${timing.lastRun.aborted ? ", aborted" : ""}; retries and tool loops included)`
		: "none settled yet";
	const waiting = `${timing.requestPending ? "yes, no non-empty output yet" : "no"}${timing.phase ? ` · Pi reports phase ${diagnosticText(timing.phase)}` : ""}${timing.runActive ? " · run in progress" : ""}`;
	const requestUsage = snapshot.requestUsage
		? `input ${formatExactCount(snapshot.requestUsage.input)} (uncached) · cache read ${formatExactCount(snapshot.requestUsage.cacheRead)} · cache write ${formatExactCount(snapshot.requestUsage.cacheWrite)} · output ${formatExactCount(snapshot.requestUsage.output)} · total ${formatExactCount(snapshot.requestUsage.total)} tokens (raw last response on the current branch; request traffic, not current context capacity; stop reason ${diagnosticText(snapshot.requestUsage.stopReason)})`
		: "unavailable (latest response has no usable usage report)";
	const rows = [
		"pi-context-bar",
		`Mode: ${snapshot.mode} · glyphs: ${snapshot.ascii ? "ASCII" : "Nerd Font"}`,
		`Model: ${diagnosticText(snapshot.model) || "none"}`,
		`Config: ${diagnosticText(snapshot.config)} (read at session start; glyph toggle is runtime-only)`,
		`Context: ${context.usedTokens ?? "?"} / ${context.contextWindow || "?"} tokens (Pi's current estimate)`,
		`Cache: latest ${usage.cacheHitRate?.toFixed(1) ?? "?"}% · weighted session ${usage.cacheHitRateAvg?.toFixed(1) ?? "?"}%`,
		`Cost: ${formatCost(usage.cost) || "$0"} (recorded estimate, not an invoice)`,
		`Speed: ${formatTokenSpeed(snapshot.speed) || "unavailable"} (~ = visible-content estimate: CJK 1/char, tool JSON 2/char, prose and reasoning 4/char; excludes first-token wait and tool gaps)`,
		`Timing TTFT: ${ttft}`,
		`Timing run: ${run}`,
		`Waiting: ${waiting}`,
		`Context change: ${
			snapshot.contextChange === undefined && timing.runActive
				? "pending (run in progress; settles at agent end)"
				: formatChange(snapshot.contextChange)
		}`,
		`Request usage: ${requestUsage}`,
		...effectiveRows(snapshot.effective, snapshot.effectiveIssue),
		`Stash: ${snapshot.stash ? `1 draft held in memory (never written to disk; ${STASH_SHORTCUT} or /context-bar ${STASH_SUBCOMMAND} restores)` : "none"}`,
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
