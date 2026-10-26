import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
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

test("status inspection keeps footer empty, reads live statuses, and retires disposed owners", async () => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>();
	const notices: string[] = [];
	const statuses = new Map([["review", "waiting"]]);
	const tui = { requestRender: () => {} } as unknown as TUI;
	type Footer = ReturnType<NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>>;
	let footer: Footer | undefined;
	const ctx = {
		mode: "tui",
		hasUI: true,
		model: undefined,
		getContextUsage: () => undefined,
		sessionManager: { getEntries: () => [], getLeafId: () => null, getBranch: () => [] },
		ui: {
			theme: {},
			notify: (text: string) => notices.push(text),
			setWorkingVisible: () => {},
			setHeader: () => {},
			setEditorComponent: () => {},
			setFooter: (factory: Parameters<ExtensionContext["ui"]["setFooter"]>[0]) => {
				footer?.dispose?.();
				footer = factory?.(tui, ctx.ui.theme, {
					getExtensionStatuses: () => statuses,
				} as unknown as Parameters<NonNullable<typeof factory>>[2]);
			},
		},
	} as unknown as ExtensionContext;
	zContext({
		registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) =>
			commands.set(name, command.handler),
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI);
	handlers.get("session_start")?.({}, ctx);
	const inspect = async () => {
		await commands.get("context-bar")?.("status", ctx as ExtensionCommandContext);
		return notices.at(-1) ?? "";
	};
	assert.deepEqual(footer?.render(80), []);
	assert.match(await inspect(), /review: waiting/);
	statuses.set("review", "passed");
	assert.match(await inspect(), /review: passed/);
	const retired = footer;
	handlers.get("session_start")?.({}, ctx);
	retired?.dispose?.();
	assert.match(await inspect(), /review: passed/);
	footer?.dispose?.();
	assert.match(await inspect(), /no longer owns the footer/);
	handlers.get("session_shutdown")?.({}, ctx);
	assert.match(await inspect(), /no longer owns the footer/);
});

