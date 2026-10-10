import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import type {
	AgentSettledEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import zContext from "./index.ts";
import { NERD_GLYPHS } from "./lib/chrome.ts";
import { type AssistantMessage, accumulateSessionUsage, SUBSCRIPTION_TURN_ENTRY } from "./lib/context.ts";

const token = (accountId: string): string =>
	`x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64")}.y`;

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
	let command: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"] | undefined;
	zContext({
		registerCommand: (_name, value) => {
			command = value.handler;
		},
		on: () => {},
	} as unknown as ExtensionAPI);
	assert.ok(command);
	const reset = command;
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
	let credits: unknown = [{ id: "new" }];
	t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
		if (url.endsWith("/consume")) {
			bodies.push(JSON.parse(String(init?.body)));
			if (bodies.length === 1) {
				posted.resolve();
				return response.promise;
			}
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
	outcome = "already_redeemed";
	await reset("", ctx);
	assert.deepEqual(bodies[3], bodies[1]);
	await assert.rejects(stat(path), { code: "ENOENT" });

	await writeFile(path, JSON.stringify(old));
	key = token("other");
	await reset("", ctx);
	assert.match(notices.at(-1) ?? "", /another account/);
	assert.equal(bodies.length, 4);
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
	assert.equal(bodies.length, 4); // Confirmation crossed expiry: no POST.
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
});

test("quota belongs to active account and model switches update context immediately", async (t) => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	let resetCommand: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"] | undefined;
	const notices: string[] = [];
	const pi = {
		registerCommand: (_name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
			resetCommand = command.handler;
		},
		getThinkingLevel: () => "off",
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	let accountKey = token("A");
	let leafId: string | null = null;
	let entryReads = 0;
	let branch: SessionEntry[] = [];
	let model = {
		api: "openai-codex-responses",
		provider: "openai-codex",
		id: "gpt-test",
		contextWindow: 100_000,
		baseUrl: "https://chatgpt.com/backend-api",
	};
	let render = (): string => "";
	const tui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
	const editorTheme = { borderColor: (text: string) => text } as EditorTheme;
	const ctx = {
		hasUI: true,
		mode: "tui",
		get model() {
			return model;
		},
		getContextUsage: () => ({ tokens: 20_000, contextWindow: model.contextWindow }),
		sessionManager: {
			getEntries: () => {
				entryReads++;
				return [];
			},
			getLeafId: () => leafId,
			getBranch: () => branch,
		},
		modelRegistry: { getApiKeyForProvider: async () => accountKey },
		ui: {
			notify: (text: string) => notices.push(text),
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
				style: (text: string) => text,
			},
			setWorkingVisible: () => {},
			setHeader: () => {},
			setFooter: () => {},
			setEditorComponent: (factory: Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]) => {
				if (factory) {
					const editor = factory(tui, editorTheme, {} as Parameters<NonNullable<typeof factory>>[2]);
					render = () => stripVTControlCharacters(editor.render(100).join("\n"));
				}
			},
		},
	} as unknown as ExtensionContext;
	const pending = new Map<number, (response: Response) => void>();
	let calls = 0;
	const usageResponse = (percent: number): Response =>
		new Response(
			JSON.stringify({ rate_limit: { primary_window: { used_percent: percent, limit_window_seconds: 18_000 } } }),
		);
	t.mock.method(globalThis, "fetch", async () => {
		calls++;
		if (calls === 2 || calls === 4)
			return new Promise<Response>((resolve) => {
				pending.set(calls, resolve);
			});
		return usageResponse(calls === 1 ? 12 : 80);
	});
	zContext(pi);
	handlers.get("session_start")?.({}, ctx);
	await setImmediate();
	assert.match(render(), /5h 12%/);
	assert.match(render(), /20\.0% \(100K\)/);
	assert.match(render(), /❯/);

	accountKey = token("B");
	model = { ...model, contextWindow: 40_000 };
	handlers.get("model_select")?.({}, ctx);
	await setImmediate();
	assert.match(render(), /50\.0% \(40K\)/);
	assert.doesNotMatch(render(), /5h 12%/);

	accountKey = token("C");
	model = { ...model, id: "gpt-other" };
	handlers.get("model_select")?.({}, ctx);
	await setImmediate();
	assert.match(render(), /5h 80%/);
	pending.get(2)?.(usageResponse(70));
	await setImmediate();
	assert.match(render(), /5h 80%/);
	assert.doesNotMatch(render(), /5h 70%/);

	accountKey = token("D");
	model = { ...model, id: "gpt-next" };
	handlers.get("model_select")?.({}, ctx);
	await setImmediate();
	model = { ...model, provider: "other" };
	handlers.get("model_select")?.({}, ctx);
	pending.get(4)?.(usageResponse(70));
	await setImmediate();
	assert.doesNotMatch(render(), /5h 70%/);

	accountKey = token("C");
	model = { ...model, provider: "openai-codex" };
	handlers.get("model_select")?.({}, ctx);
	await setImmediate();
	assert.match(render(), /5h 80%/);

	leafId = "turn-1";
	handlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "stop" } }, ctx);
	assert.equal(entryReads, 2);
	handlers.get("agent_end")?.({}, ctx);
	assert.equal(entryReads, 2);
	leafId = "late-entry";
	handlers.get("agent_end")?.({}, ctx);
	assert.equal(entryReads, 3);

	const quotaCalls = calls;
	model = { ...model, api: "pi-virtual", id: "auto" };
	handlers.get("model_select")?.({}, ctx);
	assert.doesNotMatch(render(), /5h 80%/);
	assert.doesNotMatch(render(), /→/);
	// Virtual selections suppress the provider badge even when the underlying provider id is known.
	assert.doesNotMatch(render(), new RegExp(NERD_GLYPHS.providerOpenai));
	assert.doesNotMatch(render(), new RegExp(NERD_GLYPHS.providerAnthropic));
	await resetCommand?.("", ctx as ExtensionCommandContext);
	assert.equal(notices.at(-1), "Active model is not a physical openai-codex model");
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-routed",
		thinkingLevel: "medium",
		stopReason: "stop",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	branch = [{ type: "message", id: "routed", parentId: null, timestamp: "", message }];
	handlers.get("turn_end")?.({ message }, ctx);
	assert.match(render(), new RegExp(`auto → gpt-routed · ${NERD_GLYPHS.thinking} medium`));
	branch.push({
		type: "message",
		id: "failed",
		parentId: "routed",
		timestamp: "",
		message: { ...message, model: "failed-route", stopReason: "error" },
	});
	handlers.get("session_tree")?.({}, ctx);
	assert.match(render(), new RegExp(`auto → gpt-routed · ${NERD_GLYPHS.thinking} medium`));
	assert.doesNotMatch(render(), /failed-route/);
	branch = [];
	handlers.get("session_tree")?.({}, ctx);
	assert.doesNotMatch(render(), /→/);
	model = { ...model, api: "openai-responses", provider: "openai" };
	handlers.get("model_select")?.({}, ctx);
	assert.match(render(), new RegExp(NERD_GLYPHS.providerOpenai));
	await resetCommand?.("", ctx as ExtensionCommandContext);
	assert.equal(notices.length, 2);
	assert.equal(calls, quotaCalls);

	// Prompt: provider error latches, abort keeps it, a clean turn clears it; branch derives on start/tree.
	handlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "error" } }, ctx);
	assert.match(render(), /✗/);
	handlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "aborted" } }, ctx);
	assert.match(render(), /✗/);
	assert.doesNotMatch(render(), /❯/);
	handlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "stop" } }, ctx);
	assert.match(render(), /❯/);

	branch = [
		{ type: "message", id: "errored", parentId: null, timestamp: "", message: { ...message, stopReason: "error" } },
	];
	handlers.get("session_start")?.({}, ctx);
	assert.match(render(), /✗/);
	branch = [
		{ type: "message", id: "aborted", parentId: null, timestamp: "", message: { ...message, stopReason: "aborted" } },
	];
	handlers.get("session_tree")?.({}, ctx);
	assert.match(render(), /❯/);
	branch = [
		{ type: "message", id: "e2", parentId: null, timestamp: "", message: { ...message, stopReason: "error" } },
		{ type: "message", id: "a2", parentId: "e2", timestamp: "", message: { ...message, stopReason: "aborted" } },
	];
	handlers.get("session_tree")?.({}, ctx);
	assert.match(render(), /✗/);

	for (const aborted of [false, true]) {
		handlers.get("agent_start")?.({}, ctx);
		assert.match(render(), /󰊠/);
		handlers.get("agent_end")?.({}, ctx);
		assert.match(render(), /󰊠/);
		const settled: AgentSettledEvent = { type: "agent_settled", aborted };
		handlers.get("agent_settled")?.(settled, ctx);
		assert.doesNotMatch(render(), /󰊠/);
	}
	handlers.get("session_shutdown")?.({}, ctx);
});

