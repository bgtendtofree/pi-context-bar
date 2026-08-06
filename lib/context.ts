/** Native context snapshot and provider-reported session usage. */

import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

export type ContextSnapshot = Readonly<{
	usedTokens: number;
	contextWindow: number;
}>;

export type SessionUsage = Readonly<{
	cost: number;
	/** Cache hit rate 0–100 of the most recent assistant turn that reported prompt tokens. */
	cacheHitRate: number | undefined;
}>;

export type AssistantUsage = Extract<SessionMessageEntry["message"], { role: "assistant" }>["usage"];

export const cacheHitRate = (usage: AssistantUsage): number | undefined => {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	return promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
};

/** Subscription plans bill by plan, not per token; their catalog rates are reference prices, not bills. */
const PLAN_PROVIDERS = new Set(["kimi-coding", "openai-codex", "ln"]);

export const accumulateSessionUsage = (entries: readonly SessionEntry[]): SessionUsage => {
	let cost = 0;
	let hitRate: number | undefined;

	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = entry.message.usage;
			if (!PLAN_PROVIDERS.has(entry.message.provider)) cost += usage.cost.total;
			const rate = cacheHitRate(usage);
			if (rate !== undefined) hitRate = rate;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			// ponytail: toolResult carries no provider; counted as billed — image/tool-model calls on plan providers are rare
			cost += entry.message.usage.cost.total;
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			// ponytail: summaries carry no provider; counted as billed — the summary call runs on the active model
			cost += entry.usage.cost.total;
		}
	}
	return { cost, cacheHitRate: hitRate };
};
