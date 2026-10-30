import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchDeepSeekBalance, officialDeepSeekBaseUrl, parseDeepSeekBalance } from "./deepseek.ts";

// Synthetic fixture with the documented shape; never a real credential or account snapshot.
const entry = { currency: "CNY", total_balance: "20.50", granted_balance: "5.00", topped_up_balance: "15.50" };
const payload = { is_available: true, balance_infos: [entry] };

test("official DeepSeek roots reject custom endpoints, credentials, query strings, and lookalikes", () => {
	for (const suffix of ["", "/", "/v1", "/v1/", "/anthropic", "/anthropic/"])
		assert.equal(officialDeepSeekBaseUrl(`https://api.deepseek.com${suffix}`), "https://api.deepseek.com");
	for (const url of [
		undefined,
		"",
		"bad",
		"http://api.deepseek.com",
		"https://api.deepseek.com:444",
		"https://api.deepseek.com.evil.test",
		"https://user@api.deepseek.com",
		"https://u:p@api.deepseek.com",
		"https://api.deepseek.com?key=x",
		"https://api.deepseek.com#x",
		"https://api.deepseek.com/proxy",
		"https://proxy.test/v1",
	])
		assert.equal(officialDeepSeekBaseUrl(url), undefined, url);
});

test("parses exact decimal balances, multiple currencies, zero availability, and debt", () => {
	assert.deepEqual(parseDeepSeekBalance(payload), {
		available: true,
		balances: [{ currency: "CNY", total: "20.50", granted: "5.00", toppedUp: "15.50" }],
	});
	assert.deepEqual(
		parseDeepSeekBalance({
			is_available: false,
			balance_infos: [
				{ ...entry, total_balance: "-0.00000001", topped_up_balance: "-5.00000001" },
				{ currency: "USD", total_balance: "0.00", granted_balance: "0.00", topped_up_balance: "0.00" },
			],
		})?.balances.map((balance) => balance.total),
		["-0.00000001", "0.00"],
	);
});

test("rejects partial or malformed money rather than inventing a zero or dropping a currency", () => {
	for (const value of [
		null,
		[],
		{},
		{ ...payload, is_available: "true" },
		{ ...payload, balance_infos: [] },
		{ ...payload, balance_infos: [entry, entry, entry] },
		{ ...payload, balance_infos: [entry, entry] },
		{ ...payload, balance_infos: [null] },
	])
		assert.equal(parseDeepSeekBalance(value), undefined);
	for (const field of ["total_balance", "granted_balance", "topped_up_balance"])
		for (const value of [
			undefined,
			null,
			0,
			"",
			"NaN",
			"Infinity",
			"1e5",
			" 1.00",
			"1\n",
			"1.123456789",
			"12345678901234567",
		])
			assert.equal(parseDeepSeekBalance({ ...payload, balance_infos: [{ ...entry, [field]: value }] }), undefined);
	for (const invalid of [{ currency: "EUR" }, { granted_balance: "-1.00" }])
		assert.equal(parseDeepSeekBalance({ ...payload, balance_infos: [{ ...entry, ...invalid }] }), undefined);
});

test("fetches only the official balance with bearer auth, timeout, and no redirect forwarding", async (t) => {
	const abort = new AbortController();
	const calls: Array<{ url: unknown; init: RequestInit | undefined }> = [];
	t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
		calls.push({ url, init });
		return new Response(JSON.stringify(payload));
	});
	assert.equal(
		(await fetchDeepSeekBalance("test-key", "https://api.deepseek.com/v1", abort.signal)).balances[0]?.total,
		"20.50",
	);
	assert.equal(calls[0]?.url, "https://api.deepseek.com/user/balance");
	assert.equal(new Headers(calls[0]?.init?.headers).get("Authorization"), "Bearer test-key");
	assert.equal(calls[0]?.init?.redirect, "manual");
	assert.equal(calls[0]?.init?.method, "GET");
	assert.ok(calls[0]?.init?.signal instanceof AbortSignal);
	abort.abort();
	assert.equal(calls[0]?.init?.signal?.aborted, true);
	await assert.rejects(fetchDeepSeekBalance("test-key", "https://proxy.test", abort.signal), /official endpoint/);
	assert.equal(calls.length, 1);
});

test("HTTP failures and redirects never read an error body; bad/empty responses fail closed", async (t) => {
	let response = new Response(null, { status: 401 });
	t.mock.method(globalThis, "fetch", async () => response);
	const call = () => fetchDeepSeekBalance("test-key", "https://api.deepseek.com", new AbortController().signal);
	for (const status of [401, 403, 429, 500, 302]) {
		response = new Response("not read", { status });
		await assert.rejects(call(), new RegExp(`HTTP ${status}`));
		assert.equal(response.bodyUsed, true); // cancelled, not decoded
	}
	response = new Response(null);
	await assert.rejects(call(), /body is empty/);
	response = new Response("bad JSON");
	await assert.rejects(call(), SyntaxError);
	response = new Response("{}");
	await assert.rejects(call(), /response is invalid/);
});

test("bounds streamed response bytes, preserves UTF-8 chunk boundaries, and propagates stream failures", async (t) => {
	let response: Response;
	t.mock.method(globalThis, "fetch", async () => response);
	const call = () => fetchDeepSeekBalance("test-key", "https://api.deepseek.com", new AbortController().signal);
	const text = JSON.stringify({ ...payload, ignored: "中" });
	const bytes = new TextEncoder().encode(text);
	response = new Response(
		new ReadableStream({
			start(controller) {
				for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
				controller.close();
			},
		}),
	);
	assert.ok(await call());
	const base = JSON.stringify({ ...payload, pad: "" });
	response = new Response(JSON.stringify({ ...payload, pad: "a".repeat(65536 - base.length) }));
	assert.ok(await call());
	response = new Response("a".repeat(65537));
	await assert.rejects(call(), /exceeds size limit/);
	response = new Response(
		new ReadableStream({
			start(controller) {
				controller.error(new Error("broken stream"));
			},
		}),
	);
	await assert.rejects(call(), /broken stream/);
});