test("passive quota is request-scoped, replaces windows, expires, and supersedes delayed official queries", async (t) => {
	let clock = 1_800_000_000_000;
	t.mock.method(Date, "now", () => clock);
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>();
	const notices: string[] = [];
	let mode = "tui";
	let model = {
		provider: "openai-codex",
		api: "openai-codex-responses",
		id: "proxy-model",
		baseUrl: "https://proxy.test",
	};
	let credentialReads = 0;
	let fetches = 0;
	let resolveQuery: ((value: Response) => void) | undefined;
	t.mock.method(globalThis, "fetch", async () => {
		fetches++;
		if (fetches === 1)
			return new Promise<Response>((resolve) => {
				resolveQuery = resolve;
			});
		return new Response(JSON.stringify({ primary_window: { used_percent: 12, limit_window_seconds: 18000 } }));
	});
	let render = () => "";
	const tui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
	const ctx = {
		get mode() {
			return mode;
		},
		hasUI: true,
		get model() {
			return model;
		},
		getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000 }),
		sessionManager: { getEntries: () => [], getLeafId: () => null, getBranch: () => [] },
		modelRegistry: {
			find: () => model,
			isUsingOAuth: () => false,
			getProvider: () => undefined,
			getApiKeyForProvider: async () => {
				credentialReads++;
				return token("a");
			},
		},
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
				style: (text: string) => text,
			},
			notify: (text: string) => notices.push(text),
			setWorkingVisible: () => {},
			setHeader: () => {},
			setFooter: () => {},
			setEditorComponent: (factory: Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]) => {
				if (!factory) return;
				const editor = factory(
					tui,
					{ borderColor: (text: string) => text } as EditorTheme,
					{} as Parameters<NonNullable<typeof factory>>[2],
				);
				render = () => stripVTControlCharacters(editor.render(120).join("\n"));
			},
		},
	} as unknown as ExtensionContext;
	zContext({
		registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) =>
			commands.set(name, command.handler),
		getThinkingLevel: () => "off",
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
	} as unknown as ExtensionAPI);
	const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
	const inspect = async () => {
		await commands.get("context-bar")?.("status", ctx as ExtensionCommandContext);
		return notices.at(-1) ?? "";
	};
	const headers = {
		"x-codex-primary-used-percent": "75",
		"x-codex-primary-reset-at": `${clock / 1000 + 60}`,
		"x-codex-primary-window-minutes": "300",
	};
	const response = { status: 200, headers };
	const stream = {
		provider: model.provider,
		api: model.api,
		model: model.id,
		data: {
			type: "codex.rate_limits",
			rate_limits: { secondary: { used_percent: 20, reset_at: clock / 1000 + 60, window_minutes: 10080 } },
		},
	};
	const end = () => emit("turn_end", { message: { role: "assistant", stopReason: "stop" } });
	emit("session_start");
	await setImmediate();
	emit("after_provider_response", response);
	assert.doesNotMatch(render(), /5h 75%/);
	emit("before_provider_request");
	emit("after_provider_response", { ...response, status: 403 });
	emit("after_provider_response", { status: 200, headers: {} });
	assert.doesNotMatch(render(), /5h 75%/);
	emit("after_provider_response", response);
	assert.match(render(), /5h 75%/);
	assert.match(await inspect(), /Quota source: response headers/);
	for (const mismatch of [{ provider: "other" }, { api: "other" }, { model: "other" }]) {
		emit("provider_stream_event", { ...stream, ...mismatch });
		assert.match(render(), /5h 75%/);
	}
	emit("provider_stream_event", { ...stream, data: { type: "response.created" } });
	assert.match(render(), /5h 75%/);
	emit("provider_stream_event", stream);
	assert.match(render(), /7d 20%/);
	assert.doesNotMatch(render(), /5h 75%/);
	assert.match(await inspect(), /Quota source: stream event/);
	end();
	await setImmediate();
	assert.equal(fetches, 0);
	assert.equal(credentialReads, 0);
	emit("after_provider_response", response);
	assert.doesNotMatch(render(), /5h 75%/);
	clock += 60_000;
	assert.doesNotMatch(render(), /7d 20%/);
	assert.match(await inspect(), /expired response quota/);

	emit("before_provider_request");
	emit("provider_stream_event", { ...stream, data: { type: "codex.rate_limits" } });
	assert.match(await inspect(), /response reported no usable/);
	model = { ...model, baseUrl: "https://other-proxy.test" };
	emit("after_provider_response", response);
	assert.doesNotMatch(render(), /5h 75%/);
	emit("model_select");
	assert.match(await inspect(), /no official queries for custom endpoints/);

	// New OpenAI and custom Responses providers can report quota without legacy credential lookups.
	model = { ...model, provider: "openai", api: "openai-responses" };
	emit("model_select");
	emit("before_provider_request");
	headers["x-codex-primary-reset-at"] = `${clock / 1000 + 60}`;
	emit("after_provider_response", response);
	assert.match(render(), /5h 75%/);
	end();
	assert.equal(credentialReads, 0);
	model = { ...model, baseUrl: "https://changed-without-selection.test" };
	assert.doesNotMatch(render(), /5h 75%/);
	assert.match(await inspect(), /model or endpoint changed/);
	emit("before_provider_request");
	assert.doesNotMatch(render(), /5h 75%/);
	emit("after_provider_response", response);
	emit("model_select");
	assert.doesNotMatch(render(), /5h 75%/);

	// Metadata landing during an official fallback must win over its delayed HTTP reply.
	model = {
		...model,
		provider: "openai-codex",
		api: "openai-codex-responses",
		baseUrl: "https://chatgpt.com/backend-api",
	};
	emit("model_select");
	await setImmediate();
	assert.equal(fetches, 1);
	emit("before_provider_request");
	emit("after_provider_response", response);
	resolveQuery?.(new Response(JSON.stringify({ primary_window: { used_percent: 99 } })));
	await setImmediate();
	assert.match(render(), /5h 75%/);
	assert.doesNotMatch(render(), /99%/);
	end();
	assert.equal(fetches, 1);
	emit("before_provider_request");
	end();
	await setImmediate();
	assert.equal(fetches, 2);
	assert.match(await inspect(), /Quota source: official query/);

	mode = "rpc";
	emit("model_select");
	emit("before_provider_request");
	emit("after_provider_response", response);
	emit("provider_stream_event", stream);
	assert.equal(fetches, 2);
	emit("session_shutdown");
	assert.match(await inspect(), /Quota source: none/);
});

