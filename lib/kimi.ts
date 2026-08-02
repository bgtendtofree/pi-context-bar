/** Kimi Code (Coding Plan) quota: fetch and parse weekly usage + rate-limit windows into the shared QuotaUsage shape. */

import type { QuotaLimit, QuotaUsage } from "./chrome.ts";

type JsonObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const toNumber = (value: unknown): number | undefined => {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
};

const usedPercent = (data: JsonObject): number | undefined => {
	const limit = toNumber(data.limit);
	if (limit === undefined || limit <= 0) return undefined;
	const used = toNumber(data.used);
	return used === undefined ? undefined : (used / limit) * 100;
};

/** Limit window label from duration + unit: 300 MINUTE → "5h", 1 DAY → "1d". Units arrive as "MINUTE", "TIME_UNIT_MINUTE", etc. — match by substring. */
const windowLabel = (window: JsonObject, fallback: string): string => {
	const duration = toNumber(window.duration);
	const unit = String(window.timeUnit ?? window.time_unit ?? "").toUpperCase();
	if (duration === undefined) return fallback;
	if (unit.includes("MINUTE")) return duration % 60 === 0 ? `${duration / 60}h` : `${duration}m`;
	if (unit.includes("HOUR")) return `${duration}h`;
	if (unit.includes("DAY")) return `${duration}d`;
	if (unit.includes("MONTH")) return `${duration}mo`;
	if (unit.includes("SECOND")) return duration % 60 === 0 ? `${duration / 60}m` : `${duration}s`;
	return fallback;
};

const shortName = (data: JsonObject, fallback: string): string => {
	const name = data.name ?? data.title;
	return typeof name === "string" && name ? name : fallback;
};

/** The /usages payload: weekly summary under `usage`, rate-limit windows under `limits`. */
export const parseKimiUsage = (payload: unknown): QuotaUsage => {
	if (!isObject(payload)) return { weeklyPercent: undefined, limits: [] };
	const weeklyPercent = isObject(payload.usage) ? usedPercent(payload.usage) : undefined;
	const limits: QuotaLimit[] = [];
	if (Array.isArray(payload.limits)) {
		for (const [index, item] of payload.limits.entries()) {
			if (!isObject(item)) continue;
			const detail = isObject(item.detail) ? item.detail : item;
			const percent = usedPercent(detail);
			if (percent === undefined) continue;
			const window = isObject(item.window) ? item.window : detail;
			limits.push({ label: windowLabel(window, shortName(detail, `L${index + 1}`)), percent });
		}
	}
	return { weeklyPercent, limits };
};

/** Fetch Coding Plan quota; model base URLs are Anthropic-style (…/coding), the usage API lives under /v1. */
export const fetchKimiUsage = async (apiKey: string, baseUrl: string): Promise<QuotaUsage> => {
	const headers = { Authorization: `Bearer ${apiKey}`, "User-Agent": "KimiCLI/1.6" };
	const base = baseUrl.replace(/\/+$/, "");
	const url = base.endsWith("/v1") ? `${base}/usages` : `${base}/v1/usages`;
	const response = await fetch(url, { headers });
	if (!response.ok) throw new Error(`Kimi usage API ${response.status}`);
	return parseKimiUsage(await response.json());
};
