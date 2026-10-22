import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import type {
	AgentSettledEvent,
	CustomEntry,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import zContext from "./index.ts";
import { ASCII_GLYPHS, GHOST_GLYPH, GHOST_TOKENS, NERD_GLYPHS } from "./lib/chrome.ts";
import {
	type AssistantMessage,
	accumulateSessionUsage,
	PARENT_MARKERS_CHECKED_ENTRY,
	SUBSCRIPTION_TURN_ENTRY,
} from "./lib/context.ts";

const token = (accountId: string): string =>
	`x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64")}.y`;

/** Last entry narrowed to a custom entry; the subscription-marker assertions only append those. */
const lastCustom = (entries: readonly SessionEntry[]): CustomEntry => {
	const last = entries.at(-1);
	if (last?.type !== "custom") throw new Error(`expected a custom entry, got ${last?.type ?? "none"}`);
	return last;
};

test("registered reset command refreshes quota after a completed redeem", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-reset-entry-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(async () => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		await rm(dir, { recursive: true, force: true });
	});
	let command: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"] | undefined;
	zContext({
		registerCommand: (name: string, value: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
			if (name === "openai-codex-reset") command = value.handler;
		},
		on: () => {},
	} as unknown as ExtensionAPI);
	assert.ok(command);
	const notices: string[] = [];
	const urls: string[] = [];
	t.mock.method(globalThis, "fetch", async (url: string) => {
		urls.push(url);
		if (url.endsWith("/rate-limit-reset-credits/consume")) return new Response(JSON.stringify({ code: "reset" }));
		if (url.endsWith("/rate-limit-reset-credits")) return new Response(JSON.stringify([{ id: "credit" }]));
		if (url.endsWith("/wham/usage")) return new Response(JSON.stringify({}));
		throw new Error(`unexpected fetch ${url}`);
	});
	const ctx = {
		mode: "tui",
		model: { provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" },
		modelRegistry: { getApiKeyForProvider: async () => token("a") },
		ui: { confirm: async () => true, notify: (message: string) => notices.push(message) },
	} as unknown as ExtensionCommandContext;
	await command("", ctx);
	assert.equal(notices.at(-1), "OpenAI reset applied");
	assert.ok(urls.some((url) => url.endsWith("/wham/usage")));
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
	assert.match(render(), /auto → gpt-routed · medium/);
	branch.push({
		type: "message",
		id: "failed",
		parentId: "routed",
		timestamp: "",
		message: { ...message, model: "failed-route", stopReason: "error" },
	});
	handlers.get("session_tree")?.({}, ctx);
	assert.match(render(), /auto → gpt-routed · medium/);
	assert.doesNotMatch(render(), /failed-route/);
	branch = [];
	handlers.get("session_tree")?.({}, ctx);
	assert.doesNotMatch(render(), /→/);
	model = { ...model, api: "openai-responses", provider: "openai" };
	handlers.get("model_select")?.({}, ctx);
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
	assert.deepEqual(lastCustom(records).data, { messageEntryId: "subscription" });
	assert.equal(accumulateSessionUsage(JSON.parse(JSON.stringify(entries)) as SessionEntry[]).cost, 0.5);
	handlers.get("session_shutdown")?.({}, ctx);
});

const billedResponse = (id: string): SessionEntry =>
	({
		type: "message",
		id,
		parentId: null,
		timestamp: "",
		message: {
			role: "assistant",
			content: [],
			api: "openai",
			provider: "openai",
			model: "gpt",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.4 },
			},
			stopReason: "stop",
			timestamp: 0,
		},
	}) as unknown as SessionEntry;

const markerEntry = (messageEntryId: string, parentId: string | null): SessionEntry => ({
	type: "custom",
	id: `billing-${messageEntryId}`,
	parentId,
	timestamp: "",
	customType: SUBSCRIPTION_TURN_ENTRY,
	data: { messageEntryId },
});

/** Standalone provider usage (e.g. cache warming) that Pi appends without a turn or agent event. */
const usageEntry = (id: string, total: number): SessionEntry =>
	({
		type: "usage",
		id,
		parentId: null,
		timestamp: "",
		kind: "cache_warm",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
		},
	}) as unknown as SessionEntry;