test("a request started before a model switch cannot attach its quota to the new selection", async () => {
	type RaceModel = {
		provider: string;
		api: string;
		id: string;
		contextWindow: number;
		baseUrl: string;
	};
	const physicalA: RaceModel = {
		provider: "openai",
		api: "openai-responses",
		id: "model-a",
		contextWindow: 100_000,
		baseUrl: "https://a.example.com/v1",
	};
	const quotaHeaders = (percent: number): Record<string, string> => ({
		"x-codex-primary-used-percent": `${percent}`,
		"x-codex-primary-reset-at": `${Math.floor(Date.now() / 1000) + 3600}`,
		"x-codex-primary-window-minutes": "300",
	});
	const scenarios: ReadonlyArray<{
		name: string;
		initial: RaceModel;
		payloadModel: string;
		switchTo: Partial<RaceModel>;
		stalePercent: number;
	}> = [
		{
			name: "another model",
			initial: physicalA,
			payloadModel: "model-a",
			switchTo: { id: "model-b" },
			stalePercent: 55,
		},
		{
			name: "the same model id on another endpoint",
			initial: physicalA,
			payloadModel: "model-a",
			switchTo: { baseUrl: "https://b.example.com/v1" },
			stalePercent: 55,
		},
		{
			name: "the same model id on another provider",
			initial: physicalA,
			payloadModel: "model-a",
			switchTo: { provider: "proxy-b" },
			stalePercent: 55,
		},
		{
			name: "a virtual turn routed to the new physical selection",
			initial: {
				provider: "router",
				api: "pi-virtual",
				id: "auto",
				contextWindow: 100_000,
				baseUrl: "https://router.invalid",
			},
			payloadModel: "gpt",
			switchTo: {
				provider: "proxy-b",
				api: "openai-responses",
				id: "gpt",
				baseUrl: "https://b.invalid",
			},
			stalePercent: 88,
		},
	];
	for (const { name, initial, payloadModel, switchTo, stalePercent } of scenarios) {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const notices: string[] = [];
		let command: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"] | undefined;
		let model: RaceModel = { ...initial };
		let render = (): string => "";
		const tui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
		const ctx = {
			hasUI: true,
			mode: "tui",
			get model() {
				return model;
			},
			getContextUsage: () => ({ tokens: 1_000, contextWindow: model.contextWindow }),
			sessionManager: { getEntries: () => [], getLeafId: () => null, getBranch: () => [] },
			modelRegistry: {
				find: (_provider: string, id: string) => ({ ...model, id }),
				isUsingOAuth: () => false,
				getProvider: () => undefined,
				getApiKeyForProvider: async () => undefined,
			},
			ui: {
				notify: (message: string) => notices.push(message),
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
						const editor = factory(
							tui,
							{ borderColor: (text: string) => text } as EditorTheme,
							{} as Parameters<NonNullable<typeof factory>>[2],
						);
						render = () => stripVTControlCharacters(editor.render(120).join("\n"));
					}
				},
			},
		} as unknown as ExtensionContext;
		zContext({
			registerCommand: (name: string, registration: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
				if (name === "context-bar") command = registration.handler;
			},
			getThinkingLevel: () => "off",
			getSettings: () => ({ quietStartup: true }),
			on: (eventName: string, handler: (event: unknown, ctx: ExtensionContext) => void) =>
				handlers.set(eventName, handler),
		} as unknown as ExtensionAPI);
		const emit = (eventName: string, event: unknown = {}) => handlers.get(eventName)?.(event, ctx);
		const inspect = async (): Promise<string> => {
			await command?.("status", ctx as ExtensionCommandContext);
			return notices.at(-1) ?? "";
		};
		emit("session_start");
		// The turn starts under the initial selection; auth is still pending when the user selects the next one.
		emit("turn_start");
		model = { ...model, ...switchTo };
		emit("model_select");
		// The captured request's before_provider_request lands after the switch, then its response carries quota.
		emit("before_provider_request", { payload: { model: payloadModel } });
		emit("after_provider_response", { status: 200, headers: quotaHeaders(stalePercent) });
		assert.doesNotMatch(render(), new RegExp(`5h ${stalePercent}%`), name);
		assert.doesNotMatch(await inspect(), new RegExp(`5h ${stalePercent}%`), name);

		// A normal request under the new selection still claims its own response quota.
		emit("turn_start");
		emit("before_provider_request", { payload: { model: model.id } });
		emit("after_provider_response", { status: 200, headers: quotaHeaders(33) });
		assert.match(render(), /5h 33%/, name);
		assert.match(await inspect(), /5h 33%/, name);
		assert.doesNotMatch(render(), new RegExp(`5h ${stalePercent}%`), name);
		emit("session_shutdown");
	}
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

