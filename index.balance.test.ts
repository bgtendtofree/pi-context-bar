import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import zContext from "./index.ts";

test("DeepSeek balance wires startup, selection, settlement, diagnostics, and shutdown without touching Codex", async (t) => {
	let mono = 0;
	t.mock.method(performance, "now", () => mono);
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>();
	let model = {
		provider: "deepseek",
		api: "openai-completions",
		id: "ds",
		baseUrl: "https://api.deepseek.com/v1",
		reasoning: false,
	};
	let key: string | undefined = "synthetic-key";
	const notices: string[] = [];
	let render = () => "";
	const tui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
	const ctx = {
		hasUI: true,
		mode: "tui",
		get model() {
			return model;
		},
		getContextUsage: () => ({ tokens: 20000, contextWindow: 100000 }),
		sessionManager: { getEntries: () => [], getLeafId: () => null, getBranch: () => [] },
		modelRegistry: {
			getApiKeyForProvider: async (provider: string) => {
				assert.equal(provider, "deepseek");
				return key;
			},
		},
		ui: {
			theme: {
				fg: (_token: string, text: string) => text,
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
	let calls = 0;
	t.mock.method(globalThis, "fetch", async (url: unknown) => {
		assert.equal(url, "https://api.deepseek.com/user/balance");
		calls++;
		return new Response(
			JSON.stringify({
				is_available: true,
				balance_infos: [
					{ currency: "CNY", total_balance: "20.50", granted_balance: "5.00", topped_up_balance: "15.50" },
				],
			}),
		);
	});
	zContext({
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler),
		registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) =>
			commands.set(name, command.handler),
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI);
	const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
	const status = async () => {
		await commands.get("context-bar")?.("status", ctx as ExtensionCommandContext);
		return notices.at(-1) ?? "";
	};
	emit("session_start");
	await setImmediate();
	assert.match(render(), /Bal ¥20\.50 \(gift ¥5\.00\)/);
	assert.match(await status(), /Balance: available · CNY 20\.50 \(gift 5\.00, topped up 15\.50\)/);
	assert.equal(calls, 1); // inspection is display-only
	emit("agent_settled", { aborted: false });
	await setImmediate();
	assert.equal(calls, 1);
	mono = 60000;
	emit("agent_settled", { aborted: false });
	await setImmediate();
	assert.equal(calls, 2);
	model = { ...model, baseUrl: "https://proxy.test" };
	emit("model_select");
	assert.doesNotMatch(render(), /Bal/);
	await setImmediate();
	assert.equal(calls, 2);
	model = { ...model, baseUrl: "https://api.deepseek.com" };
	key = undefined;
	emit("model_select");
	await setImmediate();
	assert.match(await status(), /no DeepSeek API key/);
	assert.doesNotMatch(render(), /Bal/);
	key = "synthetic-next-key";
	emit("model_select");
	await setImmediate();
	assert.match(render(), /Bal/);
	emit("session_shutdown", { reason: "quit" });
	assert.match(await status(), /Balance: unavailable/);
	assert.doesNotMatch(await status(), /synthetic/);
});
