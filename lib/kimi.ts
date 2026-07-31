/** Kimi Code (Coding Plan) quota: fetch, parse, and format weekly usage + rate-limit windows. */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChromeStyles } from "./chrome.ts";
import { styleUsage } from "./chrome.ts";

export type KimiLimit = Readonly<{
	label: string;
	/** Used percent 0–100 of this limit window. */
	percent: number;
}>;

export type KimiUsage = Readonly<{
	/** Used percent 0–100 of the weekly quota, undefined when the plan reports none. */
	weeklyPercent: number | undefined;
	limits: readonly KimiLimit[];
}>;

export const KIMI_DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";

type JsonObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const toNumber = (value: unknown): number | undefined => {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
};

const usedPercent = (data: JsonObject): number | undefined => {
	const limit = toNumber(data.limit ?? data.limit_amount);
	if (limit === undefined || limit <= 0) return undefined;
	const remaining = toNumber(data.remaining);
	const used = toNumber(data.used ?? data.used_amount) ?? (remaining !== undefined ? limit - remaining : undefined);
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

/** Coding Plan key from pi's own login store (auth.json, provider "kimi-coding"). */
export const kimiKeyFromAuthData = (data: unknown): string | undefined => {
	if (!isObject(data)) return undefined;
	const entry = data["kimi-coding"];
	if (!isObject(entry) || entry.type !== "api_key") return undefined;
	return typeof entry.key === "string" && entry.key ? entry.key : undefined;
};

/** Read the key pi stored via /login; missing file or entry = undefined. */
export const readKimiKeyFromAuthStore = (): string | undefined => {
	try {
		const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
		return kimiKeyFromAuthData(JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")));
	} catch {
		return undefined;
	}
};

export const parseKimiUsage = (payload: unknown): KimiUsage => {
	if (!isObject(payload)) return { weeklyPercent: undefined, limits: [] };
	let weeklyPercent: number | undefined;
	const limits: KimiLimit[] = [];

	if (Array.isArray(payload.data)) {
		// /usages shape: flat rows, weekly summary tagged model_name "all".
		for (const [index, item] of payload.data.entries()) {
			if (!isObject(item)) continue;
			const percent = usedPercent(item);
			if (percent === undefined) continue;
			if (item.model_name === "all") weeklyPercent = percent;
			else limits.push({ label: windowLabel(item, shortName(item, `L${index + 1}`)), percent });
		}
		return { weeklyPercent, limits };
	}

	// /usage fallback shape: { usage, limits: [{ detail, window }] }.
	if (isObject(payload.usage)) weeklyPercent = usedPercent(payload.usage);
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

/** Fetch Coding Plan quota; tries /usages then /usage. Throws on non-200. */
export const fetchKimiUsage = async (
	apiKey: string,
	baseUrl: string | undefined = KIMI_DEFAULT_BASE_URL,
): Promise<KimiUsage> => {
	const headers = { Authorization: `Bearer ${apiKey}`, "User-Agent": "KimiCLI/1.6" };
	const base = baseUrl.replace(/\/+$/, "");
	let response = await fetch(`${base}/usages`, { headers });
	if (response.status === 404) response = await fetch(`${base}/usage`, { headers });
	if (!response.ok) throw new Error(`Kimi usage API ${response.status}`);
	return parseKimiUsage(await response.json());
};

/** Quota metric variants, widest → tightest, styled at construction. Weekly survives before limits. */
export const kimiMetricOptions = (usage: KimiUsage, styles: ChromeStyles): readonly string[] => {
	const styled = (text: string, percent: number): string => styleUsage(text, percent, styles);
	const weekly =
		usage.weeklyPercent !== undefined ? styled(`W${Math.round(usage.weeklyPercent)}%`, usage.weeklyPercent) : "";
	const limits = usage.limits
		.map((limit) => styled(`${limit.label}${Math.round(limit.percent)}%`, limit.percent))
		.join(styles.dim(" "));
	return [[weekly, limits].filter(Boolean).join(styles.dim(" ")), weekly, ""];
};
