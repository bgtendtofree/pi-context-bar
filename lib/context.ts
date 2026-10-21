/** Native context snapshot and provider-reported session usage. */

import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { isObject } from "./json.ts";

export type ContextSnapshot = Readonly<{
	/** Used tokens, or null while Pi reports no usable reading (e.g. right after compaction). */
	usedTokens: number | null;
	contextWindow: number;
}>;

export type SessionUsage = Readonly<{
	cost: number;
	/** Cache hit rate 0–100 of the most recent assistant turn that reported prompt tokens. */
	cacheHitRate: number | undefined;
	/** Token-weighted cache hit rate 0–100 across all assistant turns that reported prompt tokens. */
	cacheHitRateAvg: number | undefined;
}>;

export type AssistantMessage = Extract<SessionMessageEntry["message"], { role: "assistant" }>;
export type AssistantUsage = AssistantMessage["usage"];

/** Legacy billing marker stored after the response, referencing it by entry id. */
export const SUBSCRIPTION_TURN_ENTRY = "pi-context-bar/subscription-turn";

/** True when a marker carries a usable response id. */
const subscriptionMarkerId = (entry: SessionEntry): string | undefined => {
	if (entry.type !== "custom" || entry.customType !== SUBSCRIPTION_TURN_ENTRY || !isObject(entry.data))
		return undefined;
	return typeof entry.data.messageEntryId === "string" ? entry.data.messageEntryId : undefined;
};

/** Response ids billed on plan by markers anywhere in the supplied entries. */
export const subscriptionMarkerIds = (entries: readonly SessionEntry[]): ReadonlySet<string> => {
	const ids = new Set<string>();
	for (const entry of entries) {
		const id = subscriptionMarkerId(entry);
		if (id !== undefined) ids.add(id);
	}
	return ids;
};

export const latestAssistantResponse = (entries: readonly SessionEntry[]): AssistantMessage | undefined => {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (
			entry?.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.stopReason !== "error" &&
			entry.message.stopReason !== "aborted"
		)
			return entry.message;
	}
	return undefined;
};

export const cacheHitRate = (usage: AssistantUsage): number | undefined => {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	return promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
};

/**
 * Drift anchor: pi already folds usage for its own footer, but only internally — `core/usage-totals.ts`
 * (`createUsageTotals`/`addUsageToTotals`) and `core/cache-stats.ts` are absent from `index.d.ts`, and
 * `ReadonlyFooterDataProvider` exposes git branch and statuses only. `docs/extensions.md` therefore
 * points extensions at `ctx.getContextUsage()` plus token stats on `ctx.sessionManager.getEntries()`,
 * which is what this module does. Verified against pi 1.3.0: re-check the two files above on a pi bump.
 */

/** Subscription plans bill by plan, not per token; their catalog rates are reference prices, not bills. */
const PLAN_PROVIDERS = new Set(["openai-codex", "ln"]);

export const accumulateSessionUsage = (
	entries: readonly SessionEntry[],
	options: Readonly<{ provisionalSubscriptionId?: string | undefined }> = {},
): SessionUsage => {
	// Explicit ids bind each marker to one response, so a fork that drops the marker never reassigns it.
	const subscriptions = subscriptionMarkerIds(entries);
	// A subscription turn persists its response at `message_end`, before `turn_end` appends the marker.
	// During that window the caller passes the captured provisional response id so it is treated as
	// on-plan; earlier paid bills and tool costs still count.
	const provisionalId = options.provisionalSubscriptionId;
	let cost = 0;
	let hitRate: number | undefined;
	let promptTokens = 0;
	let cacheReadTokens = 0;

	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = entry.message.usage;
			if (!PLAN_PROVIDERS.has(entry.message.provider) && !subscriptions.has(entry.id) && entry.id !== provisionalId)
				cost += usage.cost.total;
			const rate = cacheHitRate(usage);
			if (rate !== undefined) {
				hitRate = rate;
				// Token-weighted average: big turns count more than small ones, matching nano-context's all-hit.
				promptTokens += usage.input + usage.cacheRead + usage.cacheWrite;
				cacheReadTokens += usage.cacheRead;
			}
		} else if (entry.type === "usage") {
			if (!PLAN_PROVIDERS.has(entry.provider)) cost += entry.usage.cost.total;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			// ponytail: toolResult carries no provider; counted as billed — image/tool-model calls on plan providers are rare
			cost += entry.message.usage.cost.total;
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			// ponytail: summaries carry no provider; counted as billed — the summary call runs on the active model
			cost += entry.usage.cost.total;
		}
	}
	return {
		cost,
		cacheHitRate: hitRate,
		cacheHitRateAvg: promptTokens > 0 ? (cacheReadTokens / promptTokens) * 100 : undefined,
	};
};

/** A marker only re-classifies a billed, non-plan response, so recovery can skip the parent read otherwise. */
export const hasRecoverableBilling = (entries: readonly SessionEntry[]): boolean =>
	entries.some(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			!PLAN_PROVIDERS.has(entry.message.provider) &&
			entry.message.usage.cost.total > 0,
	);

/** Response ids billed on plan by markers in the parent session but absent from the forked branch. */
export const recoverableSubscriptionMarkers = (
	entries: readonly SessionEntry[],
	parentEntries: readonly SessionEntry[],
): readonly string[] => {
	const present = new Set<string>();
	const entryIds = new Set<string>();
	for (const entry of entries) {
		entryIds.add(entry.id);
		const id = subscriptionMarkerId(entry);
		if (id !== undefined) present.add(id);
	}
	const missing: string[] = [];
	for (const entry of parentEntries) {
		const id = subscriptionMarkerId(entry);
		if (id !== undefined && entryIds.has(id) && !present.has(id)) {
			present.add(id);
			missing.push(id);
		}
	}
	return missing;
};
