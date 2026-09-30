import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import zContext from "./index.ts";
import { type AssistantMessage, accumulateSessionUsage, SUBSCRIPTION_TURN_ENTRY } from "./lib/context.ts";

const token = (accountId: string): string =>
	`x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64")}.y`;

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
	assert.match(render(), /5h12%/);
	assert.match(render(), /20\.0% \(100K\)/);

	accountKey = token("B");
	model = { ...model, contextWindow: 40_000 };
	handlers.get("model_select")?.({}, ctx);
	await setImmediate();
	assert.match(render(), /50\.0% \(40K\)/);
	assert.doesNotMatch(render(), /5h12%/);

	accountKey = token("C");
	model = { ...model, id: "gpt-other" };
	handlers.get("model_select")?.({}, ctx);
	await setImmediate();
	assert.match(render(), /5h80%/);
	pending.get(2)?.(usageResponse(70));
	await setImmediate();
	assert.match(render(), /5h80%/);
	assert.doesNotMatch(render(), /5h70%/);

	accountKey = token("D");
	model = { ...model, id: "gpt-next" };
	handlers.get("model_select")?.({}, ctx);
	await setImmediate();
	model = { ...model, provider: "other" };
	handlers.get("model_select")?.({}, ctx);
	pending.get(4)?.(usageResponse(70));
	await setImmediate();
	assert.doesNotMatch(render(), /5h70%/);

	accountKey = token("C");
	model = { ...model, provider: "openai-codex" };
	handlers.get("model_select")?.({}, ctx);
	await setImmediate();
	assert.match(render(), /5h80%/);

	leafId = "turn-1";
	handlers.get("turn_end")?.({}, ctx);
	assert.equal(entryReads, 2);
	handlers.get("agent_end")?.({}, ctx);
	assert.equal(entryReads, 2);
	leafId = "late-entry";
	handlers.get("agent_end")?.({}, ctx);
	assert.equal(entryReads, 3);

	const quotaCalls = calls;
	model = { ...model, api: "pi-virtual", id: "auto" };
	handlers.get("model_select")?.({}, ctx);
	assert.doesNotMatch(render(), /5h80%/);
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
	handlers.get("turn_end")?.({}, ctx);
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

	handlers.get("agent_start")?.({}, ctx);
	assert.match(render(), /󰊠/);
	handlers.get("agent_end")?.({}, ctx);
	assert.match(render(), /󰊠/);
	handlers.get("agent_settled")?.({}, ctx);
	assert.doesNotMatch(render(), /󰊠/);
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
