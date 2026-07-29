/** Pure live and completed output-speed measurement. */

export const TOKEN_SPEED_MIN_SAMPLE_MS = 250;
export const TOKEN_SPEED_MIN_FINAL_MS = 100;
export const CHARACTERS_PER_TOKEN = 4;

export type TokenSpeedSnapshot = Readonly<{
	tokensPerSecond: number;
	estimated: boolean;
}>;

export const estimateDeltaTokens = (delta: string): number => delta.length / CHARACTERS_PER_TOKEN;

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
