/** OpenRouter balance: fetch and parse /api/v1/key (key limit + remaining) into the shared QuotaUsage shape. */

import type { QuotaLimit, QuotaUsage } from "./chrome.ts";

type JsonObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const toNumber = (value: unknown): number | undefined => {
	if (value === null || value === undefined) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
};

/** Reset-window label for the key limit: daily → 1d, weekly → 7d, monthly → 1mo, none → key. */
const resetLabel = (reset: unknown): string => {
	switch (String(reset ?? "").toLowerCase()) {
		case "daily":
			return "1d";
		case "weekly":
			return "7d";
		case "monthly":
			return "1mo";
		default:
			return "key";
	}
};

/** The /key payload: per-key `usage` against an optional credit `limit`; unlimited keys report both as null. */
export const parseOpenRouterKey = (payload: unknown): QuotaUsage => {
	if (!isObject(payload) || !isObject(payload.data)) return { weeklyPercent: undefined, limits: [] };
	const data = payload.data;
	const limit = toNumber(data.limit);
	const remaining = toNumber(data.limit_remaining);
	const daily = toNumber(data.usage_daily);
	const limits: QuotaLimit[] = [];
	if (limit !== undefined && limit > 0 && remaining !== undefined) {
		limits.push({ label: resetLabel(data.limit_reset), percent: ((limit - remaining) / limit) * 100 });
	}
	return {
		weeklyPercent: undefined,
		limits,
		...(remaining !== undefined ? { balanceDollars: remaining } : {}),
		...(limit === undefined && daily !== undefined ? { dailySpentDollars: daily } : {}),
	};
};

/** Fetch key balance; the model base URL is OpenRouter's /api/v1, the key API lives at /key. */
export const fetchOpenRouterBalance = async (apiKey: string, baseUrl: string): Promise<QuotaUsage> => {
	const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/key`, {
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	if (!response.ok) throw new Error(`OpenRouter key API ${response.status}`);
	return parseOpenRouterKey(await response.json());
};
