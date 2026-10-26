/** Pure live and completed output-speed measurement. */

export const TOKEN_SPEED_MIN_SAMPLE_MS = 250;
export const TOKEN_SPEED_MIN_FINAL_MS = 100;
export const CHARACTERS_PER_TOKEN = 4;
/** Tool-call arguments stream as JSON, which packs about two characters per token. */
export const TOOL_CHARACTERS_PER_TOKEN = 2;

/** Which delta is being measured; prose and reasoning read denser than JSON arguments. */
export type DeltaKind = "text" | "thinking" | "toolcall";

export type TokenSpeedSnapshot = Readonly<{
	tokensPerSecond: number;
	estimated: boolean;
}>;

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

export const completedTokenSpeed = (outputTokens: number, activeMs: number): TokenSpeedSnapshot | null =>
	outputTokens > 0 && activeMs >= TOKEN_SPEED_MIN_FINAL_MS
		? { tokensPerSecond: (outputTokens * 1000) / activeMs, estimated: false }
		: null;

export const formatTokenSpeed = (speed: TokenSpeedSnapshot | null): string =>
	speed ? `${speed.estimated ? "~" : ""}${speed.tokensPerSecond.toFixed(1)}t/s` : "";
