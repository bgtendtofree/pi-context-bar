import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnosticText, renderStatus, type StatusSnapshot } from "./status.ts";
import { INITIAL_TIMING } from "./timing.ts";

const snapshot: StatusSnapshot = {
	mode: "tui",
	model: "demo/model",
	ascii: true,
	config: "/tmp/pi-context-bar.json",
	context: { usedTokens: null, contextWindow: 200_000 },
	usage: { cost: 0, cacheHitRate: undefined, cacheHitRateAvg: undefined },
	speed: null,
	timing: { ...INITIAL_TIMING, requestPending: false, runActive: false, phase: undefined },
	requestUsage: undefined,
	contextChange: undefined,
	effective: undefined,
	effectiveIssue: undefined,
	stash: false,
	quota: undefined,
	quotaSource: undefined,
	quotaUpdatedAt: undefined,
	quotaIssue: undefined,
	statuses: new Map(),
};

test("diagnostics explain unavailable readings and never add persistent chrome", () => {
	const output = renderStatus(snapshot);
	assert.match(output, /glyphs: ASCII/);
	assert.match(output, /Context: \? \/ 200000/);
	assert.match(output, /latest \?%/);
	assert.match(output, /Quota: unavailable/);
	assert.match(output, /waiting for a usable quota snapshot/);
	assert.match(output, /Timing TTFT: unavailable/);
	assert.match(output, /Timing run: none settled yet/);
	assert.match(output, /Waiting: no/);
	assert.match(output, /Context change: unavailable/);
	assert.match(output, /Request usage: unavailable \(latest response has no usable usage report\)/);
	assert.match(output, /Effective context: unavailable/);
	assert.match(output, /Stash: none/);
	assert.match(output, /display-only\):\n {2}none$/);
	assert.match(renderStatus({ ...snapshot, mode: "rpc", statuses: undefined }), /disabled outside TUI/);
	assert.match(renderStatus({ ...snapshot, statuses: undefined }), /no longer owns the footer/);
});

test("diagnostics show source, timestamp, estimates and live external statuses", () => {
	const output = renderStatus({
		...snapshot,
		ascii: false,
		context: { usedTokens: 1234, contextWindow: 0 },
		usage: { cost: 0.02, cacheHitRate: 98, cacheHitRateAvg: 91 },
		speed: { estimated: true, tokensPerSecond: 12 },
		quota: { limits: [{ label: "5h", percent: 42 }] },
		quotaSource: "response headers",
		quotaUpdatedAt: 0,
		quotaIssue: "reported by the responding upstream, not a proxy-pool aggregate",
		statuses: new Map([["ci", "tests passed"]]),
	});
	assert.match(output, /glyphs: Nerd Font/);
	assert.match(output, /1234 \/ \?/);
	assert.match(output, /latest 98\.0% · weighted session 91\.0%/);
	assert.match(output, /\$0\.020/);
	assert.match(output, /~12\.0t\/s/);
	assert.match(output, /5h 42%/);
	assert.match(output, /response headers · 1970-01-01T00:00:00.000Z/);
	assert.match(output, /ci: tests passed/);
	assert.match(renderStatus({ ...snapshot, model: "" }), /Model: none/);
});

