/** OpenAI Codex (ChatGPT Plus/Pro) quota: fetch and parse wham/usage rate-limit windows into the shared QuotaUsage shape. */

import { EMPTY_QUOTA, type QuotaLimit, type QuotaUsage } from "./chrome.ts";
import { isObject, type JsonObject, toNumber } from "./json.ts";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const QUOTA_THROTTLE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const OFFICIAL_ORIGIN = "https://chatgpt.com";
/** JWT claim namespace carrying the ChatGPT account id (same claim pi extracts at login). */
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

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

export const shouldRefreshQuota = (lastAttemptAt: number, now: number, force = false): boolean =>
	force || now - lastAttemptAt >= QUOTA_THROTTLE_MS;

/** The /wham/usage payload: rate_limit.primary_window (5h) + secondary_window (7d), each {used_percent, limit_window_seconds}. */
export const parseOpenAiUsage = (payload: unknown): QuotaUsage => {
	if (!isObject(payload)) return EMPTY_QUOTA;
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

const codexBase = (baseUrl?: string): string => {
	if (baseUrl === undefined) return DEFAULT_BASE_URL;
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new Error("OpenAI Codex quota requires the official ChatGPT endpoint");
	}
	const path = url.pathname.replace(/\/+$/, "").replace(/\/codex(\/responses)?$/, "");
	if (
		url.origin !== OFFICIAL_ORIGIN ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		path !== "/backend-api"
	) {
		throw new Error("OpenAI Codex quota requires the official ChatGPT endpoint");
	}
	return DEFAULT_BASE_URL;
};

const whamHeaders = (apiKey: string): Record<string, string> => {
	const accountId = openAiAccountId(apiKey);
	if (!accountId) throw new Error("OpenAI token has no chatgpt_account_id");
	return { Authorization: `Bearer ${apiKey}`, "ChatGPT-Account-Id": accountId };
};

const requestJson = async (url: string, label: string, init: RequestInit): Promise<Response> => {
	const response = await fetch(url, {
		...init,
		redirect: "manual",
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error(`${label} ${response.status}`);
	}
	return response;
};

const readJson = async (response: Response): Promise<unknown> => {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("OpenAI response body is empty");
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				text += decoder.decode();
				return JSON.parse(text) as unknown;
			}
			bytes += value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new Error("OpenAI response exceeds size limit");
			}
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
};

/** Fetch ChatGPT plan quota; model base URLs point at …/codex/responses, the usage API lives at /wham/usage. */
export const fetchOpenAiUsage = async (apiKey: string, baseUrl?: string): Promise<QuotaUsage> => {
	const response = await requestJson(`${codexBase(baseUrl)}/wham/usage`, "OpenAI usage API", {
		headers: whamHeaders(apiKey),
	});
	return parseOpenAiUsage(await readJson(response));
};

export type ResetCredit = Readonly<{ id: string; expiresAt?: number }>;

/** Parse redeemable credits, consuming soonest-expiring reset first. */
export const parseResetCredits = (payload: unknown): readonly ResetCredit[] => {
	const items = Array.isArray(payload)
		? payload
		: isObject(payload)
			? [payload.credits, payload.reset_credits, payload.rate_limit_reset_credits, payload.data].find(Array.isArray)
			: undefined;
	if (!items) return [];
	const credits: ResetCredit[] = [];
	for (const item of items) {
		if (!isObject(item)) continue;
		const id = item.credit_id ?? item.id;
		if (typeof id !== "string" || !id) continue;
		const status = String(item.status ?? "").toLowerCase();
		if (status === "consumed" || status === "redeemed" || status === "expired") continue;
		const rawExpiry = item.expires_at ?? item.expiresAt;
		const expiry = typeof rawExpiry === "string" ? Date.parse(rawExpiry) : Number.NaN;
		credits.push({ id, ...(Number.isFinite(expiry) ? { expiresAt: expiry } : {}) });
	}
	return credits.sort((a, b) => {
		if (a.expiresAt === undefined) return b.expiresAt === undefined ? 0 : 1;
		return b.expiresAt === undefined ? -1 : a.expiresAt - b.expiresAt;
	});
};

/** List banked usage-limit reset credits. */
export const fetchResetCredits = async (apiKey: string, baseUrl?: string): Promise<readonly ResetCredit[]> => {
	const response = await requestJson(
		`${codexBase(baseUrl)}/wham/rate-limit-reset-credits`,
		"OpenAI reset credits API",
		{ headers: whamHeaders(apiKey) },
	);
	return parseResetCredits(await readJson(response));
};

/** Redeem one banked reset; returns the outcome code (reset / nothing_to_reset / no_credit / already_redeemed). */
export const redeemResetCredit = async (apiKey: string, creditId: string, baseUrl?: string): Promise<string> => {
	const response = await requestJson(
		`${codexBase(baseUrl)}/wham/rate-limit-reset-credits/consume`,
		"OpenAI reset consume API",
		{
			method: "POST",
			headers: { ...whamHeaders(apiKey), "Content-Type": "application/json" },
			// redeem_request_id is an idempotency key: a retried consume with the same id is not spent twice
			body: JSON.stringify({ credit_id: creditId, redeem_request_id: crypto.randomUUID() }),
		},
	);
	// A successful POST may have consumed the reset even if its response cannot be decoded.
	const body = await readJson(response).catch(() => undefined);
	return isObject(body) && typeof body.code === "string" ? body.code : "unknown";
};