/** Same ancestor branch Pi returns from ReadonlySessionManager.getBranch(). */
const branchTo = (entries: readonly SessionEntry[], target: string): SessionEntry[] => {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	for (let current: string | null = target; current; ) {
		const entry = byId.get(current);
		if (!entry) break;
		branch.unshift(entry);
		current = entry.parentId;
	}
	return branch;
};

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
		modelRegistry: { find: () => undefined, getApiKeyForProvider: async () => undefined },
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
		message: "Usage: /context-bar status | stash | ascii-fallback [on|off|toggle]",
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
		modelRegistry: { find: () => undefined, getApiKeyForProvider: async () => undefined },
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
	handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);
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
	assert.deepEqual(notices, [
		"Official Codex quota queries are off for this endpoint; waiting for provider response metadata",
	]);
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
			modelRegistry: { find: () => undefined, getApiKeyForProvider: async () => undefined },
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
		modelRegistry: { find: () => undefined, getApiKeyForProvider: async () => undefined },
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
		modelRegistry: { find: () => undefined, getApiKeyForProvider: async () => undefined },
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
		modelRegistry: { find: () => undefined, getApiKeyForProvider: async () => undefined },
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
	assert.deepEqual(notices, [
		"Official Codex quota queries are off for this endpoint; waiting for provider response metadata",
	]);

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

type StashHarness = Readonly<{
	handlers: Map<string, (event: unknown, ctx: ExtensionContext) => unknown>;
	commands: Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>;
	notices: { message: string; level: string | undefined }[];
	ctx: ExtensionContext;
	setEditorText: (text: string) => void;
	editorText: () => string;
	appendCount: () => number;
	setEntries: (entries: SessionEntry[], leafId: string | null) => void;
	setBranch: (branch: SessionEntry[]) => void;
	setLeaf: (leafId: string | null) => void;
	setUsedTokens: (tokens: number) => void;
	setProjectionMessages: (messages: readonly unknown[]) => void;
	emitContextWithSystem: (messages: readonly { role: string }[]) => void;
	stash: () => void;
	failNextEditorSet: () => void;
	status: () => Promise<string>;
}>;

/** Minimal live-session harness for stash/timing/diagnostics wiring; no renderer is exercised here. */
const stashHarness = (): StashHarness => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>();
	const notices: { message: string; level: string | undefined }[] = [];
	let editor: ReturnType<NonNullable<Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]>> | undefined;
	let editorText = "";
	let failSet = false;
	let entries: SessionEntry[] = [];
	let branch: SessionEntry[] = [];
	let leafId: string | null = null;
	let usedTokens = 0;
	let messages: readonly unknown[] = [];
	let appendEntries = 0;
	const model = { provider: "test", api: "test", id: "test-model", contextWindow: 100_000 };
	const ctx = {
		hasUI: true,
		mode: "tui",
		model,
		getSystemPrompt: () => "SYS",
		getContextUsage: () => ({ tokens: usedTokens, contextWindow: model.contextWindow }),
		sessionManager: {
			getEntries: () => entries,
			getLeafId: () => leafId,
			getBranch: () => branch,
			buildSessionProjection: () => ({ messages, thinkingLevel: "off", model: null, entries: [] }),
		},
		modelRegistry: { find: () => undefined, getApiKeyForProvider: async () => undefined },
		ui: {
			notify: (message: string, level?: string) => notices.push({ message, level }),
			theme: {
				fg: (_token: string, text: string) => text,
				bold: (text: string) => text,
				style: (text: string) => text,
			},
			setWorkingVisible: () => {},
			setHeader: () => {},
			setFooter: () => {},
			setEditorComponent: (factory: Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]) => {
				if (!factory) return;
				const tui = { requestRender: () => {}, terminal: { rows: 20 } } as unknown as TUI;
				const theme = { borderColor: (text: string) => text } as EditorTheme;
				const keybindings = {
					getEffectiveConfig: () => ({}),
					matches: () => false,
				} as unknown as Parameters<NonNullable<typeof factory>>[2];
				editor = factory(tui, theme, keybindings);
			},
			getEditorText: () => editorText,
			setEditorText: (text: string) => {
				if (failSet) {
					failSet = false;
					throw new Error("editor setter failed");
				}
				editorText = text;
			},
		},
	} as unknown as ExtensionContext;
	const pi = {
		registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) =>
			commands.set(name, command.handler),
		getThinkingLevel: () => "off",
		getActiveTools: () => ["read", "bash"],
		getAllTools: () => [
			{ name: "read", description: "Read a file", parameters: { type: "object" } },
			{ name: "bash", description: "", parameters: { type: "object" } },
		],
		appendEntry: () => {
			appendEntries++;
		},
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	zContext(pi);
	handlers.get("session_start")?.({ reason: "startup" }, ctx);
	return {
		handlers,
		commands,
		notices,
		ctx,
		setEditorText: (text) => {
			editorText = text;
		},
		editorText: () => editorText,
		appendCount: () => appendEntries,
		setEntries: (next, leaf) => {
			entries = next;
			branch = next;
			leafId = leaf;
		},
		setBranch: (next) => {
			branch = next;
		},
		setLeaf: (leaf) => {
			leafId = leaf;
		},
		setUsedTokens: (tokens) => {
			usedTokens = tokens;
		},
		setProjectionMessages: (next) => {
			messages = next;
		},
		emitContextWithSystem: (next) => {
			handlers.get("context_with_system")?.({ type: "context_with_system", messages: next }, ctx);
		},
		stash: () => editor?.handleInput("\x1bs"),
		failNextEditorSet: () => {
			failSet = true;
		},
		status: async () => {
			await commands.get("context-bar")?.("status", ctx as ExtensionCommandContext);
			return notices.at(-1)?.message ?? "";
		},
	};
};

