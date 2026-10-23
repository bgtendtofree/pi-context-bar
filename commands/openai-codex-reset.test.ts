import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runOpenAiCodexReset } from "./openai-codex-reset.ts";

const token = (accountId: string): string =>
	`x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64")}.y`;

const isCodexModel = (ctx: ExtensionContext): boolean =>
	ctx.model?.provider === "openai-codex" && ctx.model.api !== "pi-virtual";

test("reset transactions block concurrent retries and forget, preserve IDs on unfamiliar codes, and recheck account/expiry", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-reset-command-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(async () => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		await rm(dir, { recursive: true, force: true });
	});
	const path = join(dir, "pi-context-bar-reset-pending.json");
	let refreshes = 0;
	const reset = (args: string, ctx: ExtensionCommandContext): Promise<void> =>
		runOpenAiCodexReset(args, ctx, { isCodexModel, refreshQuota: async () => void refreshes++ });
	const notices: string[] = [];
	let key = token("a");
	let confirm: () => Promise<boolean> = async () => true;
	const ctx = {
		model: { provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" },
		modelRegistry: { getApiKeyForProvider: async () => key },
		ui: { confirm: () => confirm(), notify: (message: string) => notices.push(message) },
	} as unknown as ExtensionCommandContext;
	const old = { accountId: "a", creditId: "old", requestId: "stable-old" };
	await writeFile(path, JSON.stringify(old));
	const posted = Promise.withResolvers<void>();
	const response = Promise.withResolvers<Response>();
	const bodies: unknown[] = [];
	let outcome = "processing";
	let consumeStatus = 200;
	let credits: unknown = [{ id: "new" }];
	t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
		if (url.endsWith("/consume")) {
			bodies.push(JSON.parse(String(init?.body)));
			if (bodies.length === 1) {
				posted.resolve();
				return response.promise;
			}
			if (consumeStatus !== 200) return new Response(null, { status: consumeStatus });
			return new Response(JSON.stringify({ code: outcome }));
		}
		return new Response(JSON.stringify(url.endsWith("/wham/usage") ? {} : credits));
	});
	const a = reset("", ctx);
	await posted.promise;
	await reset("", ctx); // B cannot read old pending or submit a delayed duplicate.
	await reset("forget-pending", ctx);
	assert.equal(bodies.length, 1);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), old);
	assert.equal(notices.filter((notice) => notice.includes("locked")).length, 2);
	response.resolve(new Response(JSON.stringify({ code: "reset" })));
	await a;
	assert.equal(refreshes, 1);
	await assert.rejects(stat(path), { code: "ENOENT" });

	const dialog = Promise.withResolvers<void>();
	const confirmed = Promise.withResolvers<boolean>();
	confirm = async () => {
		dialog.resolve();
		return confirmed.promise;
	};
	const c = reset("", ctx);
	await dialog.promise;
	await reset("forget-pending", ctx); // Dialog itself is locked, not only POST.
	await reset("", ctx);
	assert.equal(bodies.length, 1);
	confirmed.resolve(true);
	await c;
	assert.equal(refreshes, 2);
	assert.equal(notices.at(-1), "OpenAI reset outcome unknown; rerun command to retry same request");
	const saved = JSON.parse(await readFile(path, "utf8"));
	assert.equal(saved.creditId, "new");
	assert.notEqual(saved.requestId, old.requestId);
	assert.deepEqual(bodies[1], { credit_id: saved.creditId, redeem_request_id: saved.requestId });
	confirm = async () => true;
	await reset("", ctx); // Unfamiliar code retries same IDs, never selects another credit.
	assert.equal(notices.at(-1), "OpenAI reset outcome unknown; rerun command to retry same request");
	assert.deepEqual(bodies[2], bodies[1]);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), saved);
	assert.equal(refreshes, 3);

	// A 4xx (e.g. 409 processing) is a non-2xx HTTP error whose body is never read; it may already have
	// applied, so the saved IDs must survive and the notice must not claim no credit was spent.
	consumeStatus = 409;
	await reset("", ctx);
	assert.match(notices.at(-1) ?? "", /outcome uncertain/);
	assert.ok(!notices.some((notice) => notice.includes("no credit was spent")));
	assert.deepEqual(bodies[3], bodies[1]);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), saved);
	assert.equal(refreshes, 3); // HTTP failure keeps the record and skips the quota refresh.
	consumeStatus = 200;

	outcome = "already_redeemed";
	await reset("", ctx);
	assert.deepEqual(bodies[4], bodies[1]);
	assert.equal(refreshes, 4);
	await assert.rejects(stat(path), { code: "ENOENT" });

	await writeFile(path, JSON.stringify(old));
	key = token("other");
	await reset("", ctx);
	assert.match(notices.at(-1) ?? "", /another account/);
	assert.equal(bodies.length, 5);
	key = token("a");
	confirm = async () => {
		key = token("other");
		return true;
	};
	await reset("", ctx);
	assert.match(notices.at(-1) ?? "", /account changed/);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), old);
	key = token("a");
	confirm = async () => false;
	await reset("forget-pending", ctx);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), old);
	const forgetDialog = Promise.withResolvers<void>();
	const forgetConfirmed = Promise.withResolvers<boolean>();
	confirm = async () => {
		forgetDialog.resolve();
		return forgetConfirmed.promise;
	};
	const forgetting = reset("forget-pending", ctx);
	await forgetDialog.promise;
	await reset("", ctx);
	assert.match(notices.at(-1) ?? "", /locked/);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), old);
	forgetConfirmed.resolve(true);
	await forgetting;

	const now = Date.parse("2026-06-01T00:00:00Z");
	let clock = now;
	t.mock.method(Date, "now", () => clock);
	credits = [{ id: "expiring", expires_at: new Date(now + 30_000).toISOString() }];
	confirm = async () => {
		clock = now + 30_000;
		return true;
	};
	await reset("", ctx);
	assert.match(notices.at(-1) ?? "", /expired/);
	assert.equal(bodies.length, 5); // Confirmation crossed expiry: no POST.
	await assert.rejects(stat(path), { code: "ENOENT" });

	credits = [{ id: "uncertain" }];
	confirm = async () => true;
	t.mock.method(globalThis, "fetch", async (url: string) => {
		if (url.endsWith("/consume")) throw new Error("mock network failure");
		return new Response(JSON.stringify(credits));
	});
	await reset("", ctx);
	assert.match(notices.at(-1) ?? "", /outcome uncertain/);
	const uncertain = JSON.parse(await readFile(path, "utf8"));
	assert.equal(uncertain.creditId, "uncertain");
	await reset("", ctx);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), uncertain);
	assert.equal(refreshes, 4); // Thrown HTTP errors never refresh quota.
});

