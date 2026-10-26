/** Pure live and completed output-speed measurement. */

export const TOKEN_SPEED_MIN_SAMPLE_MS = 250;
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

/** Cumulative estimated rate since streaming started; elapsed floored to avoid early spikes. */
export const estimateTokenSpeed = (totalTokens: number, elapsedMs: number): TokenSpeedSnapshot | null =>
	totalTokens > 0
		? { tokensPerSecond: (totalTokens * 1000) / Math.max(TOKEN_SPEED_MIN_SAMPLE_MS, elapsedMs), estimated: true }
		: null;

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

export const completedTokenSpeed = (outputTokens: number, activeMs: number): TokenSpeedSnapshot | null =>
	outputTokens > 0 && activeMs >= TOKEN_SPEED_MIN_FINAL_MS
		? { tokensPerSecond: (outputTokens * 1000) / activeMs, estimated: false }
		: null;

export const formatTokenSpeed = (speed: TokenSpeedSnapshot | null): string =>
	speed ? `${speed.estimated ? "~" : ""}${speed.tokensPerSecond.toFixed(1)}t/s` : "";