test("Alt+S stashes without sending anything, and the command only restores", async () => {
	const h = stashHarness();
	const command = h.commands.get("context-bar");
	assert.ok(command);
	assert.equal(h.appendCount(), 0);

	await command("stash", h.ctx as ExtensionCommandContext);
	assert.match(h.notices.at(-1)?.message ?? "", /No stashed draft/);

	h.setEditorText("  draft 中文\nsecond line  ");
	h.stash();
	assert.equal(h.editorText(), "");
	assert.match(h.notices.at(-1)?.message ?? "", /Draft stashed/);
	assert.match(await h.status(), /Stash: 1 draft held in memory/);
	assert.equal(h.appendCount(), 0);

	// The command runs after Pi already cleared the submitted line, so it restores.
	await command("stash", h.ctx as ExtensionCommandContext);
	assert.equal(h.editorText(), "  draft 中文\nsecond line  ");
	assert.match(h.notices.at(-1)?.message ?? "", /restored/);
	assert.match(await h.status(), /Stash: none/);

	// Both sides hold text: refuse and leave both untouched.
	h.setEditorText("first");
	h.stash();
	h.setEditorText("second");
	h.stash();
	assert.equal(h.editorText(), "second");
	assert.match(h.notices.at(-1)?.message ?? "", /nothing was overwritten/);
	await command("stash", h.ctx as ExtensionCommandContext);
	assert.equal(h.editorText(), "second");
	assert.match(h.notices.at(-1)?.message ?? "", /not overwriting/);

	// Emptying the editor lets the restore happen; nothing was lost.
	h.setEditorText("");
	await command("stash", h.ctx as ExtensionCommandContext);
	assert.equal(h.editorText(), "first");
	assert.equal(h.appendCount(), 0);
	h.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, h.ctx);
});

test("a failed editor restore keeps the stash for a retry", async () => {
	const h = stashHarness();
	h.setEditorText("retry me");
	h.stash();
	assert.equal(h.editorText(), "");
	assert.match(await h.status(), /Stash: 1 draft held in memory/);

	h.failNextEditorSet();
	h.stash();
	assert.equal(h.editorText(), "");
	assert.match(h.notices.at(-1)?.message ?? "", /still held and can be retried/);
	assert.match(await h.status(), /Stash: 1 draft held in memory/);

	// Clearing the stash happens only after the editor accepted the text.
	h.stash();
	assert.equal(h.editorText(), "retry me");
	assert.match(await h.status(), /Stash: none/);
	h.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, h.ctx);
});

