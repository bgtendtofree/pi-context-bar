/** OpenAI Codex (ChatGPT Plus/Pro) quota: fetch and parse wham/usage rate-limit windows into the shared QuotaUsage shape. */

import { Buffer } from "node:buffer";
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
	const encoded = parts[1] ?? "";
	if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)) return undefined;
	try {
		const payload: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
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

/** Window reset as epoch ms; the API reports `reset_at` in seconds. */
const windowResetAt = (window: JsonObject): number | undefined => {
	const seconds = toNumber(window.reset_at ?? window.resetAt);
	return seconds !== undefined && seconds > 0 ? seconds * 1000 : undefined;
};

export const shouldRefreshQuota = (lastAttemptAt: number | undefined, now: number, force = false): boolean =>
	force || lastAttemptAt === undefined || now - lastAttemptAt >= QUOTA_THROTTLE_MS;

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
		const resetAt = windowResetAt(window);
		limits.push({
			label: windowLabel(window, `L${index + 1}`),
			percent,
			...(resetAt !== undefined ? { resetAt } : {}),
		});
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

/** HTTP failure carrying the response status so callers can tell a refusal apart from an uncertain outcome. */
class HttpResponseError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "HttpResponseError";
		this.status = status;
	}
}

const requestJson = async (url: string, label: string, init: RequestInit): Promise<Response> => {
	const response = await fetch(url, {
		...init,
		redirect: "manual",
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		throw new HttpResponseError(`${label} ${response.status}`, response.status);
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
export type PendingReset = Readonly<{ accountId: string; creditId: string; requestId: string }>;

export const parsePendingReset = (payload: unknown): PendingReset | undefined => {
	if (!isObject(payload)) return undefined;
	const { accountId, creditId, requestId } = payload;
	if (
		typeof accountId !== "string" ||
		!accountId ||
		typeof creditId !== "string" ||
		!creditId ||
		typeof requestId !== "string" ||
		!requestId
	) {
		return undefined;
	}
	return { accountId, creditId, requestId };
};

/**
 * Expiry as epoch ms from an ISO string, epoch number, or a compact UTC stamp
 * (8-digit YYYYMMDD / 14-digit YYYYMMDDHHMMSS). Values below 1e11 are epoch seconds.
 */
const parseExpiry = (raw: unknown): number | undefined => {
	let value: number | undefined;
	if (typeof raw === "number") value = raw;
	else if (typeof raw === "string") {
		const trimmed = raw.trim();
		// Digit-only 8/14 width strings are compact stamps, never epoch seconds. An impossible
		// stamp yields no expiry instead of a bogus 1970 date that would silently drop the credit.
		if (COMPACT_STAMP_WIDTHS.test(trimmed)) return parseCompactDateStamp(trimmed);
		const numeric = trimmed === "" ? Number.NaN : Number(trimmed);
		value = Number.isFinite(numeric) ? numeric : Date.parse(raw);
	}
	if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
	// Epoch seconds stay below 1e11 for the next few millennia; larger values are already milliseconds.
	return value < 1e11 ? value * 1000 : value;
};

const COMPACT_STAMP_WIDTHS = /^(?:\d{8}|\d{14})$/;
const COMPACT_DATE_STAMP = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?$/;

/** Parse a compact digit-only UTC date stamp; `Number()` on it would land in 1970. */
const parseCompactDateStamp = (raw: string): number | undefined => {
	const match = COMPACT_DATE_STAMP.exec(raw);
	if (!match) return undefined;
	const [, year, month, day, hour, minute, second] = match;
	const stamp = Date.UTC(
		Number(year),
		Number(month) - 1,
		Number(day),
		Number(hour ?? "0"),
		Number(minute ?? "0"),
		Number(second ?? "0"),
	);
	const date = new Date(stamp);
	// Reject out-of-range fields such as month 99, which `Date.UTC` would roll over.
	if (date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return undefined;
	return stamp > 0 ? stamp : undefined;
};

/**
 * A credit list is an array or an object wrapping one. Explicit fields win over the generic `data`
 * envelope, and a named container such as `rate_limit_reset_credits` is unwrapped once more.
 */
const isArray = (value: unknown): value is unknown[] => Array.isArray(value);
const creditArray = (value: unknown): unknown[] | undefined => {
	if (isArray(value)) return value;
	if (!isObject(value)) return undefined;
	for (const candidate of [value.credits, value.reset_credits, value.rate_limit_reset_credits, value.data]) {
		const nested = creditArray(candidate);
		if (nested) return nested;
	}
	return undefined;
};

/** Parse redeemable credits, consuming soonest-expiring reset first. */
export const parseResetCredits = (payload: unknown, now = Date.now()): readonly ResetCredit[] => {
	const items = creditArray(payload);
	if (!items) return [];
	const credits: ResetCredit[] = [];
	for (const item of items) {
		if (!isObject(item)) continue;
		const id = item.credit_id ?? item.id;
		if (typeof id !== "string" || !id) continue;
		const status = String(item.status ?? "").toLowerCase();
		if (status === "consumed" || status === "redeemed" || status === "expired") continue;
		const expiry = parseExpiry(item.expires_at ?? item.expiresAt);
		if (expiry !== undefined && expiry <= now) continue;
		credits.push({ id, ...(expiry !== undefined ? { expiresAt: expiry } : {}) });
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

/** Redeem outcome; `rejected` means the API refused the request, so no credit was spent. */
export type ResetRedemption = "reset" | "already_redeemed" | "rejected" | "unknown";

/** Statuses that unambiguously mean the request was refused rather than possibly applied. */
const isDefinitiveRefusal = (status: number): boolean =>
	status === 400 || status === 404 || status === 409 || status === 410 || status === 422;

/** Redeem one banked reset with caller-owned idempotency so retries reuse same request ID. */
export const redeemResetCredit = async (
	apiKey: string,
	creditId: string,
	requestId: string,
	baseUrl?: string,
): Promise<ResetRedemption> => {
	let response: Response;
	try {
		response = await requestJson(
			`${codexBase(baseUrl)}/wham/rate-limit-reset-credits/consume`,
			"OpenAI reset consume API",
			{
				method: "POST",
				headers: { ...whamHeaders(apiKey), "Content-Type": "application/json" },
				body: JSON.stringify({ credit_id: creditId, redeem_request_id: requestId }),
			},
		);
	} catch (error) {
		if (error instanceof HttpResponseError && isDefinitiveRefusal(error.status)) return "rejected";
		throw error;
	}
	// A successful POST may have consumed the reset even if its response cannot be decoded.
	const body = await readJson(response).catch(() => undefined);
	// Internal API codes can change; only known completed or refused outcomes permit pending cleanup.
	return isObject(body) && (body.code === "reset" || body.code === "already_redeemed") ? body.code : "unknown";
};
