/** Passive Codex quota metadata. No credentials, requests, or guessed window lengths. */

import type { QuotaLimit, QuotaUsage } from "./chrome.ts";
import { isObject, toNumber } from "./json.ts";

type QuotaModel = Readonly<{ provider: string; api: string; id: string; baseUrl?: string }>;

/** Include endpoint and model identity so a delayed response cannot cross a model/proxy switch. */
export const responseQuotaKey = (model: QuotaModel | undefined): string | undefined =>
	model && (model.api === "openai-codex-responses" || model.api === "openai-responses")
		? JSON.stringify([model.provider, model.api, model.id, model.baseUrl])
		: undefined;

const parseWindow = (percent: unknown, reset: unknown, minutes: unknown, now: number): QuotaLimit | undefined => {
	const used = toNumber(percent);
	const resetAt = toNumber(reset);
	if (used === undefined || used < 0 || used > 100 || resetAt === undefined || resetAt <= now / 1000) return undefined;
	if (!Number.isFinite(resetAt * 1000)) return undefined;
	const length = toNumber(minutes);
	const label =
		length === undefined || length <= 0
			? ""
			: length % 1440 === 0
				? `${length / 1440}d`
				: length % 60 === 0
					? `${length / 60}h`
					: `${length}m`;
	return { label, percent: used, resetAt: resetAt * 1000 };
};

/** undefined means unrelated headers; an empty snapshot means reported but unusable quota. */
export const parseQuotaHeaders = (headers: Readonly<Record<string, string>>, now: number): QuotaUsage | undefined => {
	const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
	const limits: QuotaLimit[] = [];
	let reported = false;
	for (const window of ["primary", "secondary"]) {
		const prefix = `x-codex-${window}-`;
		if (["used-percent", "reset-at", "window-minutes"].some((field) => normalized[prefix + field] !== undefined))
			reported = true;
		const limit = parseWindow(
			normalized[`${prefix}used-percent`],
			normalized[`${prefix}reset-at`],
			normalized[`${prefix}window-minutes`],
			now,
		);
		if (limit) limits.push(limit);
	}
	return reported ? { limits } : undefined;
};

export const parseQuotaEvent = (data: unknown, now: number): QuotaUsage | undefined => {
	if (!isObject(data) || data.type !== "codex.rate_limits") return undefined;
	const windows = isObject(data.rate_limits) ? data.rate_limits : {};
	const limits: QuotaLimit[] = [];
	for (const key of ["primary", "secondary"]) {
		const window = windows[key];
		if (!isObject(window)) continue;
		const limit = parseWindow(window.used_percent, window.reset_at, window.window_minutes, now);
		if (limit) limits.push(limit);
	}
	return { limits };
};

/** Return the same snapshot until expiry, preserving the editor's memo key. No idle timer needed. */
export const unexpiredQuota = (quota: QuotaUsage, now: number): QuotaUsage =>
	quota.limits.every((limit) => limit.resetAt === undefined || limit.resetAt > now)
		? quota
		: { limits: quota.limits.filter((limit) => limit.resetAt === undefined || limit.resetAt > now) };