test("a held stash blocks session replacement until it is restored", async () => {
	const h = stashHarness();
	h.setEditorText("held draft");
	h.stash();
	assert.equal(h.editorText(), "");
	assert.equal(h.appendCount(), 0);

	for (const [name, event] of [
		["session_before_switch", { type: "session_before_switch", reason: "new" }],
		["session_before_switch", { type: "session_before_switch", reason: "resume", targetSessionFile: "x" }],
		["session_before_fork", { type: "session_before_fork", entryId: "e", position: "at" }],
		["session_before_tree", { type: "session_before_tree" }],
	] as const) {
		assert.deepEqual(h.handlers.get(name)?.(event, h.ctx), { cancel: true }, name);
		assert.match(h.notices.at(-1)?.message ?? "", /cancelled/);
	}
	assert.equal(h.appendCount(), 0);

	// Restore through the command, then the same transitions are free again.
	await h.commands.get("context-bar")?.("stash", h.ctx as ExtensionCommandContext);
	assert.equal(h.editorText(), "held draft");
	assert.equal(
		h.handlers.get("session_before_switch")?.({ type: "session_before_switch", reason: "new" }, h.ctx),
		undefined,
	);
	h.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, h.ctx);
});

test("shutdown restores a stash into an empty editor and reports the non-empty boundary", async () => {
	const h = stashHarness();
	h.setEditorText("recoverable");
	h.stash();
	h.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" }, h.ctx);
	// Reload keeps editor text; the free editor received the draft before the runtime reset.
	assert.equal(h.editorText(), "recoverable");
	assert.match(await h.status(), /Stash: none/);

	// A non-empty editor cannot take the draft without overwriting it; the SDK has no cancellable
	// shutdown, so this is the documented loss boundary rather than a silent state-only clear.
	h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
	h.setEditorText("held again");
	h.stash();
	h.setEditorText("typed over");
	h.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, h.ctx);
	assert.equal(h.editorText(), "typed over");
	assert.match(h.notices.at(-1)?.message ?? "", /Stash lost during quit shutdown/);
	h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
	await h.commands.get("context-bar")?.("stash", h.ctx as ExtensionCommandContext);
	assert.match(h.notices.at(-1)?.message ?? "", /No stashed draft/);
	h.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, h.ctx);
});

