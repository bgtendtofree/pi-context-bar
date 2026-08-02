/** OpenAI Codex (ChatGPT Plus/Pro) quota: fetch and parse wham/usage rate-limit windows into the shared QuotaUsage shape. */

import type { QuotaLimit, QuotaUsage } from "./chrome.ts";

type JsonObject = Readonly<Record<string, unknown>>;

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
/** JWT claim namespace carrying the ChatGPT account id (same claim pi extracts at login). */
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

const isObject = (value: unknown): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const toNumber = (value: unknown): number | undefined => {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
};

/** ChatGPT account id from the OAuth access token; the wham/usage API requires it as a header. */
export const openAiAccountId = (token: string): string | undefined => {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const payload: unknown = JSON.parse(atob(parts[1] ?? ""));
		if (!isObject(payload)) return undefined;
		const auth = payload[JWT_CLAIM_PATH];
		if (!isObject(auth)) return undefined;
		const id = auth.chatgpt_account_id;
		return typeof id === "string" && id ? id : undefined;
	} catch {
		return undefined;
	}
};

/** Window label from seconds: 18000 → "5h", 604800 → "7d". */
const windowLabel = (window: JsonObject, fallback: string): string => {
	const seconds = toNumber(window.limit_window_seconds ?? window.limitWindowSeconds);
	if (seconds === undefined || seconds <= 0) return fallback;
	if (seconds % 86400 === 0) return `${seconds / 86400}d`;
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
};

const windowPercent = (window: JsonObject): number | undefined => toNumber(window.used_percent ?? window.usedPercent);

/** The /wham/usage payload: rate_limit.primary_window (5h) + secondary_window (7d), each {used_percent, limit_window_seconds}. */
export const parseOpenAiUsage = (payload: unknown): QuotaUsage => {
	if (!isObject(payload)) return { weeklyPercent: undefined, limits: [] };
	const rateLimit = isObject(payload.rate_limit) ? payload.rate_limit : payload;
	const limits: QuotaLimit[] = [];
	for (const [index, key] of ["primary_window", "secondary_window"].entries()) {
		const window = rateLimit[key];
		if (!isObject(window)) continue;
		const percent = windowPercent(window);
		if (percent === undefined) continue;
		limits.push({ label: windowLabel(window, `L${index + 1}`), percent });
	}
	const resetContainer = payload.rate_limit_reset_credits;
	const resetCredits = isObject(resetContainer) ? toNumber(resetContainer.available_count) : undefined;
	return { weeklyPercent: undefined, limits, ...(resetCredits !== undefined ? { resetCredits } : {}) };
};

const codexBase = (baseUrl?: string): string =>
	(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "").replace(/\/codex(\/responses)?$/, "");

const whamHeaders = (apiKey: string): Record<string, string> => {
	const accountId = openAiAccountId(apiKey);
	if (!accountId) throw new Error("OpenAI token has no chatgpt_account_id");
	return { Authorization: `Bearer ${apiKey}`, "ChatGPT-Account-Id": accountId };
};

/** Fetch ChatGPT plan quota; model base URLs point at …/codex/responses, the usage API lives at /wham/usage. */
export const fetchOpenAiUsage = async (apiKey: string, baseUrl?: string): Promise<QuotaUsage> => {
	const response = await fetch(`${codexBase(baseUrl)}/wham/usage`, { headers: whamHeaders(apiKey) });
	if (!response.ok) throw new Error(`OpenAI usage API ${response.status}`);
	return parseOpenAiUsage(await response.json());
};

/** Ids of redeemable banked reset credits; the payload schema is undocumented, so accept common array shapes. */
export const parseResetCreditIds = (payload: unknown): readonly string[] => {
	const items = Array.isArray(payload)
		? payload
		: isObject(payload)
			? [payload.credits, payload.reset_credits, payload.rate_limit_reset_credits, payload.data].find(Array.isArray)
			: undefined;
	if (!items) return [];
	const ids: string[] = [];
	for (const item of items) {
		if (!isObject(item)) continue;
		const id = item.credit_id ?? item.id;
		if (typeof id !== "string" || !id) continue;
		const status = String(item.status ?? "").toLowerCase();
		if (status === "consumed" || status === "redeemed" || status === "expired") continue;
		ids.push(id);
	}
	return ids;
};

/** List banked usage-limit reset credits. */
export const fetchResetCreditIds = async (apiKey: string, baseUrl?: string): Promise<readonly string[]> => {
	const response = await fetch(`${codexBase(baseUrl)}/wham/rate-limit-reset-credits`, { headers: whamHeaders(apiKey) });
	if (!response.ok) throw new Error(`OpenAI reset credits API ${response.status}`);
	return parseResetCreditIds(await response.json());
};

/** Redeem one banked reset; returns the outcome code (reset / nothing_to_reset / no_credit / already_redeemed). */
export const redeemResetCredit = async (apiKey: string, creditId: string, baseUrl?: string): Promise<string> => {
	const response = await fetch(`${codexBase(baseUrl)}/wham/rate-limit-reset-credits/consume`, {
		method: "POST",
		headers: { ...whamHeaders(apiKey), "Content-Type": "application/json" },
		// redeem_request_id is an idempotency key: a retried consume with the same id is not spent twice
		body: JSON.stringify({ credit_id: creditId, redeem_request_id: crypto.randomUUID() }),
	});
	if (!response.ok) throw new Error(`OpenAI reset consume API ${response.status}`);
	const body: unknown = await response.json().catch(() => undefined);
	return isObject(body) && typeof body.code === "string" ? body.code : "reset";
};
