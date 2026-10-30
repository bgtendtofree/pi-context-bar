/** TUI-only DeepSeek balance refresh, with memory-only credential/selection ownership. */
import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type BalanceUsage, fetchDeepSeekBalance, officialDeepSeekBaseUrl } from "./deepseek.ts";

export type BalanceState = Readonly<{
	usage: BalanceUsage | undefined;
	owner: string | undefined;
	identity: string | undefined;
	lastAttemptAt: number | undefined;
	updatedAt: number | undefined;
	issue: string | undefined;
}>;
export const INITIAL_BALANCE_STATE: BalanceState = {
	usage: undefined,
	owner: undefined,
	identity: undefined,
	lastAttemptAt: undefined,
	updatedAt: undefined,
	issue: undefined,
};

const selection = (ctx: ExtensionContext): string | undefined => {
	const model = ctx.model;
	return ctx.mode === "tui" &&
		model?.provider === "deepseek" &&
		model.api !== "pi-virtual" &&
		officialDeepSeekBaseUrl(model.baseUrl)
		? JSON.stringify([model.provider, model.api, model.id, model.baseUrl])
		: undefined;
};
const fingerprint = (key: string): string => createHash("sha256").update(key).digest("hex");

export const createBalanceController = (input: {
	getState: () => BalanceState;
	setState: (state: BalanceState) => void;
	requestRender: () => void;
}) => {
	let revision = 0;
	let authSequence = 0;
	let pending: AbortController | undefined;
	const patch = (next: Partial<BalanceState>): void => input.setState({ ...input.getState(), ...next });
	const cancel = (): void => {
		revision++;
		authSequence++;
		pending?.abort();
		pending = undefined;
		input.setState(INITIAL_BALANCE_STATE);
	};
	/** Rendering may invalidate a stale reading, but never resolves credentials or performs I/O. */
	const expire = (ctx: ExtensionContext): void => {
		const owner = selection(ctx);
		if (input.getState().owner !== owner) {
			cancel();
			patch({ owner });
		}
		const state = input.getState();
		if (state.usage && state.updatedAt !== undefined && Date.now() - state.updatedAt >= 300_000)
			patch({ usage: undefined, issue: "balance reading expired; waiting for activity" });
	};
	const refresh = async (ctx: ExtensionContext): Promise<void> => {
		expire(ctx);
		const owner = selection(ctx);
		if (!owner) return;
		const auth = ++authSequence;
		const beforeAuth = revision;
		let attempt: number | undefined;
		try {
			const key = await ctx.modelRegistry.getApiKeyForProvider("deepseek");
			if (auth !== authSequence || beforeAuth !== revision || owner !== selection(ctx)) return;
			const identity = key ? fingerprint(key) : undefined;
			if (identity !== input.getState().identity) {
				pending?.abort();
				revision++;
				pending = undefined;
				input.setState({ ...INITIAL_BALANCE_STATE, owner, identity });
				input.requestRender();
			}
			if (!key) {
				patch({ usage: undefined, issue: "no DeepSeek API key" });
				input.requestRender();
				return;
			}
			const now = performance.now();
			const last = input.getState().lastAttemptAt;
			if (last !== undefined && now - last < 60_000) return;
			patch({ lastAttemptAt: now });
			pending?.abort();
			attempt = ++revision;
			const abort = new AbortController();
			pending = abort;
			// The selection was validated above; never follow arbitrary model paths or redirects.
			const usage = await fetchDeepSeekBalance(key, "https://api.deepseek.com", abort.signal);
			if (attempt !== revision || owner !== selection(ctx)) return;
			// Login/logout can happen during HTTP without a model_select event.
			const latestKey = await ctx.modelRegistry.getApiKeyForProvider("deepseek");
			if (attempt !== revision || owner !== selection(ctx)) return;
			if (!latestKey || fingerprint(latestKey) !== identity) {
				cancel();
				patch({ owner, issue: "DeepSeek credentials changed; reading discarded" });
			} else {
				pending = undefined;
				patch({ usage, updatedAt: Date.now(), issue: undefined });
			}
			input.requestRender();
		} catch {
			if (
				owner !== selection(ctx) ||
				(attempt === undefined ? auth !== authSequence || beforeAuth !== revision : attempt !== revision)
			)
				return;
			pending = undefined;
			// Unknown is not zero; hide a failed reading rather than present an old balance as current.
			patch({ usage: undefined, issue: "balance query failed; reading hidden" });
			input.requestRender();
		}
	};
	return { refresh, expire, cancel };
};
