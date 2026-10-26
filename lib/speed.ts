/** Pure live and completed output-speed measurement. */

export const TOKEN_SPEED_MIN_FINAL_MS = 100;
/** Live reads span at most this window; a pause longer than it drops its older samples. */
export const TOKEN_SPEED_WINDOW_MS = 1000;
/** Below this span the window cannot measure yet, so callers keep the previous reading. */
export const TOKEN_SPEED_MIN_WINDOW_MS = 500;
/** Cap for pathological chunk rates inside one window; the oldest samples go first. */
export const SPEED_SAMPLE_CAP = 256;
export const CHARACTERS_PER_TOKEN = 4;
/** Tool-call arguments stream as JSON, which packs about two characters per token. */
export const TOOL_CHARACTERS_PER_TOKEN = 2;

/** Which delta is being measured; prose and reasoning read denser than JSON arguments. */
export type DeltaKind = "text" | "thinking" | "toolcall";

export type TokenSpeedSnapshot = Readonly<{
	tokensPerSecond: number;
	estimated: boolean;
}>;

/** One cumulative reading: tokens seen so far at a monotonic timestamp. */
export type SpeedSample = Readonly<{ at: number; tokens: number }>;

/**
 * CJK and fullwidth text costs about one token per code unit; a fixed four characters per token
 * would report Chinese, Japanese, and Korean output at a third to a quarter of its real rate.
 */
const isCjk = (code: number): boolean =>
	(code >= 0x2e80 && code <= 0x30ff) ||
	(code >= 0x3105 && code <= 0x312f) ||
	(code >= 0x3400 && code <= 0x4dbf) ||
	(code >= 0x4e00 && code <= 0x9fff) ||
	(code >= 0xac00 && code <= 0xd7a3) ||
	(code >= 0xf900 && code <= 0xfaff) ||
	(code >= 0xff00 && code <= 0xffef);

/** Visible-content estimate: CJK one token per character, everything else by its density. */
export const estimateDeltaTokens = (delta: string, kind: DeltaKind = "text"): number => {
	let cjk = 0;
	for (let index = 0; index < delta.length; index++) if (isCjk(delta.charCodeAt(index))) cjk++;
	const density = kind === "toolcall" ? TOOL_CHARACTERS_PER_TOKEN : CHARACTERS_PER_TOKEN;
	return cjk + (delta.length - cjk) / density;
};

/** Append one cumulative reading and drop samples that fell out of the window. */
export const pushSpeedSample = (
	samples: readonly SpeedSample[],
	at: number,
	tokens: number,
): readonly SpeedSample[] => {
	const next = samples.filter((sample) => at - sample.at <= TOKEN_SPEED_WINDOW_MS);
	next.push({ at, tokens });
	return next.length > SPEED_SAMPLE_CAP ? next.slice(next.length - SPEED_SAMPLE_CAP) : next;
};

/**
 * Sliding-window live rate: newest sample against the oldest one still inside the window.
 * Null before the window spans the minimum interval or after a pause cleared every sample, so
 * the caller keeps its previous reading instead of reporting a cumulative average that a stall
 * drags down. Both gaps inside the window and hidden reasoning stay visible through `estimated`.
 */
export const windowedTokenSpeed = (samples: readonly SpeedSample[]): TokenSpeedSnapshot | null => {
	const newest = samples.at(-1);
	const oldest = samples[0];
	if (!newest || !oldest) return null;
	const tokens = newest.tokens - oldest.tokens;
	const span = newest.at - oldest.at;
	if (tokens <= 0 || span < TOKEN_SPEED_MIN_WINDOW_MS) return null;
	return { tokensPerSecond: (tokens * 1000) / span, estimated: true };
};

/**
 * Live-speed state for one extension session. The last measured reading survives turn and message
 * boundaries; only a live window or a completed turn replaces it. A session with no history keeps
 * `reading` null so callers can show `?t/s` instead of inventing a first-chunk rate.
 */
export type OutputSpeedState = Readonly<{
	reading: TokenSpeedSnapshot | null;
	streamTokens: number;
	streamStartedAt: number | undefined;
	samples: readonly SpeedSample[];
	turnOutputTokens: number;
	turnActiveMs: number;
}>;

export const INITIAL_OUTPUT_SPEED: OutputSpeedState = {
	reading: null,
	streamTokens: 0,
	streamStartedAt: undefined,
	samples: [],
	turnOutputTokens: 0,
	turnActiveMs: 0,
};

/** A new assistant message opens a fresh window but keeps the last measured reading. */
export const restartSpeedStream = (state: OutputSpeedState): OutputSpeedState => ({
	...state,
	streamTokens: 0,
	streamStartedAt: undefined,
	samples: [],
});

/** A new turn clears its accumulators; the last measured reading stays held until measurable again. */
export const resetTurnSpeed = (state: OutputSpeedState): OutputSpeedState => ({
	...restartSpeedStream(state),
	turnOutputTokens: 0,
	turnActiveMs: 0,
});

/** Append streamed tokens and measure the window; an unmeasurable window holds the last reading. */
export const recordSpeedDelta = (state: OutputSpeedState, tokens: number, now: number): OutputSpeedState => {
	const streamStartedAt = state.streamStartedAt ?? now;
	const streamTokens = state.streamTokens + tokens;
	const samples = pushSpeedSample(state.samples, now, streamTokens);
	return {
		...state,
		streamStartedAt,
		streamTokens,
		samples,
		reading: windowedTokenSpeed(samples) ?? (state.reading ? { ...state.reading, estimated: true } : null),
	};
};

/** Close one assistant message's active interval; its output still counts toward the turn. */
export const finishSpeedMessage = (state: OutputSpeedState, outputTokens: number, now: number): OutputSpeedState => ({
	...state,
	turnActiveMs:
		state.streamStartedAt !== undefined ? state.turnActiveMs + now - state.streamStartedAt : state.turnActiveMs,
	turnOutputTokens: state.turnOutputTokens + outputTokens,
	streamStartedAt: undefined,
});

/** Prefer the calibrated turn reading; without one, keep the last live reading. */
export const settleSpeedTurn = (state: OutputSpeedState): OutputSpeedState => ({
	...state,
	reading: completedTokenSpeed(state.turnOutputTokens, state.turnActiveMs) ?? state.reading,
});

export const completedTokenSpeed = (outputTokens: number, activeMs: number): TokenSpeedSnapshot | null =>
	outputTokens > 0 && activeMs >= TOKEN_SPEED_MIN_FINAL_MS
		? { tokensPerSecond: (outputTokens * 1000) / activeMs, estimated: false }
		: null;

export const formatTokenSpeed = (speed: TokenSpeedSnapshot | null): string =>
	speed ? `${speed.estimated ? "~" : ""}${speed.tokensPerSecond.toFixed(1)}t/s` : "";