test("subscription identity is captured per request and persisted by assistant entry ID", () => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const entries: SessionEntry[] = [];
	let oauth = false;
	let known = true;
	let subscriptionProvider = true;
	const model = { provider: "openai", id: "gpt-test", api: "openai-responses" };
	const pi = {
		registerCommand: () => {},
		appendEntry: (customType: string, data: unknown) =>
			entries.push({
				type: "custom",
				id: `billing-${entries.length}`,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: "",
				customType,
				data,
			}),
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: false,
		mode: "print",
		model,
		modelRegistry: {
			find: () => (known ? model : undefined),
			isUsingOAuth: () => oauth,
			getProvider: () => ({ auth: { oauth: { isSubscription: subscriptionProvider } } }),
		},
		sessionManager: { getEntries: () => entries, getLeafId: () => entries.at(-1)?.id ?? null },
		ui: { setFooter: () => {} },
	} as unknown as ExtensionContext;
	zContext(pi);
	for (const [id, usesOAuth, hasModel, plan, provider] of [
		["api-before", false, true, true, "openai"],
		["subscription", true, true, true, "openai"],
		["api-after", false, true, true, "openai"],
		["unknown-model", true, false, true, "openai"],
		["oauth-not-plan", true, true, false, "openai"],
		["other-subscription", true, true, true, "anthropic"],
	] as const) {
		model.provider = provider;
		oauth = usesOAuth;
		known = hasModel;
		subscriptionProvider = plan;
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			timestamp: 0,
			usage: {
				input: 10,
				output: 0,
				cacheRead: 90,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 },
			},
		};
		handlers.get("turn_start")?.({}, ctx);
		handlers.get("message_start")?.({ message: { role: "user" } }, ctx);
		handlers.get("message_start")?.({ message }, ctx);
		oauth = false; // A later login change must not rewrite this request's billing identity.
		handlers.get("message_end")?.({ message }, ctx);
		entries.push({ type: "message", id, parentId: entries.at(-1)?.id ?? null, timestamp: "", message });
		handlers.get("turn_end")?.({ message, messageEntryId: id }, ctx);
	}
	const records = entries.filter((entry) => entry.type === "custom" && entry.customType === SUBSCRIPTION_TURN_ENTRY);
	assert.equal(records.length, 1);
	assert.deepEqual(records[0]?.data, { messageEntryId: "subscription" });
	assert.equal(accumulateSessionUsage(JSON.parse(JSON.stringify(entries)) as SessionEntry[]).cost, 0.5);
	handlers.get("session_shutdown")?.({}, ctx);
});
