/** Native context snapshot and provider-reported session usage. */

export type ContextSnapshot = Readonly<{
	usedTokens: number;
	contextWindow: number;
}>;

export type SessionUsage = Readonly<{
	cost: number;
	/** Cache hit rate 0–100 of the most recent assistant turn that reported prompt tokens. */
	cacheHitRate: number | undefined;
}>;

export type AssistantUsage = Readonly<{
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: Readonly<{ total: number }>;
}>;

export type SessionUsageEntry = Readonly<{
	type: string;
	message: Readonly<{
		role: string;
		usage: AssistantUsage;
	}>;
}>;

export const cacheHitRate = (usage: AssistantUsage): number | undefined => {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	return promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
};

export const accumulateSessionUsage = (entries: readonly SessionUsageEntry[]): SessionUsage => {
	let cost = 0;
	let hitRate: number | undefined;

	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		cost += usage.cost.total;
		const rate = cacheHitRate(usage);
		if (rate !== undefined) hitRate = rate;
	}
	return { cost, cacheHitRate: hitRate };
};