test("status observes TTFT, run time, request traffic, context change, and effective buckets", async (t) => {
	let clock = 100;
	t.mock.method(performance, "now", () => clock);
	const h = stashHarness();
	const assistantEntry: SessionEntry = {
		type: "message",
		id: "a1",
		parentId: null,
		timestamp: "",
		message: {
			role: "assistant",
			content: [],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 500,
				output: 40,
				cacheRead: 900,
				cacheWrite: 20,
				totalTokens: 1460,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		},
	};
	// No assistant response yet: usage and TTFT are unavailable, not zero.
	assert.match(await h.status(), /Request usage: unavailable \(latest response has no usable usage report\)/);
	assert.match(await h.status(), /Timing TTFT: unavailable/);

	h.setEntries([assistantEntry], "a1");
	h.setUsedTokens(1000);
	const esc = String.fromCharCode(27);
	// The projection still contains a huge toolResult; the observed hook is the only source.
	h.setProjectionMessages([{ role: "toolResult", toolName: "projection-only", content: "G".repeat(50_000) }]);
	const systemMessage = {
		role: "system",
		content: "BASE",
		sections: { extra: "SECTION" },
		toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
		timestamp: 1,
	};
	const observed = [
		systemMessage,
		{ role: "user", content: [{ type: "text", text: "hello" }] },
		{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "0123456789" }] },
		{ role: "toolResult", toolName: `${esc}[31mevil`, content: "xx" },
		{ role: "compactionSummary", summary: "sum" },
	];

	h.handlers.get("agent_start")?.({ type: "agent_start" }, h.ctx);
	clock = 200;
	h.handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 0, timestamp: 0 }, h.ctx);
	clock = 300;
	h.handlers.get("before_provider_request")?.({ type: "before_provider_request", payload: {} }, h.ctx);
	clock = 350;
	h.emitContextWithSystem(observed);
	clock = 400;
	h.handlers.get("message_update")?.(
		{
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "" },
		},
		h.ctx,
	);
	const pending = await h.status();
	assert.match(pending, /Waiting: yes, no non-empty output yet/);
	assert.match(pending, /Timing TTFT: unavailable/);
	assert.match(pending, /last observed at context_with_system/);

	clock = 550;
	h.handlers.get("message_update")?.(
		{
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "0123456789" },
		},
		h.ctx,
	);
	h.handlers.get("message_end")?.(
		{ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { output: 40 } } },
		h.ctx,
	);
	h.handlers.get("turn_end")?.(
		{
			type: "turn_end",
			turnIndex: 0,
			message: { role: "assistant", stopReason: "stop" },
			messageEntryId: "a1",
			toolResults: [],
			toolResultEntryIds: [],
		},
		h.ctx,
	);
	h.setUsedTokens(2500);
	h.handlers.get("agent_end")?.({ type: "agent_end" }, h.ctx);
	clock = 1600;
	h.handlers.get("agent_settled")?.({ type: "agent_settled", aborted: false }, h.ctx);

	const output = await h.status();
	assert.match(output, /Timing TTFT: 250 ms/);
	assert.match(output, /Timing run: 1\.50 s · 1 turns/);
	assert.match(output, /Waiting: no/);
	assert.match(output, /Context change: \+1500 tokens \(1000 → 2500/);
	assert.match(
		output,
		/Request usage: input 500 \(uncached\) · cache read 900 · cache write 20 · output 40 · total 1460/,
	);
	assert.match(output, /stop reason stop/);
	const responseTools = getCurrentTools(observed);
	assert.equal(responseTools.length, 1);
	const toolChars =
		(responseTools[0]?.name.length ?? 0) +
		(responseTools[0]?.description.length ?? 0) +
		JSON.stringify(responseTools[0]?.parameters).length;
	assert.match(output, new RegExp(`System: ${getCurrentSystemPrompt(observed).length} chars`));
	assert.match(output, new RegExp(`Tools: ${toolChars} chars`));
	assert.match(output, /Messages: 5 · Tool results: 12 · Summary: 3 · Other: 0 chars/);
	assert.match(output, /Largest tool results: bash 10 chars · evil 2 chars/);
	// The hidden/projection tool result is neither counted nor named.
	assert.doesNotMatch(output, /projection-only/);
	assert.doesNotMatch(output, /G{10}/);
	assert.ok(!output.includes(esc));
	assert.match(output, /Stash: none/);

	h.handlers.get("model_select")?.({ type: "model_select" }, h.ctx);
	const afterModel = await h.status();
	assert.match(afterModel, /Context change: unavailable \(model changed\)/);
	assert.match(afterModel, /Effective context: unavailable \(model changed; waiting for the next observation\)/);
	// The last measured TTFT is still labelled as last; the switch does not present it as current.
	assert.match(afterModel, /Timing TTFT: 250 ms/);
	assert.match(afterModel, /Waiting: no/);

	// A run that spans compaction has no comparable before/after reading, and the summary is
	// unknown until the next observation.
	clock = 1700;
	h.handlers.get("agent_start")?.({ type: "agent_start" }, h.ctx);
	// A fresh run never presents the previous settled delta as this run's.
	const runB = await h.status();
	assert.match(runB, /Context change: pending \(run in progress; settles at agent end\)/);
	assert.doesNotMatch(runB, /\+1500 tokens/);
	h.setUsedTokens(3000);
	h.handlers.get("session_compact")?.(
		{
			type: "session_compact",
			compactionEntry: { id: "c" },
			fromExtension: false,
			reason: "manual",
			willRetry: false,
		},
		h.ctx,
	);
	clock = 2000;
	h.handlers.get("agent_settled")?.({ type: "agent_settled", aborted: false }, h.ctx);
	const afterCompact = await h.status();
	assert.match(afterCompact, /Context change: unavailable \(compaction changed the context during the run\)/);
	assert.match(afterCompact, /Effective context: unavailable \(compaction changed the context/);

	// Request usage follows the active branch: an assistant response from another branch must not
	// be read after the tree switches.
	const otherBranchEntry: SessionEntry = {
		type: "message",
		id: "b1",
		parentId: null,
		timestamp: "",
		message: {
			...assistantEntry.message,
			usage: {
				input: 7000,
				output: 70,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 7070,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	} as SessionEntry;
	h.setEntries([assistantEntry, otherBranchEntry], "a1");
	h.setBranch([assistantEntry]);
	assert.match(await h.status(), /Request usage: input 500 /);
	h.setBranch([otherBranchEntry]);
	h.setLeaf("b1");
	h.handlers.get("session_tree")?.({ type: "session_tree", newLeafId: "b1", oldLeafId: "a1" }, h.ctx);
	const afterTree = await h.status();
	assert.match(afterTree, /Context change: unavailable \(branch changed\)/);
	assert.match(afterTree, /Effective context: unavailable \(branch changed/);
	assert.match(afterTree, /Request usage: input 7000 /);
	assert.doesNotMatch(afterTree, /input 500 /);

	h.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, h.ctx);
});