test("in-memory fork carries the endpoint's explicit billing marker with no parent file", () => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	let entries: SessionEntry[] = [];
	const pi = {
		registerCommand: () => {},
		appendEntry: (customType: string, data: unknown) => {
			entries.push({
				type: "custom",
				id: `appended-${entries.length}`,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: "",
				customType,
				data,
			} as SessionEntry);
		},
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: false,
		mode: "print",
		sessionManager: {
			getEntries: () => entries,
			getLeafId: () => entries.at(-1)?.id ?? null,
			getEntry: (id: string) => entries.find((entry) => entry.id === id),
			getHeader: () => null,
		},
		ui: { setFooter: () => {} },
	} as unknown as ExtensionContext;
	zContext(pi);
	entries = [billedResponse("sub"), markerEntry("sub", "sub")];
	handlers.get("session_before_fork")?.({ entryId: "sub", position: "at" }, ctx);
	// Pi tears the old session down before the fork's session_start, so the carried ids must survive this.
	handlers.get("session_shutdown")?.({ reason: "fork" }, ctx);
	entries = [billedResponse("sub")]; // In-memory fork keeps the response, drops the child marker, sets no parent file.
	handlers.get("session_start")?.({ reason: "fork" }, ctx);
	assert.deepEqual(lastCustom(entries).data, { messageEntryId: "sub" });
	assert.equal(accumulateSessionUsage(entries).cost, 0);
});

test("in-memory fork carries markers for earlier responses retained on the target branch", () => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	let entries: SessionEntry[] = [];
	const pi = {
		registerCommand: () => {},
		appendEntry: (customType: string, data: unknown) => {
			entries.push({
				type: "custom",
				id: `appended-${entries.length}`,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: "",
				customType,
				data,
			} as SessionEntry);
		},
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: false,
		mode: "print",
		sessionManager: {
			getEntries: () => entries,
			getLeafId: () => entries.at(-1)?.id ?? null,
			getEntry: (id: string) => entries.find((entry) => entry.id === id),
			getHeader: () => null,
		},
		ui: { setFooter: () => {} },
	} as unknown as ExtensionContext;
	zContext(pi);
	// Subscription A keeps its marker on a sibling branch; paid B is the fork endpoint under A.
	entries = [billedResponse("a"), markerEntry("a", "a"), { ...billedResponse("b"), parentId: "a" }];
	handlers.get("session_before_fork")?.({ entryId: "b", position: "at" }, ctx);
	handlers.get("session_shutdown")?.({ reason: "fork" }, ctx);
	entries = [billedResponse("a"), { ...billedResponse("b"), parentId: "a" }];
	handlers.get("session_start")?.({ reason: "fork" }, ctx);
	assert.deepEqual(lastCustom(entries).data, { messageEntryId: "a" });
	assert.ok(Math.abs(accumulateSessionUsage(entries).cost - 0.4) < 1e-10);
});

test("a non-fork shutdown drops carried fork markers instead of leaking them", () => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	let entries: SessionEntry[] = [];
	const pi = {
		registerCommand: () => {},
		appendEntry: (customType: string, data: unknown) => {
			entries.push({
				type: "custom",
				id: `appended-${entries.length}`,
				parentId: entries.at(-1)?.id ?? null,
				timestamp: "",
				customType,
				data,
			} as SessionEntry);
		},
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: false,
		mode: "print",
		sessionManager: {
			getEntries: () => entries,
			getLeafId: () => entries.at(-1)?.id ?? null,
			getEntry: (id: string) => entries.find((entry) => entry.id === id),
			getHeader: () => null,
		},
		ui: { setFooter: () => {} },
	} as unknown as ExtensionContext;
	zContext(pi);
	entries = [billedResponse("sub"), markerEntry("sub", "sub")];
	handlers.get("session_before_fork")?.({ entryId: "sub", position: "at" }, ctx);
	handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
	entries = [billedResponse("sub")];
	handlers.get("session_start")?.({ reason: "fork" }, ctx);
	assert.equal(entries.length, 1);
	assert.ok(accumulateSessionUsage(entries).cost > 0);
});

test("session_start recovers markers from a persisted parent file and skips non-regular parents", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-fork-recover-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const parent = join(dir, "parent.jsonl");
	await writeFile(
		parent,
		[
			JSON.stringify({ type: "session", id: "p", timestamp: "", cwd: "" }),
			JSON.stringify(billedResponse("sub")),
			JSON.stringify(markerEntry("sub", "sub")),
		].join("\n"),
	);
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const appended: unknown[] = [];
	const pi = {
		registerCommand: () => {},
		appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	const ctxFor = (parentSession: string): ExtensionContext =>
		({
			hasUI: false,
			mode: "print",
			sessionManager: { getEntries: () => [billedResponse("sub")], getHeader: () => ({ parentSession }) },
		}) as unknown as ExtensionContext;
	zContext(pi);
	handlers.get("session_start")?.({ reason: "startup" }, ctxFor(parent));
	assert.deepEqual(appended, [
		{ customType: SUBSCRIPTION_TURN_ENTRY, data: { messageEntryId: "sub" } },
		{ customType: PARENT_MARKERS_CHECKED_ENTRY, data: { parentSession: parent } },
	]);
	appended.length = 0;
	handlers.get("session_start")?.({ reason: "startup" }, ctxFor(dir)); // Non-regular parent: no read, no hang.
	handlers.get("session_start")?.({ reason: "startup" }, ctxFor(join(dir, "missing.jsonl")));
	assert.deepEqual(appended, []);
});

