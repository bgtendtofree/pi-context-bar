import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnosticText, renderStatus, type StatusSnapshot } from "./status.ts";

const snapshot: StatusSnapshot = {
	mode: "tui",
	model: "demo/model",
	ascii: true,
	config: "/tmp/pi-context-bar.json",
	context: { usedTokens: null, contextWindow: 200_000 },
	usage: { cost: 0, cacheHitRate: undefined, cacheHitRateAvg: undefined },
	speed: null,
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
