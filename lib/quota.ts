/**
 * OpenAI Codex quota ownership: passive response observations, official refreshes, expiry, and the
 * request/account/endpoint race isolation. Chrome reads only the snapshot; index wires the hooks.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { QuotaUsage } from "./chrome.ts";
import {
	fetchOpenAiUsage,
	officialCodexBaseUrl,
	openAiAccountId,
	QUOTA_ENDPOINT_MESSAGE,
	shouldRefreshQuota,
} from "./openai.ts";
import { responseQuotaKey, unexpiredQuota } from "./response-quota.ts";

export type QuotaState = Readonly<{
	usage: QuotaUsage | undefined;
	accountId: string | undefined;
	lastAttemptAt: number | undefined;
	source: string | undefined;
	updatedAt: number | undefined;
	issue: string | undefined;
	ownerKey: string | undefined;
	/** One hint per session when a custom endpoint cannot host official quota queries. */
	endpointWarned: boolean;
}>;

export const INITIAL_QUOTA_STATE: QuotaState = {
	usage: undefined,
	accountId: undefined,
	lastAttemptAt: undefined,
	source: undefined,
	updatedAt: undefined,
	issue: undefined,
	ownerKey: undefined,
	endpointWarned: false,
};

/** New OpenAI OAuth and virtual selections cannot redeem legacy ChatGPT resets. */
export const isCodexModel = (ctx: ExtensionContext): boolean =>
	ctx.model?.provider === "openai-codex" && ctx.model.api !== "pi-virtual";

const isPassive = (state: QuotaState): boolean =>
	state.source === "response headers" || state.source === "stream event";

export type QuotaController = Readonly<{
	passive: () => boolean;
	drop: (accountId: string | undefined) => void;
	expire: (ctx: ExtensionContext) => void;
	observe: (quota: QuotaUsage | undefined, source: string) => void;
	refresh: (ctx: ExtensionContext, force?: boolean) => Promise<void>;
	/** Invalidate an in-flight official lookup on session teardown. */
	cancel: () => void;
}>;

export const createQuotaController = (input: {
	getState: () => QuotaState;
	setState: (next: QuotaState) => void;
	requestRender: () => void;
	getRequestKey: () => string | undefined;
}): QuotaController => {
	let lookupId = 0;
	const patch = (next: Partial<QuotaState>): void => input.setState({ ...input.getState(), ...next });

	/** Drop the shown quota and its retry anchor; used whenever the account or endpoint can no longer host it. */
	const drop = (accountId: string | undefined): void => {
		patch({
			usage: undefined,
			accountId,
			lastAttemptAt: undefined,
			source: undefined,
			updatedAt: undefined,
			issue: undefined,
			ownerKey: undefined,
		});
	};

	/** Warn once per session when the active Codex model does not use the official ChatGPT endpoint. */
	const warnEndpointOnce = (ctx: ExtensionContext): void => {
		if (input.getState().endpointWarned) return;
		patch({ endpointWarned: true });
		if (ctx.hasUI)
			ctx.ui.notify("Official Codex quota queries are off for this endpoint; waiting for provider response metadata");
	};

	const expire = (ctx: ExtensionContext): void => {
		const state = input.getState();
		if (!state.usage) return;
		if (isPassive(state) && state.ownerKey !== responseQuotaKey(ctx.model)) {
			drop(undefined);
			patch({ issue: "model or endpoint changed; waiting for provider response metadata" });
			return;
		}
		const quota = unexpiredQuota(state.usage, Date.now());
		if (quota !== state.usage)
			patch({
				usage: quota,
				issue: isPassive(state)
					? "expired response quota windows were removed"
					: "expired official quota windows were removed",
			});
	};

	const observe = (quota: QuotaUsage | undefined, source: string): void => {
		if (!quota) return;
		// A passive response supersedes any official lookup already in flight.
		lookupId++;
		patch({
			usage: quota,
			source,
			updatedAt: Date.now(),
			accountId: undefined,
			lastAttemptAt: undefined,
			ownerKey: input.getRequestKey(),
			issue: quota.limits.length
				? "responding upstream quota, not a proxy-pool aggregate; reset credits are not reported"
				: "response reported no usable, unexpired Codex quota windows",
		});
		input.requestRender();
	};

	/** Refresh OpenAI quota on activity, at most once per throttle; failures keep the last snapshot. */
	const refresh = async (ctx: ExtensionContext, force = false): Promise<void> => {
		// Quota is chrome; headless and RPC sessions must not spend an authenticated request on it.
		if (ctx.mode !== "tui") return;
		expire(ctx);
		const current = input.getState();
		if (!force && isPassive(current) && current.usage?.limits.length) return;
		if (!isCodexModel(ctx)) {
			lookupId++;
			drop(undefined);
			patch({
				issue: responseQuotaKey(ctx.model)
					? "waiting for provider response metadata"
					: "model API does not expose Codex quota",
			});
			return;
		}
		// Validate the active endpoint before the throttle: switching to a custom/proxy endpoint must clear
		// a previously shown official quota instead of letting a failed poll keep it alive.
		if (officialCodexBaseUrl(ctx.model?.baseUrl) === undefined) {
			lookupId++;
			drop(undefined);
			patch({ issue: "no official queries for custom endpoints; waiting for provider response metadata" });
			warnEndpointOnce(ctx);
			input.requestRender();
			return;
		}
		const currentLookupId = ++lookupId;
		try {
			const key = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
			if (currentLookupId !== lookupId || !isCodexModel(ctx) || officialCodexBaseUrl(ctx.model?.baseUrl) === undefined)
				return;
			const accountId = key ? openAiAccountId(key) : undefined;
			if (accountId !== input.getState().accountId) {
				drop(accountId);
				input.requestRender();
			}
			if (!key || !accountId) {
				patch({ issue: "no legacy Codex credentials or account ID" });
				return;
			}
			const now = performance.now();
			if (!shouldRefreshQuota(input.getState().lastAttemptAt, now, force)) return;
			patch({ lastAttemptAt: now });
			const quota = await fetchOpenAiUsage(key, ctx.model?.baseUrl);
			// Recheck the endpoint on the delayed reply: a switch to a proxy must discard an in-flight official
			// result instead of attaching it to the unsupported model. A concurrent throttled same-endpoint
			// lookup must not drop a valid result, so only the account and attempt anchor gate it, not lookupId.
			const latest = input.getState();
			if (
				!isCodexModel(ctx) ||
				officialCodexBaseUrl(ctx.model?.baseUrl) === undefined ||
				latest.accountId !== accountId ||
				latest.lastAttemptAt !== now
			)
				return;
			patch({
				usage: quota,
				source: "official query",
				updatedAt: Date.now(),
				issue: "official ChatGPT account quota",
			});
			input.requestRender();
		} catch (error) {
			if (currentLookupId !== lookupId) return;
			patch({ issue: "official quota query failed; keeping the last good snapshot" });
			// A custom endpoint can never host Codex quota, so say so once instead of polling forever in silence.
			if (error instanceof Error && error.message === QUOTA_ENDPOINT_MESSAGE) warnEndpointOnce(ctx);
			// ponytail: quota is advisory chrome; a failed poll must never break the editor
		}
	};

	return {
		passive: () => isPassive(input.getState()),
		drop,
		expire,
		observe,
		refresh,
		cancel: () => {
			lookupId++;
		},
	};
};