test("a checked parent is skipped, and a sentinel copied from another fork does not skip it", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-fork-sentinel-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const parent = join(dir, "parent.jsonl");
	await writeFile(
		parent,
		[
			JSON.stringify({ type: "session", id: "p", timestamp: "", cwd: "" }),
			JSON.stringify(billedResponse("sub")),
			JSON.stringify(markerEntry("sub", "sub")),
		].join("\n"),
	);
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const appended: unknown[] = [];
	let entries: readonly SessionEntry[] = [];
	const pi = {
		registerCommand: () => {},
		appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	const checked = (parentSession: string): SessionEntry =>
		({
			type: "custom",
			id: `checked-${parentSession}`,
			parentId: null,
			timestamp: "",
			customType: PARENT_MARKERS_CHECKED_ENTRY,
			data: { parentSession },
		}) as SessionEntry;
	const ctx = {
		hasUI: false,
		mode: "print",
		sessionManager: { getEntries: () => entries, getHeader: () => ({ parentSession: parent }) },
	} as unknown as ExtensionContext;
	zContext(pi);

	entries = [billedResponse("sub"), checked(parent)];
	handlers.get("session_start")?.({ reason: "resume" }, ctx);
	assert.deepEqual(appended, []);

	// The same sentinel copied through another fork names the wrong parent: the read must run again.
	entries = [billedResponse("sub"), checked(join(dir, "other.jsonl"))];
	handlers.get("session_start")?.({ reason: "resume" }, ctx);
	assert.deepEqual(appended, [
		{ customType: SUBSCRIPTION_TURN_ENTRY, data: { messageEntryId: "sub" } },
		{ customType: PARENT_MARKERS_CHECKED_ENTRY, data: { parentSession: parent } },
	]);
});

