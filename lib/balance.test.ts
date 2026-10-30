import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type BalanceState, createBalanceController, INITIAL_BALANCE_STATE } from "./balance.ts";

const payload = (total = "20.50") => ({
	is_available: true,
	balance_infos: [{ currency: "CNY", total_balance: total, granted_balance: "0.00", topped_up_balance: total }],
});
const response = (total?: string) => new Response(JSON.stringify(payload(total)));
const harness = () => {
	let state: BalanceState = INITIAL_BALANCE_STATE;
	let model = {
		provider: "deepseek",
		api: "openai-completions",
		id: "test-model",
		baseUrl: "https://api.deepseek.com/v1",
	};
	let key: string | undefined = "test-key-a";
	let mode = "tui";
	let renders = 0;
	let reads = 0;
	const ctx = {
		get mode() {
			return mode;
		},
		get model() {
			return model;
		},
		modelRegistry: {
			getApiKeyForProvider: async (provider: string) => {
				assert.equal(provider, "deepseek");
				reads++;
				return key;
			},
		},
	} as unknown as ExtensionContext;
	const controller = createBalanceController({
		getState: () => state,
		setState: (next) => {
			state = next;
		},
		requestRender: () => {
			renders++;
		},
	});
	return {
		ctx,
		controller,
		state: () => state,
		renders: () => renders,
		reads: () => reads,
		setKey: (next: string | undefined) => {
			key = next;
		},
		setMode: (next: string) => {
			mode = next;
		},
		setModel: (next: Partial<typeof model>) => {
			model = { ...model, ...next };
		},
	};
};

test("queries only TUI official physical DeepSeek; unsupported selections never resolve credentials", async (t) => {
	const h = harness();
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		calls++;
		return response();
	});
	for (const mode of ["rpc", "json", "print"]) {
		h.setMode(mode);
		await h.controller.refresh(h.ctx);
	}
	h.setMode("tui");
	for (const model of [
		{ provider: "openai" },
		{ provider: "deepseek", api: "pi-virtual" },
		{ api: "openai-completions", baseUrl: "https://proxy.test" },
	]) {
		h.setModel(model);
		await h.controller.refresh(h.ctx);
	}
	assert.equal(h.reads(), 0);
	assert.equal(calls, 0);
	h.setModel({ baseUrl: "https://api.deepseek.com" });
	await h.controller.refresh(h.ctx);
	assert.equal(h.state().usage?.balances[0]?.total, "20.50");
	assert.ok(h.renders() > 0);
	assert.doesNotMatch(JSON.stringify(h.state()), /test-key-a/);
	h.setModel({ baseUrl: "https://changed.test" });
	h.controller.expire(h.ctx);
	assert.equal(h.state().usage, undefined);
});

test("refreshes on activity at most once per minute; failures hide old readings; expiry needs no network", async (t) => {
	let mono = 0;
	let wall = 1_800_000_000_000;
	t.mock.method(performance, "now", () => mono);
	t.mock.method(Date, "now", () => wall);
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		calls++;
		if (calls === 2) throw new Error("private upstream failure");
		return response();
	});
	const h = harness();
	await h.controller.refresh(h.ctx);
	assert.equal(h.state().updatedAt, wall);
	for (mono of [0, 10, 59999]) await h.controller.refresh(h.ctx);
	assert.equal(calls, 1);
	mono = 60000;
	await h.controller.refresh(h.ctx);
	assert.equal(calls, 2);
	assert.equal(h.state().usage, undefined);
	assert.match(h.state().issue ?? "", /failed; reading hidden/);
	assert.doesNotMatch(JSON.stringify(h.state()), /private upstream/);
	mono = 120000;
	await h.controller.refresh(h.ctx);
	assert.equal(h.state().issue, undefined);
	wall += 299999;
	h.controller.expire(h.ctx);
	assert.ok(h.state().usage);
	wall++;
	h.controller.expire(h.ctx);
	assert.equal(h.state().usage, undefined);
	assert.match(h.state().issue ?? "", /expired/);
	assert.equal(calls, 3);
});

