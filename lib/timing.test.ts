import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	endAgentRun,
	endTurn,
	formatElapsed,
	healthNotice,
	INITIAL_TIMING,
	isObservableOutput,
	observeOutput,
	settleAgentRun,
	startAgentRun,
	startRequest,
	startTurn,
	type TimingState,
} from "./timing.ts";

const measure = (parts: Readonly<{ request?: number; output: number }>): TimingState => {
	let state = startTurn(INITIAL_TIMING, 0);
	if (parts.request !== undefined) state = startRequest(state, parts.request);
	return observeOutput(state, parts.output, true);
};

describe("observable output", () => {
	test("accepts non-empty deltas and end content, never a bare start or empty delta", () => {
		assert.equal(isObservableOutput({ type: "text_delta", delta: "x" }), true);
		assert.equal(isObservableOutput({ type: "thinking_delta", delta: " " }), true);
		assert.equal(isObservableOutput({ type: "toolcall_delta", delta: "{}" }), true);
		assert.equal(isObservableOutput({ type: "text_delta", delta: "" }), false);
		assert.equal(isObservableOutput({ type: "text_start" }), false);
		assert.equal(isObservableOutput({ type: "toolcall_start" }), false);
		assert.equal(isObservableOutput({ type: "start" }), false);
		assert.equal(isObservableOutput({ type: "text_end", content: "done" }), true);
		assert.equal(isObservableOutput({ type: "text_end", content: "" }), false);
		assert.equal(isObservableOutput({ type: "thinking_end", content: "why" }), true);
		assert.equal(isObservableOutput({ type: "toolcall_end", toolCall: { id: "c" } }), true);
		assert.equal(isObservableOutput({ type: "done" }), false);
	});
});

describe("TTFT", () => {
	test("measures from before_provider_request to the first non-empty delta", () => {
		const state = measure({ request: 150, output: 400 });
		assert.equal(state.lastTtftMs, 250);
		assert.equal(state.request?.ttftMs, 250);
		assert.equal(state.waiting, false);
	});

	test("falls back to turn_start when the transport has no request hook", () => {
		const state = measure({ output: 120 });
		assert.equal(state.lastTtftMs, 120);
	});

	test("empty deltas and later output do not restart or overwrite the measurement", () => {
		let state = startTurn(INITIAL_TIMING, 10);
		state = startRequest(state, 20);
		state = observeOutput(state, 30, false);
		assert.equal(state.lastTtftMs, undefined);
		assert.equal(state.waiting, true);
		state = observeOutput(state, 50, true);
		assert.equal(state.lastTtftMs, 30);
		state = observeOutput(state, 90, true);
		assert.equal(state.lastTtftMs, 30);
		assert.equal(state.request?.ttftMs, 30);
	});

	test("each turn gets a fresh request measurement and keeps the previous one only as last", () => {
		let state = measure({ request: 100, output: 300 });
		state = endTurn(state);
		state = startTurn(state, 1000);
		assert.equal(state.request?.ttftMs, undefined);
		assert.equal(state.lastTtftMs, 200);
		assert.equal(state.waiting, true);
		state = startRequest(state, 1100);
		state = observeOutput(state, 1250, true);
		assert.equal(state.lastTtftMs, 150);
	});

	test("a new request clears a stale pending measurement start", () => {
		let state = startTurn(INITIAL_TIMING, 0);
		state = startRequest(state, 10);
		state = startTurn(state, 500);
		assert.equal(state.request?.turnStartedAt, 500);
		assert.equal(state.request?.requestStartedAt, undefined);
	});
});

