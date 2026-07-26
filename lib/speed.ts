/** Pure live and completed output-speed measurement. */

export const TOKEN_SPEED_WINDOW_MS = 1000;
export const TOKEN_SPEED_MIN_SAMPLE_MS = 250;
export const TOKEN_SPEED_MIN_FINAL_MS = 100;
export const CHARACTERS_PER_TOKEN = 4;

export type TokenSpeedSnapshot = Readonly<{
	tokensPerSecond: number;
	estimated: boolean;
}>;

export type TokenSpeedSample = Readonly<{
	time: number;
	tokens: number;
}>;

export const estimateDeltaTokens = (delta: string): number => delta.length / CHARACTERS_PER_TOKEN;

export const recordTokenSpeed = (
	samples: readonly TokenSpeedSample[],
	now: number,
	streamStartedAt: number,
	tokens: number,
): Readonly<{ samples: readonly TokenSpeedSample[]; snapshot: TokenSpeedSnapshot }> => {
	const cutoff = now - TOKEN_SPEED_WINDOW_MS;
	const nextSamples = [...samples.filter((sample) => sample.time >= cutoff), { time: now, tokens }];
	const elapsedMs = Math.min(TOKEN_SPEED_WINDOW_MS, Math.max(0, now - streamStartedAt));
	const measuredMs = Math.max(TOKEN_SPEED_MIN_SAMPLE_MS, elapsedMs);
	const windowTokens = nextSamples.reduce((total, sample) => total + sample.tokens, 0);
	return {
		samples: nextSamples,
		snapshot: { tokensPerSecond: (windowTokens * 1000) / measuredMs, estimated: true },
	};
};

export const completedTokenSpeed = (outputTokens: number, activeMs: number): TokenSpeedSnapshot | null =>
	outputTokens > 0 && activeMs >= TOKEN_SPEED_MIN_FINAL_MS
		? { tokensPerSecond: (outputTokens * 1000) / activeMs, estimated: false }
		: null;

export const formatTokenSpeed = (speed: TokenSpeedSnapshot | null): string =>
	speed ? `${speed.estimated ? "~" : ""}${speed.tokensPerSecond.toFixed(1)}t/s` : "";
