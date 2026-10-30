/** DeepSeek's official account balance, separate from subscription quota windows. */
import { isObject } from "./json.ts";

export type BalanceInfo = Readonly<{
	currency: "CNY" | "USD";
	total: string;
	granted: string;
	toppedUp: string;
}>;
export type BalanceUsage = Readonly<{ available: boolean; balances: readonly BalanceInfo[] }>;

/** Only documented official API roots may send a credential to the balance service. */
export const officialDeepSeekBaseUrl = (baseUrl: string | undefined): string | undefined => {
	if (!baseUrl) return undefined;
	try {
		const url = new URL(baseUrl);
		if (
			url.origin === "https://api.deepseek.com" &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			["", "/v1", "/anthropic"].includes(url.pathname.replace(/\/+$/, ""))
		)
			return "https://api.deepseek.com";
	} catch {
		// Invalid/custom URLs are unsupported, never guessed from the provider name.
	}
	return undefined;
};

/** Bounded decimal strings retain precision, including debt and sub-cent amounts. */
const money = (value: unknown): value is string =>
	typeof value === "string" && /^-?\d{1,16}(?:\.\d{1,8})?$/.test(value);

export const parseDeepSeekBalance = (payload: unknown): BalanceUsage | undefined => {
	if (
		!isObject(payload) ||
		typeof payload.is_available !== "boolean" ||
		!Array.isArray(payload.balance_infos) ||
		payload.balance_infos.length === 0 ||
		payload.balance_infos.length > 2
	)
		return undefined;
	const balances: BalanceInfo[] = [];
	for (const entry of payload.balance_infos) {
		if (
			!isObject(entry) ||
			(entry.currency !== "CNY" && entry.currency !== "USD") ||
			balances.some((balance) => balance.currency === entry.currency) ||
			!money(entry.total_balance) ||
			!money(entry.granted_balance) ||
			entry.granted_balance.startsWith("-") ||
			!money(entry.topped_up_balance)
		)
			return undefined;
		balances.push({
			currency: entry.currency,
			total: entry.total_balance,
			granted: entry.granted_balance,
			toppedUp: entry.topped_up_balance,
		});
	}
	return { available: payload.is_available, balances };
};

export const fetchDeepSeekBalance = async (
	key: string,
	baseUrl: string,
	signal: AbortSignal,
): Promise<BalanceUsage> => {
	const root = officialDeepSeekBaseUrl(baseUrl);
	if (!root) throw new Error("DeepSeek balance requires the official endpoint");
	const response = await fetch(`${root}/user/balance`, {
		method: "GET",
		headers: { Authorization: `Bearer ${key}` },
		redirect: "manual",
		signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`DeepSeek balance HTTP ${response.status}`);
	}
	const reader = response.body?.getReader();
	if (!reader) throw new Error("DeepSeek balance body is empty");
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > 64 * 1024) {
				await reader.cancel();
				throw new Error("DeepSeek balance exceeds size limit");
			}
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
	} finally {
		reader.releaseLock();
	}
	const usage = parseDeepSeekBalance(JSON.parse(text) as unknown);
	if (!usage) throw new Error("DeepSeek balance response is invalid");
	return usage;
};