test("runtime ascii-fallback toggle swaps editor glyphs without rewriting the config file", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-toggle-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(async () => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		await rm(dir, { recursive: true, force: true });
	});

	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	let command: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"] | undefined;
	let render = (): string => "";
	const notices: Array<{ message: string; level: string }> = [];
	const tui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
	const editorTheme = { borderColor: (text: string) => text } as EditorTheme;
	const model = {
		api: "openai-codex-responses",
		provider: "openai-codex",
		id: "gpt-test",
		contextWindow: 100_000,
		baseUrl: "https://chatgpt.com/backend-api",
	};
	const ctx = {
		hasUI: true,
		mode: "tui",
		model,
		getContextUsage: () => ({ tokens: 0, contextWindow: model.contextWindow }),
		sessionManager: { getEntries: () => [], getLeafId: () => null, getBranch: () => [] },
		modelRegistry: { getApiKeyForProvider: async () => undefined },
		ui: {
			notify: (message: string, level: string) => notices.push({ message, level }),
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
	const pi = {
		registerCommand: (name: string, value: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
			if (name === "context-bar") command = value.handler;
		},
		getThinkingLevel: () => "off",
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;

	zContext(pi);
	assert.ok(command);
	const contextBar = command;
	handlers.get("session_start")?.({ reason: "startup" }, ctx);
	assert.ok(render().includes(NERD_GLYPHS.pacmanOpen));

	await contextBar("ascii-fallback on", ctx as unknown as ExtensionCommandContext);
	assert.ok(render().includes(ASCII_GLYPHS.pacmanOpen));
	assert.ok(!render().includes(NERD_GLYPHS.pacmanOpen));

	// The file is re-read at session start, so a runtime choice never outlives its session.
	handlers.get("session_start")?.({ reason: "new" }, ctx);
	assert.ok(render().includes(NERD_GLYPHS.pacmanOpen));

	// Both switches share one command; the argument decides which one moved.
	await contextBar("ascii-fallback", ctx as unknown as ExtensionCommandContext);
	assert.ok(render().includes(ASCII_GLYPHS.pacmanOpen));
	assert.deepEqual(notices.at(-1), { message: "ASCII glyphs on", level: "info" });

	await contextBar("ascii-fallback maybe", ctx as unknown as ExtensionCommandContext);
	assert.ok(render().includes(ASCII_GLYPHS.pacmanOpen));
	assert.deepEqual(notices.at(-1), {
		message: "Usage: /context-bar ascii-fallback [on|off|toggle]",
		level: "warning",
	});
});

test("re-applies asciiFallback glyphs after Pi replaces the session", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-glyphs-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(async () => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		await rm(dir, { recursive: true, force: true });
	});
	await writeFile(join(dir, "pi-context-bar.json"), JSON.stringify({ asciiFallback: true }));

	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	let render = (): string => "";
	const tui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
	const editorTheme = { borderColor: (text: string) => text } as EditorTheme;
	const model = {
		api: "openai-codex-responses",
		provider: "openai-codex",
		id: "gpt-test",
		contextWindow: 100_000,
		baseUrl: "https://chatgpt.com/backend-api",
	};
	const ctx = {
		hasUI: true,
		mode: "tui",
		model,
		getContextUsage: () => ({ tokens: 0, contextWindow: model.contextWindow }),
		sessionManager: { getEntries: () => [], getLeafId: () => null, getBranch: () => [] },
		modelRegistry: { getApiKeyForProvider: async () => undefined },
		ui: {
			notify: () => {},
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
	const pi = {
		registerCommand: () => {},
		getThinkingLevel: () => "off",
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;

	zContext(pi);
	handlers.get("session_start")?.({ reason: "startup" }, ctx);
	assert.ok(render().includes(ASCII_GLYPHS.pacmanOpen));
	assert.ok(!render().includes(NERD_GLYPHS.pacmanOpen));

	// Pi tears down and recreates the session without re-running the extension factory.
	handlers.get("session_shutdown")?.({ reason: "new" }, ctx);
	handlers.get("session_start")?.({ reason: "new" }, ctx);
	assert.ok(render().includes(ASCII_GLYPHS.pacmanOpen));
	assert.ok(!render().includes(NERD_GLYPHS.pacmanOpen));
});

test("lane chomps streamed tokens, reports live speed, and rewinds after compaction", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-lane-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(async () => {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		await rm(dir, { recursive: true, force: true });
	});

	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	let render = (): string => "";
	let drawHeader: (width: number) => string = () => "";
	let headerRows = 0;
	let expandHeader = (_next: boolean): void => {};
	let usedTokens = 0;
	const tui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
	const editorTheme = { borderColor: (text: string) => text } as EditorTheme;
	const model = {
		api: "openai-codex-responses",
		provider: "openai-codex",
		id: "gpt-test",
		contextWindow: 100_000,
		baseUrl: "https://chatgpt.com/backend-api",
	};
	const ctx = {
		hasUI: true,
		mode: "tui",
		model,
		getContextUsage: () => ({ tokens: usedTokens, contextWindow: model.contextWindow }),
		sessionManager: { getEntries: () => [], getLeafId: () => null, getBranch: () => [] },
		modelRegistry: {
			getApiKeyForProvider: async () => undefined,
			find: () => undefined,
			isUsingOAuth: () => false,
			getProvider: () => undefined,
		},
		ui: {
			notify: () => {},
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
				style: (text: string) => text,
			},
			setWorkingVisible: () => {},
			setFooter: () => {},
			setHeader: (factory: Parameters<ExtensionContext["ui"]["setHeader"]>[0]) => {
				if (!factory) return;
				const component = factory(tui, undefined as never);
				drawHeader = (width: number) => {
					const rows = component.render(width);
					headerRows = rows.length;
					return stripVTControlCharacters(rows.join("\n"));
				};
				expandHeader = (next: boolean) =>
					(component as unknown as { setExpanded: (next: boolean) => void }).setExpanded(next);
			},
			setEditorComponent: (factory: Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]) => {
				if (factory) {
					const editor = factory(tui, editorTheme, {} as Parameters<NonNullable<typeof factory>>[2]);
					render = () => stripVTControlCharacters(editor.render(100).join("\n"));
				}
			},
		},
	} as unknown as ExtensionContext;
	const pi = {
		registerCommand: () => {},
		getThinkingLevel: () => "medium",
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;

	zContext(pi);
	handlers.get("session_start")?.({ reason: "startup" }, ctx);
	assert.ok(drawHeader(80).includes(VERSION));
	// Hint keys resolve only inside a running Pi, so this proves expansion stays wired without throwing.
	expandHeader(true);
	assert.ok(drawHeader(80).includes(`v${VERSION}`));
	assert.ok(headerRows >= 2);

	usedTokens = 23_000;
	handlers.get("context")?.({ type: "context", messages: [] }, ctx);
	assert.ok(render().includes("23.0%"));
	assert.ok(!render().includes(NERD_GLYPHS.ghost));

	handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
	handlers.get("message_start")?.({ type: "message_start", message: { role: "user" } }, ctx);
	handlers.get("message_start")?.(
		{
			type: "message_start",
			message: { role: "assistant", provider: "openai", model: "gpt" },
		},
		ctx,
	);
	handlers.get("message_update")?.({ type: "message_update", assistantMessageEvent: { type: "text_start" } }, ctx);
	// 10 streamed tokens land on frame 3, so the mouth is closed while the ghost trails the lane.
	handlers.get("message_update")?.(
		{
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "y".repeat(40) },
		},
		ctx,
	);
	assert.ok(render().includes(NERD_GLYPHS.pacmanClosed));
	// 110 tokens total: frame 36 is an open mouth, and live speed stays dim text beside the lane.
	handlers.get("message_update")?.(
		{
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(400) },
		},
		ctx,
	);
	const streamed = render();
	assert.ok(streamed.includes(NERD_GLYPHS.ghost));
	assert.ok(streamed.includes(NERD_GLYPHS.pacmanOpen));
	assert.match(streamed, /\d+\.\dt\/s/);

	handlers.get("tool_execution_start")?.({ type: "tool_execution_start" }, ctx);
	handlers.get("message_end")?.({ type: "message_end", message: { role: "user" } }, ctx);
	handlers.get("message_end")?.({ type: "message_end", message: { role: "assistant", usage: { output: 50 } } }, ctx);
	handlers.get("turn_end")?.(
		{
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", stopReason: "stop" },
			messageEntryId: "entry-1",
			toolResults: [],
			toolResultEntryIds: [],
		},
		ctx,
	);
	handlers.get("agent_end")?.({ type: "agent_end" }, ctx);
	handlers.get("thinking_level_select")?.({}, ctx);
	handlers.get("session_tree")?.({ type: "session_tree" }, ctx);
	handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
	const idle = render();
	assert.ok(!idle.includes(NERD_GLYPHS.ghost));
	assert.ok(idle.includes(NERD_GLYPHS.pacmanOpen));

	// Compaction slides Pac-Man back from the pre-compact percent, then self-clears.
	t.mock.timers.enable({ apis: ["setInterval"] });
	usedTokens = 8_000;
	handlers.get("session_compact")?.(
		{ type: "session_compact", compactionEntry: {}, fromExtension: false, reason: "threshold", willRetry: false },
		ctx,
	);
	assert.ok(render().includes("23.0%"));
	t.mock.timers.tick(70);
	assert.ok(render().includes("20.5%"));
	t.mock.timers.tick(70 * 6);
	assert.ok(render().includes("8.0%"));
	t.mock.timers.reset();
});