describe("agent run", () => {
	test("keeps one run across tool loops and retry agent_start cycles", () => {
		let state = startAgentRun(INITIAL_TIMING, 0);
		state = startTurn(state, 10);
		state = observeOutput(state, 20, true);
		state = endTurn(state);
		state = startTurn(state, 100);
		state = endAgentRun(state);
		// Pi's retry and recovery loop starts another low-level run.
		state = startAgentRun(state, 300);
		state = startTurn(state, 310);
		state = observeOutput(state, 320, true);
		state = endTurn(state);
		state = settleAgentRun(state, 500, false);
		assert.deepEqual(state.lastRun, { ms: 500, turns: 3, aborted: false });
		assert.equal(state.run, undefined);
		assert.equal(state.waiting, false);
	});

	test("settling without a known run does not invent a duration", () => {
		const state = settleAgentRun(INITIAL_TIMING, 99, true);
		assert.equal(state.lastRun, undefined);
		assert.equal(state.waiting, false);
	});

	test("records an aborted run and drops its pending request", () => {
		let state = startAgentRun(INITIAL_TIMING, 0);
		state = startTurn(state, 10);
		state = settleAgentRun(state, 120, true);
		assert.deepEqual(state.lastRun, { ms: 120, turns: 1, aborted: true });
		assert.equal(state.request, undefined);
	});

	test("a settled run never leaks its start into the next run", () => {
		let state = startAgentRun(INITIAL_TIMING, 0);
		state = settleAgentRun(state, 100, false);
		state = startAgentRun(state, 1000);
		state = settleAgentRun(state, 1400, false);
		assert.deepEqual(state.lastRun, { ms: 400, turns: 0, aborted: false });
	});
});

describe("right-slot notice", () => {
	test("Pi's observable phase wins, then waiting, then a held stash", () => {
		const idle = { outputActive: false } as const;
		assert.equal(healthNotice({ phase: "retry", waiting: true, stashed: true, hasSpeed: false, ...idle }), "retrying");
		assert.equal(
			healthNotice({ phase: "compaction", waiting: false, stashed: false, hasSpeed: false, ...idle }),
			"compact",
		);
		assert.equal(
			healthNotice({ phase: "branchSummary", waiting: false, stashed: false, hasSpeed: false, ...idle }),
			"summary",
		);
		assert.equal(
			healthNotice({ phase: "working", waiting: true, stashed: false, hasSpeed: false, ...idle }),
			"waiting",
		);
		assert.equal(healthNotice({ phase: undefined, waiting: true, stashed: true, hasSpeed: false, ...idle }), "waiting");
		assert.equal(healthNotice({ phase: undefined, waiting: false, stashed: true, hasSpeed: false, ...idle }), "stash");
		assert.equal(healthNotice({ phase: undefined, waiting: false, stashed: true, hasSpeed: true, ...idle }), undefined);
		assert.equal(
			healthNotice({ phase: undefined, waiting: false, stashed: false, hasSpeed: false, ...idle }),
			undefined,
		);
		// Live output keeps t/s even if a native phase indicator has not cleared yet.
		assert.equal(
			healthNotice({ phase: "retry", waiting: false, stashed: false, hasSpeed: true, outputActive: true }),
			undefined,
		);
		assert.equal(
			healthNotice({ phase: "retry", waiting: false, stashed: false, hasSpeed: false, outputActive: true }),
			"retrying",
		);
	});

	test("unknown future indicator kinds are not guessed", () => {
		assert.equal(
			healthNotice({ phase: "mystery", waiting: false, stashed: false, hasSpeed: false, outputActive: false }),
			undefined,
		);
	});
});

test("elapsed formatting stays truthful at each magnitude", () => {
	assert.equal(formatElapsed(999), "999 ms");
	assert.equal(formatElapsed(1000), "1.00 s");
	assert.equal(formatElapsed(12_340), "12.3 s");
	assert.equal(formatElapsed(45_600), "45.6 s");
	assert.equal(formatElapsed(60_000), "1m");
	assert.equal(formatElapsed(184_000), "3m 4s");
	assert.equal(formatElapsed(Number.NaN), "?");
	assert.equal(formatElapsed(-1), "?");
});
