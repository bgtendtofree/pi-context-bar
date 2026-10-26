import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
import type { AssistantMessage } from "./lib/context.ts";
import { token } from "./test-support/fixtures.ts";

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