test("warns once when a custom endpoint keeps Codex quota unavailable", async (t) => {
	const notices: string[] = [];
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const pi = {
		registerCommand: () => {},
		getThinkingLevel: () => "off",
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	t.mock.method(globalThis, "fetch", async () => {
		throw new Error("quota must not be polled on a custom endpoint");
	});
	const model = {
		api: "openai-codex-responses",
		provider: "openai-codex",
		id: "gpt-test",
		contextWindow: 100_000,
		baseUrl: "https://proxy.example.com/backend-api",
	};
	const ctx = {
		hasUI: true,
		mode: "tui",
		model,
		getContextUsage: () => ({ tokens: 0, contextWindow: model.contextWindow }),
		sessionManager: { getEntries: () => [], getLeafId: () => null, getBranch: () => [] },
		modelRegistry: { getApiKeyForProvider: async () => token("A") },
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
			setEditorComponent: () => {},
		},
	} as unknown as ExtensionContext;
	zContext(pi);
	handlers.get("session_start")?.({ reason: "startup" }, ctx);
	await setImmediate();
	await setImmediate();
	assert.deepEqual(notices, ["OpenAI Codex quota is off: the active model does not use the official ChatGPT endpoint"]);
	handlers.get("model_select")?.({}, ctx);
	await setImmediate();
	assert.equal(notices.length, 1);
});

test("honours quietStartup by leaving pi's own startup header alone", () => {
	const startSession = (settings: { quietStartup: boolean | "header" } | undefined) => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		let headers = 0;
		const model = { api: "openai-codex-responses", provider: "openai-codex", id: "gpt-test", contextWindow: 100_000 };
		const ctx = {
			hasUI: true,
			mode: "tui",
			model,
			getContextUsage: () => ({ tokens: 0, contextWindow: model.contextWindow }),
			sessionManager: { getEntries: () => [], getLeafId: () => null, getBranch: () => [] },
			modelRegistry: { getApiKeyForProvider: async () => undefined },
			ui: {
				notify: () => {},
				theme: {
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
					style: (text: string) => text,
				},
				setWorkingVisible: () => {},
				setHeader: () => {
					headers += 1;
				},
				setFooter: () => {},
				setEditorComponent: () => {},
			},
		} as unknown as ExtensionContext;
		const pi = {
			registerCommand: () => {},
			getThinkingLevel: () => "off",
			getSettings: () => settings,
			on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
		} as unknown as ExtensionAPI;
		zContext(pi);
		handlers.get("session_start")?.({ reason: "startup" }, ctx);
		return headers;
	};

	assert.equal(startSession({ quietStartup: true }), 0);
	assert.equal(startSession(undefined), 1);
	assert.equal(startSession({ quietStartup: "header" }), 1);
	// A throwing or absent settings read must not cost the user the header.
	assert.equal(startSession(undefined), 1);
});

