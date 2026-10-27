import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { token } from "../test-support/fixtures.ts";
import { createQuotaController, INITIAL_QUOTA_STATE, type QuotaState } from "./quota.ts";

const model = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	id: "gpt-test",
	baseUrl: "https://chatgpt.com/backend-api",
};

const context = (): ExtensionContext =>
	({
		mode: "tui",
		hasUI: true,
		model,
		modelRegistry: { getApiKeyForProvider: async () => token("a") },
		ui: { notify: () => {} },
	}) as unknown as ExtensionContext;

const harness = (initial: QuotaState) => {
	let state = initial;
	const renders: number[] = [];
	const controller = createQuotaController({
		getState: () => state,
		setState: (next) => {
			state = next;
		},
		requestRender: () => renders.push(1),
		getRequestKey: () => undefined,
	});
	return { controller, state: () => state, renders };
};

test("official quota windows expire by resetAt while credits and windows without resetAt stay", () => {
	const now = Date.now();
	const usage = {
		limits: [
			{ label: "5h", percent: 80, resetAt: now - 1 },
			{ label: "7d", percent: 40 },
		],
		resetCredits: 2,
	};
	const h = harness({
		...INITIAL_QUOTA_STATE,
		usage,
		source: "official query",
		updatedAt: 123,
	});
	h.controller.expire(context());
	assert.deepEqual(h.state().usage, { limits: [{ label: "7d", percent: 40 }], resetCredits: 2 });
	assert.match(h.state().issue ?? "", /expired official quota windows/);
	assert.equal(h.state().source, "official query");
	assert.equal(h.state().updatedAt, 123);

	const allExpired = harness({
		...INITIAL_QUOTA_STATE,
		usage: { limits: [{ label: "5h", percent: 80, resetAt: now }], resetCredits: 1 },
		source: "official query",
	});
	allExpired.controller.expire(context());
	assert.deepEqual(allExpired.state().usage, { limits: [], resetCredits: 1 });
});

test("a failed official refresh keeps the last good snapshot and reports it", async (t) => {
	const usage = { limits: [{ label: "7d", percent: 40 }], resetCredits: 2 };
	const h = harness({
		...INITIAL_QUOTA_STATE,
		usage,
		accountId: "a",
		source: "official query",
		updatedAt: 456,
	});
	t.mock.method(globalThis, "fetch", async () => {
		throw new Error("network down");
	});
	await h.controller.refresh(context(), true);
	assert.equal(h.state().usage, usage);
	assert.equal(h.state().source, "official query");
	assert.equal(h.state().updatedAt, 456);
	assert.match(h.state().issue ?? "", /failed; keeping the last good snapshot/);
});