test("reset command rejects bad args, missing credentials, no credits, and a post-confirm account change", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-reset-command-edges-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(async () => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		await rm(dir, { recursive: true, force: true });
	});
	const reset = (args: string, ctx: ExtensionCommandContext): Promise<void> =>
		runOpenAiCodexReset(args, ctx, { isCodexModel, refreshQuota: async () => {} });
	const notices: string[] = [];
	let key: string | undefined = token("a");
	let confirm: () => Promise<boolean> = async () => true;
	let credits: unknown = [];
	const bodies: unknown[] = [];
	t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
		if (url.endsWith("/consume")) bodies.push(JSON.parse(String(init?.body)));
		return new Response(JSON.stringify(url.endsWith("/rate-limit-reset-credits") ? credits : {}));
	});
	const ctx = {
		model: { provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" },
		modelRegistry: { getApiKeyForProvider: async () => key },
		ui: { confirm: () => confirm(), notify: (message: string) => notices.push(message) },
	} as unknown as ExtensionCommandContext;

	await reset("extra", ctx);
	assert.equal(notices.at(-1), "Usage: /openai-codex-reset [forget-pending]");
	key = undefined;
	await reset("", ctx);
	assert.equal(notices.at(-1), "No OpenAI Codex credentials");
	key = token("a");
	await reset("", ctx);
	assert.equal(notices.at(-1), "No banked OpenAI resets available");

	credits = [{ id: "credit" }];
	confirm = async () => {
		key = token("other");
		return true;
	};
	await reset("", ctx);
	assert.equal(notices.at(-1), "OpenAI Codex account changed; reset cancelled");
	assert.equal(bodies.length, 0);
});