test("tool-call events keep the generating ghost while only answer text succeeds", async () => {
	// Regression: toolcall_start/toolcall_delta used to map to `assistant` (success), claiming an answer
	// had started while the model was still generating tool arguments. This drives the real event
	// handlers through the editor and reads the ghost's theme token, not just the static token table.
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const painted: Array<readonly [string, string]> = [];
	let render = (): string => "";
	const tui = { requestRender: () => {}, terminal: { rows: 20 } } as unknown as TUI;
	const editorTheme = { borderColor: (text: string) => text } as EditorTheme;
	const ctx = {
		hasUI: true,
		mode: "tui",
		model: { api: "openai-responses", provider: "openai", id: "gpt-test", contextWindow: 100_000 },
		getContextUsage: () => ({ tokens: 100_000, contextWindow: 100_000 }),
		sessionManager: {
			getEntries: () => [],
			getLeafId: () => null,
			getBranch: () => [],
			getHeader: () => null,
		},
		modelRegistry: { getApiKeyForProvider: async () => undefined },
		ui: {
			notify: () => {},
			theme: {
				fg: (token: string, text: string) => {
					painted.push([token, text]);
					return text;
				},
				bold: (text: string) => text,
				style: (text: string) => text,
			},
			setWorkingVisible: () => {},
			setHeader: () => {},
			setFooter: () => {},
			setEditorComponent: (factory: Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]) => {
				if (factory) {
					const editor = factory(tui, editorTheme, {} as Parameters<NonNullable<typeof factory>>[2]);
					render = () => editor.render(100).join("\n");
				}
			},
		},
	} as unknown as ExtensionContext;
	const pi = {
		registerCommand: () => {},
		getThinkingLevel: () => "off",
		getSettings: () => ({}),
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	zContext(pi);
	handlers.get("session_start")?.({}, ctx);
	const ghostToken = (): string | undefined => {
		painted.length = 0;
		render();
		return painted.filter(([, text]) => text.includes(GHOST_GLYPH)).at(-1)?.[0];
	};
	const update = (type: string): void => handlers.get("message_update")?.({ assistantMessageEvent: { type } }, ctx);

	handlers.get("agent_start")?.({}, ctx);
	assert.equal(ghostToken(), GHOST_TOKENS.working);
	update("thinking_start");
	assert.equal(ghostToken(), GHOST_TOKENS.thinking);
	update("toolcall_start");
	assert.equal(ghostToken(), GHOST_TOKENS.tools);
	assert.notEqual(ghostToken(), GHOST_TOKENS.assistant);
	update("toolcall_delta");
	assert.equal(ghostToken(), GHOST_TOKENS.tools);
	update("text_start");
	assert.equal(ghostToken(), GHOST_TOKENS.assistant);
	update("text_delta");
	assert.equal(ghostToken(), GHOST_TOKENS.assistant);
	handlers.get("agent_settled")?.({}, ctx);
	assert.equal(ghostToken(), undefined);
	handlers.get("session_shutdown")?.({}, ctx);
});

