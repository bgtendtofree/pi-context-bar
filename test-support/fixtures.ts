/** Shared session-entry fixtures for the split index integration suites. */

import type { CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { SUBSCRIPTION_TURN_ENTRY } from "../lib/context.ts";

export const token = (accountId: string): string =>
	`x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64")}.y`;

/** Last entry narrowed to a custom entry; the subscription-marker assertions only append those. */
export const lastCustom = (entries: readonly SessionEntry[]): CustomEntry => {
	const last = entries.at(-1);
	if (last?.type !== "custom") throw new Error(`expected a custom entry, got ${last?.type ?? "none"}`);
	return last;
};

export const billedResponse = (id: string): SessionEntry =>
	({
		type: "message",
		id,
		parentId: null,
		timestamp: "",
		message: {
			role: "assistant",
			content: [],
			api: "openai",
			provider: "openai",
			model: "gpt",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.4 },
			},
			stopReason: "stop",
			timestamp: 0,
		},
	}) as unknown as SessionEntry;

export const markerEntry = (messageEntryId: string, parentId: string | null): SessionEntry => ({
	type: "custom",
	id: `billing-${messageEntryId}`,
	parentId,
	timestamp: "",
	customType: SUBSCRIPTION_TURN_ENTRY,
	data: { messageEntryId },
});

/** Same ancestor branch Pi returns from ReadonlySessionManager.getBranch(). */
export const branchTo = (entries: readonly SessionEntry[], target: string): SessionEntry[] => {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	for (let current: string | null = target; current; ) {
		const entry = byId.get(current);
		if (!entry) break;
		branch.unshift(entry);
		current = entry.parentId;
	}
	return branch;
};

/** Standalone provider usage (e.g. cache warming) that Pi appends without a turn or agent event. */
export const usageEntry = (id: string, total: number): SessionEntry =>
	({
		type: "usage",
		id,
		parentId: null,
		timestamp: "",
		kind: "cache_warm",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
		},
	}) as unknown as SessionEntry;
