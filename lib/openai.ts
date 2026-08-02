/** OpenAI Codex (ChatGPT Plus/Pro) quota: fetch and parse wham/usage rate-limit windows into the shared KimiUsage shape. */

import type { KimiLimit, KimiUsage } from "./kimi.ts";

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
export const parseOpenAiUsage = (payload: unknown): KimiUsage => {
	if (!isObject(payload)) return { weeklyPercent: undefined, limits: [] };
	const rateLimit = isObject(payload.rate_limit) ? payload.rate_limit : payload;
	const limits: KimiLimit[] = [];
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

/** Fetch ChatGPT plan quota; model base URLs point at …/codex/responses, the usage API lives at /wham/usage. */
export const fetchOpenAiUsage = async (apiKey: string, baseUrl?: string): Promise<KimiUsage> => {
	const accountId = openAiAccountId(apiKey);
	if (!accountId) throw new Error("OpenAI token has no chatgpt_account_id");
	const base = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "").replace(/\/codex(\/responses)?$/, "");
	const response = await fetch(`${base}/wham/usage`, {
		headers: { Authorization: `Bearer ${apiKey}`, "ChatGPT-Account-Id": accountId },
	});
	if (!response.ok) throw new Error(`OpenAI usage API ${response.status}`);
	return parseOpenAiUsage(await response.json());
};
