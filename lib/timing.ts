/** Monotonic request latency and full agent-run timing. Pure transitions with an injected clock. */

export type RequestTiming = Readonly<{
	/** `turn_start` timestamp; the fallback start when a transport never emits `before_provider_request`. */
	turnStartedAt: number;
	/** `before_provider_request` timestamp, the measured request start when available. */
	requestStartedAt: number | undefined;
	/** First non-empty text/thinking/tool-call output; undefined until that output arrives. */
	ttftMs: number | undefined;
}>;

export type CompletedRun = Readonly<{ ms: number; turns: number; aborted: boolean }>;

export type TimingState = Readonly<{
	request: RequestTiming | undefined;
	/** Last measured request latency; never presented as the pending request's value. */
	lastTtftMs: number | undefined;
	/** Current low-level run; kept across Pi's retry/recovery `agent_start` cycles. */
	run: Readonly<{ startedAt: number; turns: number }> | undefined;
	lastRun: CompletedRun | undefined;
	/** Pi is busy but no non-empty output has arrived for the current request yet. */
	waiting: boolean;
}>;

/** Display-only view of the timing state for `/context-bar status`. */
export type TimingReport = Readonly<{
	lastTtftMs: number | undefined;
	/** The current request exists but has not produced non-empty output yet. */
	requestPending: boolean;
	runActive: boolean;
	lastRun: CompletedRun | undefined;
	/** Pi's own indicator kind (retry/compaction/branchSummary), undefined when none is shown. */
	phase: string | undefined;
}>;

export const INITIAL_TIMING: TimingState = {
	request: undefined,
	lastTtftMs: undefined,
	run: undefined,
	lastRun: undefined,
	waiting: false,
};

/** An `agent_start` after `agent_end` is Pi's retry/recovery loop, not a new run. */
export const startAgentRun = (state: TimingState, now: number): TimingState => ({
	...state,
	run: state.run ?? { startedAt: now, turns: 0 },
	waiting: true,
});

export const startTurn = (state: TimingState, now: number): TimingState => ({
	...state,
	run: state.run ? { ...state.run, turns: state.run.turns + 1 } : state.run,
	request: { turnStartedAt: now, requestStartedAt: undefined, ttftMs: undefined },
	waiting: true,
});

export const startRequest = (state: TimingState, now: number): TimingState =>
	state.request ? { ...state, request: { ...state.request, requestStartedAt: now } } : state;

/**
 * A start event or an empty delta is not output. Only a non-empty `*_delta` (or an `*_end` that
 * carries content) proves the model produced something observable.
 */
export type ObservableOutput = Readonly<{
	type: string;
	delta?: string | undefined;
	content?: string | undefined;
	toolCall?: unknown;
}>;

export const isObservableOutput = (event: ObservableOutput): boolean => {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return (event.delta?.length ?? 0) > 0;
		case "text_end":
		case "thinking_end":
			return (event.content?.length ?? 0) > 0;
		case "toolcall_end":
			return event.toolCall !== undefined;
		default:
			return false;
	}
};

export const observeOutput = (state: TimingState, now: number, observable: boolean): TimingState => {
	if (!observable) return state;
	const request = state.request;
	// Output proves the wait is over even if an unusual event order left no request start to measure.
	if (!request) return state.waiting ? { ...state, waiting: false } : state;
	if (request.ttftMs !== undefined) return state.waiting ? { ...state, waiting: false } : state;
	const startedAt = request.requestStartedAt ?? request.turnStartedAt;
	const ttftMs = Math.max(0, now - startedAt);
	return {
		...state,
		waiting: false,
		lastTtftMs: ttftMs,
		request: { ...request, ttftMs },
	};
};

/** A finished response ends the pending measurement; the last measured value stays labeled as such. */
export const endTurn = (state: TimingState): TimingState =>
	state.request === undefined && !state.waiting ? state : { ...state, request: undefined, waiting: false };

export const endAgentRun = (state: TimingState): TimingState => (state.waiting ? { ...state, waiting: false } : state);

export const settleAgentRun = (state: TimingState, now: number, aborted: boolean): TimingState => {
	const run = state.run;
	const lastRun = run ? { ms: Math.max(0, now - run.startedAt), turns: run.turns, aborted } : state.lastRun;
	return { ...state, request: undefined, run: undefined, lastRun, waiting: false };
};

/** Short, dim speed-field notice: Pi's own indicator kind first, then waiting, then a held stash. */
export const nativePhaseLabel = (kind: string | undefined): string | undefined => {
	if (kind === "retry") return "retrying…";
	if (kind === "compaction") return "compact…";
	if (kind === "branchSummary") return "summary…";
	return undefined;
};

export const healthNotice = (
	input: Readonly<{
		phase: string | undefined;
		waiting: boolean;
		stashed: boolean;
		hasSpeed: boolean;
		/** A request is active and has already produced observable output. */
		outputActive: boolean;
	}>,
): string | undefined => {
	const phase = nativePhaseLabel(input.phase);
	// Once output flows, the live t/s reading owns the field even if a native phase is still set.
	if (phase && !(input.outputActive && input.hasSpeed)) return phase;
	if (input.waiting) return "waiting…";
	return input.stashed && !input.hasSpeed ? "stash" : undefined;
};

/** Status detail: milliseconds below a second, seconds below a minute, then minutes. */
export const formatElapsed = (ms: number): string => {
	if (!Number.isFinite(ms) || ms < 0) return "?";
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
	const totalSeconds = Math.round(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
};
