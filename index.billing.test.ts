import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import zContext from "./index.ts";
import {
	type AssistantMessage,
	accumulateSessionUsage,
	PARENT_MARKERS_CHECKED_ENTRY,
	SUBSCRIPTION_TURN_ENTRY,
} from "./lib/context.ts";
import { billedResponse, branchTo, lastCustom, markerEntry } from "./test-support/fixtures.ts";

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
		get model() {
			return model;
		},
		modelRegistry: {
			find: (provider: string, id: string) => (known ? { ...model, provider, id } : undefined),
			isUsingOAuth: () => oauth,
			getProvider: () => ({ auth: { oauth: { isSubscription: subscriptionProvider } } }),
		},
		sessionManager: { getEntries: () => entries, getLeafId: () => entries.at(-1)?.id ?? null },
		ui: { setFooter: () => {} },
	} as unknown as ExtensionContext;
	zContext(pi);
	const assistant = (provider: string, id: string): AssistantMessage => ({
		role: "assistant",
		content: [],
		api: provider === "anthropic" ? "anthropic-messages" : "openai-responses",
		provider,
		model: id,
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
	});
	const expectedSubscriptions: string[] = [];
	for (const [id, usesOAuth, hasModel, plan, provider, selected, responseModel, selectedAfter] of [
		["api-before", false, true, true, "openai", undefined, "gpt-test", undefined],
		["subscription", true, true, true, "openai", undefined, "gpt-test", undefined],
		["api-after", false, true, true, "openai", undefined, "gpt-test", undefined],
		["unknown-model", true, false, true, "openai", undefined, "gpt-test", undefined],
		["oauth-not-plan", true, true, false, "openai", undefined, "gpt-test", undefined],
		["other-subscription", true, true, true, "anthropic", undefined, "gpt-test", undefined],
		[
			"routed-subscription",
			true,
			true,
			true,
			"openai",
			{ provider: "auto", api: "pi-virtual", id: "auto" },
			"gpt-routed",
			undefined,
		],
		[
			"selected-b-before-request",
			true,
			true,
			true,
			"openai",
			{ provider: "openai", api: "openai-responses", id: "gpt-b" },
			"gpt-a",
			undefined,
		],
		[
			"selected-anthropic-before-request",
			true,
			true,
			true,
			"openai",
			{ provider: "anthropic", api: "anthropic-messages", id: "claude" },
			"gpt-a",
			undefined,
		],
		[
			"selected-b-after-request",
			true,
			true,
			true,
			"openai",
			undefined,
			"gpt-a",
			{ provider: "openai", api: "openai-responses", id: "gpt-b" },
		],
		[
			"selected-anthropic-after-request",
			true,
			true,
			true,
			"openai",
			undefined,
			"gpt-a",
			{ provider: "anthropic", api: "anthropic-messages", id: "claude" },
		],
	] as const) {
		model.provider = selected?.provider ?? provider;
		model.api = selected?.api ?? "openai-responses";
		model.id = selected?.id ?? responseModel;
		oauth = usesOAuth;
		known = hasModel;
		subscriptionProvider = plan;
		const message = assistant(provider, responseModel);
		handlers.get("turn_start")?.({}, ctx);
		handlers.get("before_provider_request")?.({ payload: { model: responseModel } }, ctx);
		if (selectedAfter) {
			model.provider = selectedAfter.provider;
			model.api = selectedAfter.api;
			model.id = selectedAfter.id;
		}
		oauth = !usesOAuth; // Switch logins before the first response event; the request identity must survive.
		handlers.get("message_start")?.({ message: { role: "user" } }, ctx);
		handlers.get("message_start")?.({ message }, ctx);
		oauth = false; // A later login change must not rewrite this request's billing identity.
		handlers.get("message_end")?.({ message }, ctx);
		entries.push({ type: "message", id, parentId: entries.at(-1)?.id ?? null, timestamp: "", message });
		handlers.get("turn_end")?.({ message, messageEntryId: id }, ctx);
		if (usesOAuth && hasModel && plan && provider === "openai") expectedSubscriptions.push(id);
	}
	const records = entries
		.filter((entry) => entry.type === "custom" && entry.customType === SUBSCRIPTION_TURN_ENTRY)
		.map((entry) => lastCustom([entry]).data);
	assert.deepEqual(
		records,
		expectedSubscriptions.map((messageEntryId) => ({ messageEntryId })),
	);
	assert.equal(accumulateSessionUsage(JSON.parse(JSON.stringify(entries)) as SessionEntry[]).cost, 0.5);
	handlers.get("session_shutdown")?.({}, ctx);
});

test("in-memory fork carries the endpoint's explicit billing marker with no parent file", () => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	let entries: SessionEntry[] = [];
	let forkTarget: string | undefined;
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
			getBranch: (target?: string) => {
				forkTarget = target;
				return target ? branchTo(entries, target) : entries;
			},
			getHeader: () => null,
		},
		ui: { setFooter: () => {} },
	} as unknown as ExtensionContext;
	zContext(pi);
	entries = [billedResponse("sub"), markerEntry("sub", "sub")];
	handlers.get("session_before_fork")?.({ entryId: "sub", position: "at" }, ctx);
	assert.equal(forkTarget, "sub");
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
			getBranch: (target?: string) => (target ? branchTo(entries, target) : entries),
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
			getBranch: (target?: string) => (target ? branchTo(entries, target) : entries),
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

test("an already-marked billed response skips the parent read but still writes the sentinel", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-fork-marked-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const appended: unknown[] = [];
	const parent = join(dir, "missing.jsonl");
	const pi = {
		registerCommand: () => {},
		appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: false,
		mode: "print",
		sessionManager: {
			getEntries: () => [billedResponse("sub"), markerEntry("sub", "sub")],
			getHeader: () => ({ parentSession: parent }),
		},
	} as unknown as ExtensionContext;
	zContext(pi);
	// A missing parent proves the read was skipped: a read failure would defer the sentinel for a retry.
	handlers.get("session_start")?.({ reason: "resume" }, ctx);
	assert.deepEqual(appended, [{ customType: PARENT_MARKERS_CHECKED_ENTRY, data: { parentSession: parent } }]);
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
	handlers.get("before_provider_request")?.({ payload: { model: "gpt" } }, ctx);
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