test("unknown native context tokens stay unavailable through compaction and recover numerically", async (t) => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	let render = (): string => "";
	let tokens: number | null = null;
	const tui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
	const editorTheme = { borderColor: (text: string) => text } as EditorTheme;
	const model = {
		api: "openai-codex-responses",
		provider: "openai-codex",
		id: "gpt-test",
		contextWindow: 100_000,
		baseUrl: "https://chatgpt.com/backend-api",
	};
	const ctx = {
		hasUI: true,
		mode: "tui",
		model,
		getContextUsage: () => ({ tokens, contextWindow: model.contextWindow }),
		sessionManager: { getEntries: () => [], getLeafId: () => null, getBranch: () => [] },
		modelRegistry: { getApiKeyForProvider: async () => undefined },
		ui: {
			notify: () => {},
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
	const pi = {
		registerCommand: () => {},
		getThinkingLevel: () => "off",
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	zContext(pi);
	// Native pi 1.2 payload right after compaction: window known, tokens null. It must read unavailable, not zero.
	handlers.get("session_start")?.({ reason: "startup" }, ctx);
	assert.ok(render().includes("?%"));
	assert.ok(!render().includes("0.0%"));
	// A numeric reading first, then a null compaction, must not rewind Pac-Man back to zero.
	tokens = 30_000;
	handlers.get("context")?.({ type: "context", messages: [] }, ctx);
	assert.ok(render().includes("30.0%"));
	t.mock.timers.enable({ apis: ["setInterval"] });
	tokens = null;
	handlers.get("session_compact")?.(
		{ type: "session_compact", compactionEntry: {}, fromExtension: false, reason: "threshold", willRetry: false },
		ctx,
	);
	assert.ok(render().includes("?%"));
	t.mock.timers.tick(70 * 8);
	assert.ok(render().includes("?%"));
	assert.ok(!render().includes("0.0%"));
	t.mock.timers.reset();
	// A usable post-compaction response restores the normal numeric reading.
	tokens = 8_000;
	handlers.get("agent_end")?.({}, ctx);
	assert.ok(render().includes("8.0%"));
	assert.ok(!render().includes("?%"));
	handlers.get("session_shutdown")?.({}, ctx);
});

test("editor health scans background usage on render without a turn or agent event", () => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	let render = (): string => "";
	let entries: SessionEntry[] = [];
	let leafId: string | null = null;
	const tui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
	const editorTheme = { borderColor: (text: string) => text } as EditorTheme;
	const model = { api: "openai-responses", provider: "openai", id: "gpt-test", contextWindow: 100_000 };
	const ctx = {
		hasUI: true,
		mode: "tui",
		model,
		getContextUsage: () => ({ tokens: 1_000, contextWindow: model.contextWindow }),
		sessionManager: { getEntries: () => entries, getLeafId: () => leafId, getBranch: () => [] },
		modelRegistry: { getApiKeyForProvider: async () => undefined },
		ui: {
			notify: () => {},
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
	const pi = {
		registerCommand: () => {},
		getThinkingLevel: () => "off",
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	zContext(pi);
	handlers.get("session_start")?.({ reason: "startup" }, ctx);
	// Pi appends a standalone cache-warming usage entry while idle and only asks for a render; no
	// turn_end/agent_end fires, so the health callback itself must notice the new leaf.
	entries = [usageEntry("warm", 0.25)];
	leafId = "warm";
	assert.ok(render().includes("$0.250"));
	// The same render path still reclassifies a billed response when its marker becomes the leaf.
	const response = billedResponse("billed");
	entries = [response];
	leafId = "billed";
	assert.ok(render().includes("$0.400"));
	entries = [response, markerEntry("billed", "billed")];
	leafId = "billing-billed";
	assert.ok(!render().includes("$0.400"));
	handlers.get("session_shutdown")?.({}, ctx);
});

test("quota is validated against the active endpoint before and after the request", async (t) => {
	const OFFICIAL = "https://chatgpt.com/backend-api";
	const PROXY = "https://proxy.example.com/backend-api";
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const notices: string[] = [];
	let render = (): string => "";
	const tui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
	const editorTheme = { borderColor: (text: string) => text } as EditorTheme;
	let model = {
		api: "openai-codex-responses",
		provider: "openai-codex",
		id: "gpt-test",
		contextWindow: 100_000,
		baseUrl: OFFICIAL,
	};
	const ctx = {
		hasUI: true,
		mode: "tui",
		get model() {
			return model;
		},
		getContextUsage: () => ({ tokens: 1_000, contextWindow: model.contextWindow }),
		sessionManager: { getEntries: () => [], getLeafId: () => null, getBranch: () => [] },
		modelRegistry: {
			getApiKeyForProvider: async () =>
				`x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "A" } })).toString("base64")}.y`,
		},
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
	const pi = {
		registerCommand: () => {},
		getThinkingLevel: () => "off",
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	const fetched: string[] = [];
	const pending: Array<(response: Response) => void> = [];
	t.mock.method(globalThis, "fetch", async (url: string) => {
		fetched.push(String(url));
		return new Promise<Response>((resolve) => pending.push(resolve));
	});
	const usage = (percent: number): Response =>
		new Response(
			JSON.stringify({ rate_limit: { primary_window: { used_percent: percent, limit_window_seconds: 18_000 } } }),
		);
	zContext(pi);
	handlers.get("session_start")?.({ reason: "startup" }, ctx);
	await setImmediate();
	assert.equal(fetched.length, 1);
	pending[0]?.(usage(12));
	await setImmediate();
	assert.match(render(), /5h 12%/);

	// Switching the same account's physical model to a proxy clears the previously shown official quota,
	// warns once, and never forwards credentials to the proxy endpoint.
	model = { ...model, baseUrl: PROXY };
	handlers.get("model_select")?.({}, ctx);
	await setImmediate();
	assert.doesNotMatch(render(), /5h 12%/);
	assert.equal(fetched.length, 1);
	assert.deepEqual(notices, ["OpenAI Codex quota is off: the active model does not use the official ChatGPT endpoint"]);

	// An official request already in flight must discard its delayed reply after the switch.
	model = { ...model, baseUrl: OFFICIAL };
	handlers.get("model_select")?.({}, ctx);
	await setImmediate();
	assert.equal(fetched.length, 2);
	model = { ...model, baseUrl: PROXY };
	handlers.get("model_select")?.({}, ctx);
	await setImmediate();
	assert.equal(fetched.length, 2);
	pending[1]?.(usage(88));
	await setImmediate();
	assert.doesNotMatch(render(), /5h 88%/);
	assert.equal(notices.length, 1);
	assert.ok(fetched.every((url) => url.startsWith("https://chatgpt.com/backend-api/")));

	// A later throttled same-endpoint lookup must not drop the valid in-flight result.
	model = { ...model, baseUrl: OFFICIAL };
	handlers.get("model_select")?.({}, ctx);
	await setImmediate();
	assert.equal(fetched.length, 3);
	handlers.get("model_select")?.({}, ctx);
	await setImmediate();
	assert.equal(fetched.length, 3);
	pending[2]?.(usage(77));
	await setImmediate();
	assert.match(render(), /5h 77%/);
	handlers.get("session_shutdown")?.({}, ctx);
});

test("headless sessions do not poll quota for chrome they cannot show", async (t) => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const pi = {
		registerCommand: () => {},
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	let fetches = 0;
	t.mock.method(globalThis, "fetch", async () => {
		fetches++;
		return new Response("{}");
	});
	const ctx = {
		hasUI: false,
		mode: "print",
		model: {
			provider: "openai-codex",
			api: "openai-codex-responses",
			id: "gpt",
			baseUrl: "https://chatgpt.com/backend-api",
		},
		sessionManager: { getEntries: () => [], getLeafId: () => null },
		modelRegistry: { getApiKeyForProvider: async () => token("a") },
	} as unknown as ExtensionContext;
	zContext(pi);
	handlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "stop" }, messageEntryId: "x" }, ctx);
	await setImmediate();
	assert.equal(fetches, 0);
});

test("does not bill a captured subscription response before its marker lands at turn_end", () => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	let render = (): string => "";
	let entries: SessionEntry[] = [];
	let leafId: string | null = null;
	const tui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
	const editorTheme = { borderColor: (text: string) => text } as EditorTheme;
	const model = { api: "openai-responses", provider: "openai", id: "gpt", contextWindow: 100_000 };
	const ctx = {
		hasUI: true,
		mode: "tui",
		model,
		getContextUsage: () => ({ tokens: 1_000, contextWindow: model.contextWindow }),
		sessionManager: { getEntries: () => entries, getLeafId: () => leafId, getBranch: () => [] },
		modelRegistry: {
			find: () => model,
			isUsingOAuth: () => true,
			getProvider: () => ({ auth: { oauth: { isSubscription: true } } }),
			getApiKeyForProvider: async () => undefined,
		},
		ui: {
			notify: () => {},
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
	const pi = {
		registerCommand: () => {},
		getThinkingLevel: () => "off",
		appendEntry: (customType: string, data: unknown) => {
			const id = `appended-${entries.length}`;
			entries.push({ type: "custom", id, parentId: leafId, timestamp: "", customType, data } as SessionEntry);
			leafId = id;
		},
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	zContext(pi);
	handlers.get("session_start")?.({}, ctx);
	entries = [billedResponse("paid")];
	leafId = "paid";
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt",
		stopReason: "toolUse",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
		},
	};
	handlers.get("turn_start")?.({}, ctx);
	handlers.get("message_start")?.({ message: { role: "user" } }, ctx);
	handlers.get("message_start")?.({ message }, ctx);
	handlers.get("message_end")?.({ message }, ctx);
	// Streaming renders before persistence must keep the earlier paid bill; the captured boundary has no
	// new assistant entry yet, so nothing may be provisionally excluded.
	assert.ok(render().includes("$0.400"));
	assert.ok(!render().includes("$0.500"));
	// Native pi persists the response at message_end; the marker is appended only at turn_end, after tools.
	entries = [billedResponse("paid"), { type: "message", id: "subscription", parentId: "paid", timestamp: "", message }];
	leafId = "subscription";
	handlers.get("tool_execution_start")?.({}, ctx);
	assert.ok(render().includes("$0.400"));
	assert.ok(!render().includes("$0.900"));
	// A tool result cost still counts while the provisional subscription response stays out.
	entries = [
		...entries,
		{
			type: "message",
			id: "tool",
			parentId: "subscription",
			timestamp: "",
			message: {
				role: "toolResult",
				toolCallId: "call",
				toolName: "generateImage",
				content: [],
				isError: false,
				timestamp: 0,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.04 },
				},
			},
		},
	];
	leafId = "tool";
	assert.ok(render().includes("$0.440"));
	assert.ok(!render().includes("$0.940"));
	// turn_end appends the marker; the response stays excluded and the paid/tool total is unchanged.
	handlers.get("turn_end")?.({ message, messageEntryId: "subscription" }, ctx);
	assert.ok(render().includes("$0.440"));
	assert.ok(!render().includes("$0.940"));
	handlers.get("session_shutdown")?.({}, ctx);
});