test("timing, request traffic, context change, effective buckets and stash are shown as observations", () => {
	const output = renderStatus({
		...snapshot,
		context: { usedTokens: 21_000, contextWindow: 200_000 },
		timing: {
			lastTtftMs: 1240,
			requestPending: true,
			runActive: true,
			lastRun: { ms: 45_600, turns: 3, aborted: true },
			phase: "retry",
		},
		requestUsage: {
			input: 500,
			cacheRead: 12_300,
			cacheWrite: 400,
			output: 900,
			total: 14_100,
			reasoning: 100,
			stopReason: "stop",
		},
		contextChange: { before: 20_000, after: 21_000, delta: 1000 },
		effective: {
			systemChars: 12_300,
			toolsChars: 8100,
			unknownToolSchemas: 2,
			messagesChars: 45_000,
			toolResultsChars: 202_000,
			summaryChars: 3200,
			otherChars: 800,
			imageParts: 2,
			largestToolResults: [
				{ name: "bash", chars: 120_000 },
				{ name: "read", chars: 40_200 },
				{ name: "edit", chars: 12_000 },
			],
			truncated: true,
			builtAt: 0,
		},
		effectiveIssue: undefined,
		stash: true,
	});
	assert.match(output, /Timing TTFT: 1\.24 s \(last measured request/);
	assert.match(output, /Timing run: 45\.6 s · 3 turns \(last settled agent run, aborted/);
	assert.match(output, /Waiting: yes, no non-empty output yet · Pi reports phase retry · run in progress/);
	assert.match(output, /Context change: \+1000 tokens \(20000 → 21000/);
	assert.match(output, /input 500 \(uncached\) · cache read 12300 · cache write 400 · output 900 · total 14100/);
	assert.match(output, /request traffic, not current context capacity/);
	assert.match(output, /last observed at context_with_system/);
	assert.match(output, /System: 12\.3K chars · Tools: 8\.1K chars \(\+2 unknown schemas\)/);
	assert.match(output, /Messages: 45K · Tool results: 202K · Summary: 3\.2K · Other: 800 chars/);
	assert.match(output, /2 images \(not sized\) · scan truncated/);
	assert.match(output, /Largest tool results: bash 120K chars · read 40\.2K chars · edit 12K chars/);
	assert.match(output, /Stash: 1 draft held in memory/);
	assert.doesNotMatch(output, /unavailable \(not observed/);
});

test("unavailable effective sources and invalidated deltas stay explicit", () => {
	const output = renderStatus({
		...snapshot,
		timing: {
			lastTtftMs: undefined,
			requestPending: false,
			runActive: false,
			lastRun: { ms: 1000, turns: 1, aborted: false },
			phase: undefined,
		},
		contextChange: { unavailable: "compaction changed the context" },
		effective: {
			systemChars: undefined,
			toolsChars: 0,
			unknownToolSchemas: 0,
			messagesChars: 0,
			toolResultsChars: 0,
			summaryChars: 0,
			otherChars: 0,
			imageParts: 0,
			largestToolResults: [],
			truncated: false,
			builtAt: 0,
		},
		effectiveIssue: undefined,
	});
	assert.match(output, /Context change: unavailable \(compaction changed the context\)/);
	assert.match(output, /System: unavailable · Tools: 0 chars/);
	assert.match(output, /Largest tool results: none in effective context/);
	assert.match(output, /Stash: none/);
	assert.match(
		renderStatus({ ...snapshot, effective: undefined, effectiveIssue: "Pi session projection unavailable" }),
		/Effective context: unavailable \(Pi session projection unavailable\)/,
	);
});

test("external status inspection strips terminal controls and bidi overrides, bounds text and row count", () => {
	const esc = String.fromCharCode(27);
	assert.equal(diagnosticText(`${esc}[31mred${esc}[0m\n\u202Etext`), "redtext");
	assert.equal(diagnosticText(`${esc}]0;spoof title\u0007safe`), "safe");
	assert.equal(diagnosticText(`${esc}Pspoof${esc}\\safe`), "safe");
	assert.equal(diagnosticText("\u009d0;spoof\u009csafe"), "safe");
	assert.equal(diagnosticText("x".repeat(5000)).length, 4096);
	const statuses = new Map(Array.from({ length: 70 }, (_, i) => [`key${i}`, `${esc}[2Jvalue`]));
	const output = renderStatus({ ...snapshot, statuses });
	assert.match(output, /key63: value/);
	assert.doesNotMatch(output, /key64/);
	assert.match(output, /6 more/);
	assert.ok(!output.includes(esc));
});

test("an active run shows a pending context delta instead of a previous settled reading", () => {
	const output = renderStatus({
		...snapshot,
		timing: { ...snapshot.timing, runActive: true },
		contextChange: undefined,
	});
	assert.match(output, /Context change: pending \(run in progress; settles at agent end\)/);
	assert.doesNotMatch(output, /tokens \(.*this run's start/);
});
