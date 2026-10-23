/** `/openai-codex-reset`: redeem or retry one banked ChatGPT usage-limit reset under the shared pending lock. */

import { dirname, join } from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "../lib/chrome.ts";
import { configPath } from "../lib/config.ts";
import {
	fetchResetCredits,
	openAiAccountId,
	type PendingReset,
	type ResetRedemption,
	redeemResetCredit,
} from "../lib/openai.ts";
import { withPendingReset } from "../lib/pending-reset.ts";

const pendingResetPath = (): string => join(dirname(configPath()), "pi-context-bar-reset-pending.json");

export type OpenAiCodexResetDeps = Readonly<{
	/** Physical legacy Codex models only; the quota path uses the same predicate. */
	isCodexModel: (ctx: ExtensionContext) => boolean;
	/** Runs after every completed POST outcome, including `unknown`; thrown HTTP errors keep the record and skip it. */
	refreshQuota: (ctx: ExtensionContext) => Promise<void>;
}>;

export const runOpenAiCodexReset = async (
	args: string,
	ctx: ExtensionCommandContext,
	deps: OpenAiCodexResetDeps,
): Promise<void> => {
	if (args.trim() === "forget-pending") {
		try {
			await withPendingReset(pendingResetPath(), async (store) => {
				const confirmed = await ctx.ui.confirm(
					"Forget pending reset request?",
					"Only do this after checking usage. If the previous request succeeded, a new reset could spend another credit.",
				);
				if (!confirmed) return;
				await store.clear();
				ctx.ui.notify("Pending reset request forgotten", "warning");
			});
		} catch (error) {
			ctx.ui.notify(
				`Could not clear pending reset: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
		return;
	}
	if (args.trim()) {
		ctx.ui.notify("Usage: /openai-codex-reset [forget-pending]", "warning");
		return;
	}
	if (!deps.isCodexModel(ctx)) {
		ctx.ui.notify("Active model is not a physical openai-codex model", "warning");
		return;
	}
	let postStarted = false;
	let confirmedOutcome: ResetRedemption | undefined;
	try {
		await withPendingReset(pendingResetPath(), async (store) => {
			const completeReset = async (outcome: ResetRedemption): Promise<void> => {
				const notice = resetOutcomeNotice(outcome);
				if (!resetCompleted(outcome)) {
					ctx.ui.notify(notice.message, notice.level);
					await deps.refreshQuota(ctx);
					return;
				}
				// The POST is final even if the record cannot be cleaned up; never call this uncertain/saved.
				confirmedOutcome = outcome;
				let cleanupError: string | undefined;
				try {
					await store.clear();
				} catch (error) {
					cleanupError = error instanceof Error ? error.message : String(error);
				}
				ctx.ui.notify(
					cleanupError
						? `${notice.message}; pending cleanup failed: ${cleanupError}. Check usage before rerunning; the saved request may be gone, so another reset could be spent.`
						: notice.message,
					cleanupError ? "warning" : notice.level,
				);
				await deps.refreshQuota(ctx);
			};
			const key = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
			if (!key) {
				ctx.ui.notify("No OpenAI Codex credentials", "warning");
				return;
			}
			const accountId = openAiAccountId(key);
			if (!accountId) throw new Error("OpenAI token has no chatgpt_account_id");
			const pending = await store.read();
			if (pending) {
				if (pending.accountId !== accountId) {
					ctx.ui.notify(
						"A reset is pending for another account; switch accounts before retrying or forget it after checking usage",
						"warning",
					);
					return;
				}
				const confirmed = await ctx.ui.confirm(
					"Retry pending OpenAI reset?",
					"Previous result was uncertain. Retry same reset and request ID; no new credit will be selected.",
				);
				if (!confirmed) return;
				const currentKey = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
				if (!deps.isCodexModel(ctx) || !currentKey || openAiAccountId(currentKey) !== accountId) {
					ctx.ui.notify("OpenAI Codex account changed; retry cancelled", "warning");
					return;
				}
				// Re-check durability before retrying; a failed earlier sync must not silently allow POST.
				await store.sync();
				postStarted = true;
				const outcome = await redeemResetCredit(currentKey, pending.creditId, pending.requestId, ctx.model?.baseUrl);
				await completeReset(outcome);
				return;
			}
			const baseUrl = ctx.model?.baseUrl;
			const credits = await fetchResetCredits(key, baseUrl);
			const credit = credits[0];
			if (!credit) {
				ctx.ui.notify("No banked OpenAI resets available", "info");
				return;
			}
			const now = Date.now();
			const creditLines = credits
				.map((value, index) => {
					const when =
						value.expiresAt === undefined
							? "no expiry"
							: `expires in ${formatDuration(value.expiresAt - now)} (${new Date(value.expiresAt).toLocaleString()})`;
					return `  ${index + 1}. ${when}${index === 0 ? "  ← selected" : ""}`;
				})
				.join("\n");
			const confirmed = await ctx.ui.confirm(
				"Redeem OpenAI reset?",
				`${credits.length} banked reset${credits.length === 1 ? "" : "s"}, soonest-expiring first:\n${creditLines}\n\nRedeem the selected reset? This resets your current 5h/weekly window.`,
			);
			if (!confirmed) return;
			const currentKey = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
			if (!deps.isCodexModel(ctx) || !currentKey || openAiAccountId(currentKey) !== accountId) {
				ctx.ui.notify("OpenAI Codex account changed; reset cancelled", "warning");
				return;
			}
			const operation: PendingReset = { accountId, creditId: credit.id, requestId: crypto.randomUUID() };
			await store.save(operation);
			if (credit.expiresAt !== undefined && credit.expiresAt <= Date.now()) {
				// No POST started: this new record is safe to discard.
				await store.clear();
				ctx.ui.notify("Selected OpenAI reset expired; rerun command to refresh credits", "warning");
				return;
			}
			postStarted = true;
			const outcome = await redeemResetCredit(currentKey, operation.creditId, operation.requestId, ctx.model?.baseUrl);
			await completeReset(outcome);
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(
			confirmedOutcome
				? `${resetOutcomeNotice(confirmedOutcome).message}, but follow-up failed: ${message}. Check usage before rerunning; the saved request may be gone.`
				: postStarted
					? `OpenAI reset outcome uncertain; request saved. Rerun command to retry same request. ${message}`
					: `OpenAI reset failed: ${message}`,
			"error",
		);
	}
};

const resetOutcomeNotice = (outcome: ResetRedemption): Readonly<{ message: string; level: "info" | "warning" }> => {
	if (outcome === "reset") return { message: "OpenAI reset applied", level: "info" };
	if (outcome === "already_redeemed") return { message: "OpenAI reset was already redeemed", level: "info" };
	return { message: "OpenAI reset outcome unknown; rerun command to retry same request", level: "warning" };
};

/** Only the two exact completed codes permit automatic pending cleanup; every HTTP error keeps the record. */
const resetCompleted = (outcome: ResetRedemption): boolean => outcome === "reset" || outcome === "already_redeemed";
