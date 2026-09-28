import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import zContext from "./index.ts";

const token = (accountId: string): string =>
	`x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64")}.y`;

test("quota belongs to active account and model switches update context immediately", async (t) => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const pi = {
		registerCommand: () => {},
		getThinkingLevel: () => "off",
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
			handlers.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	let accountKey = token("A");
	let leafId: string | null = null;
	let entryReads = 0;
	let model = {
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
		},
		modelRegistry: { getApiKeyForProvider: async () => accountKey },
		ui: {
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
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
	handlers.get("session_shutdown")?.({}, ctx);
});