test("a directory-sync failure blocks the retry POST and keeps the pending record", {
	skip: process.platform === "win32" || process.getuid?.() === 0,
}, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-reset-sync-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(async () => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		await chmod(dir, 0o700);
		await rm(dir, { recursive: true, force: true });
	});
	const path = join(dir, "pi-context-bar-reset-pending.json");
	const pending = { accountId: "a", creditId: "c", requestId: "r" };
	await writeFile(path, JSON.stringify(pending));
	const reset = (args: string, ctx: ExtensionCommandContext): Promise<void> =>
		runOpenAiCodexReset(args, ctx, { isCodexModel, refreshQuota: async () => {} });
	let consumes = 0;
	t.mock.method(globalThis, "fetch", async (url: string) => {
		if (url.endsWith("/consume")) consumes++;
		return new Response(JSON.stringify({ code: "reset" }));
	});
	const notices: string[] = [];
	const ctx = {
		model: { provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" },
		modelRegistry: { getApiKeyForProvider: async () => token("a") },
		ui: { confirm: async () => true, notify: (message: string) => notices.push(message) },
	} as unknown as ExtensionCommandContext;
	// Execute without read on the directory: file access still works, but open(dir, "r").sync must fail.
	await chmod(dir, 0o333);
	await reset("", ctx);
	assert.equal(consumes, 0);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), pending);
	assert.match(notices.at(-1) ?? "", /failed/);
});

test("cleanup after a confirmed reset is reported as applied, not as an uncertain saved request", {
	skip: process.platform === "win32" || process.getuid?.() === 0,
}, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-reset-cleanup-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(async () => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		await chmod(dir, 0o700);
		await rm(dir, { recursive: true, force: true });
	});
	const path = join(dir, "pi-context-bar-reset-pending.json");
	let code = "reset";
	let breakCleanup = false;
	let consumes = 0;
	t.mock.method(globalThis, "fetch", async (url: string) => {
		if (url.endsWith("/consume")) {
			consumes++;
			// Save already fsynced while writable; now only deletion succeeds and the directory fsync fails.
			if (breakCleanup) await chmod(dir, 0o333);
			return new Response(JSON.stringify({ code }));
		}
		return new Response(JSON.stringify(url.endsWith("/rate-limit-reset-credits") ? [{ id: "new" }] : {}));
	});
	const reset = (args: string, ctx: ExtensionCommandContext): Promise<void> =>
		runOpenAiCodexReset(args, ctx, { isCodexModel, refreshQuota: async () => {} });
	const notices: string[] = [];
	const ctx = {
		model: { provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" },
		modelRegistry: { getApiKeyForProvider: async () => token("a") },
		ui: { confirm: async () => true, notify: (message: string) => notices.push(message) },
	} as unknown as ExtensionCommandContext;
	const assertConfirmed = (): void => {
		const notice = notices.at(-1) ?? "";
		assert.match(notice, /applied|already redeemed/);
		assert.match(notice, /cleanup failed/);
		assert.doesNotMatch(notice, /uncertain|request saved/);
	};

	breakCleanup = true;
	await reset("", ctx);
	await chmod(dir, 0o700);
	assertConfirmed();
	assert.match(notices.at(-1) ?? "", /another reset could be spent/);
	await assert.rejects(stat(path), { code: "ENOENT" });

	// The retry branch has the same confirmed-result cleanup failure, with its other known completed code.
	await writeFile(path, JSON.stringify({ accountId: "a", creditId: "old", requestId: "old-id" }));
	code = "already_redeemed";
	await reset("", ctx);
	await chmod(dir, 0o700);
	assertConfirmed();
	assert.match(notices.at(-1) ?? "", /already redeemed/);
	await assert.rejects(stat(path), { code: "ENOENT" });
	assert.equal(consumes, 2);
});