test("key changes bypass old throttle; logout hides balances; credentials are rechecked after HTTP", async (t) => {
	const h = harness();
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		calls++;
		return response(calls === 1 ? "20.50" : "7.00");
	});
	await h.controller.refresh(h.ctx);
	h.setKey("test-key-b");
	await h.controller.refresh(h.ctx);
	assert.equal(calls, 2);
	assert.equal(h.state().usage?.balances[0]?.total, "7.00");
	h.setKey(undefined);
	await h.controller.refresh(h.ctx);
	assert.equal(h.state().usage, undefined);
	assert.match(h.state().issue ?? "", /no DeepSeek API key/);
	assert.equal(calls, 2);
	h.setKey("test-key-c");
	t.mock.method(globalThis, "fetch", async () => {
		h.setKey("test-key-d");
		return response("99.00");
	});
	await h.controller.refresh(h.ctx);
	assert.equal(h.state().usage, undefined);
	assert.match(h.state().issue ?? "", /credentials changed/);
});

test("delayed old account/endpoint/session results cannot attach to a new selection", async (t) => {
	const h = harness();
	const pending: Array<{ resolve: (response: Response) => void; signal: AbortSignal | null | undefined }> = [];
	t.mock.method(
		globalThis,
		"fetch",
		(_url: unknown, init?: RequestInit) =>
			new Promise<Response>((resolve) => {
				pending.push({ resolve, signal: init?.signal });
			}),
	);
	const first = h.controller.refresh(h.ctx);
	await setImmediate();
	// A concurrent throttled read of the same key must not invalidate the first request.
	await h.controller.refresh(h.ctx);
	assert.equal(pending.length, 1);
	pending[0]?.resolve(response("1.00"));
	await first;
	assert.equal(h.state().usage?.balances[0]?.total, "1.00");
	h.setKey("test-key-b");
	const second = h.controller.refresh(h.ctx);
	await setImmediate();
	assert.equal(h.state().usage, undefined);
	h.setKey("test-key-c");
	const third = h.controller.refresh(h.ctx);
	await setImmediate();
	assert.equal(pending[1]?.signal?.aborted, true);
	pending[2]?.resolve(response("3.00"));
	await third;
	pending[1]?.resolve(response("2.00"));
	await second;
	assert.equal(h.state().usage?.balances[0]?.total, "3.00");

	h.setKey("test-key-d");
	const fourth = h.controller.refresh(h.ctx);
	await setImmediate();
	h.setModel({ baseUrl: "https://proxy.test" });
	h.controller.expire(h.ctx);
	pending[3]?.resolve(response("4.00"));
	await fourth;
	assert.equal(h.state().usage, undefined);
	assert.equal(pending[3]?.signal?.aborted, true);
	h.setModel({ baseUrl: "https://api.deepseek.com/v1" });
	const fifth = h.controller.refresh(h.ctx);
	await setImmediate();
	h.controller.cancel();
	pending[4]?.resolve(response("5.00"));
	await fifth;
	assert.deepEqual(h.state(), INITIAL_BALANCE_STATE);
});

test("auth errors are quiet; stale auth continuations and HTTP failures cannot clear newer data", async (t) => {
	const h = harness();
	t.mock.method(h.ctx.modelRegistry, "getApiKeyForProvider", async () => {
		throw new Error("secret auth details");
	});
	await h.controller.refresh(h.ctx);
	assert.match(h.state().issue ?? "", /query failed/);
	assert.doesNotMatch(JSON.stringify(h.state()), /secret auth/);
	let resolveAuth: ((key: string) => void) | undefined;
	t.mock.method(
		h.ctx.modelRegistry,
		"getApiKeyForProvider",
		() =>
			new Promise<string>((resolve) => {
				resolveAuth = resolve;
			}),
	);
	const stale = h.controller.refresh(h.ctx);
	h.controller.cancel();
	resolveAuth?.("old-key");
	await stale;
	assert.deepEqual(h.state(), INITIAL_BALANCE_STATE);

	t.mock.method(h.ctx.modelRegistry, "getApiKeyForProvider", async () => "current-key");
	let rejectFetch: ((error: Error) => void) | undefined;
	t.mock.method(
		globalThis,
		"fetch",
		() =>
			new Promise<Response>((_resolve, reject) => {
				rejectFetch = reject;
			}),
	);
	const failing = h.controller.refresh(h.ctx);
	await setImmediate();
	h.controller.cancel();
	rejectFetch?.(new Error("cancelled old request"));
	await failing;
	assert.deepEqual(h.state(), INITIAL_BALANCE_STATE);
});
