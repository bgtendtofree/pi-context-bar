import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import zContext from "./index.ts";
import { ASCII_GLYPHS, GHOST_GLYPH, GHOST_TOKENS, NERD_GLYPHS } from "./lib/chrome.ts";
import { billedResponse, markerEntry, usageEntry } from "./test-support/fixtures.ts";

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
	let clock = 1_000;
	t.mock.method(performance, "now", () => clock);
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
	// No reading yet: waiting shows the honest unknown marker, never a fabricated first-chunk rate.
	const waiting = render();
	assert.ok(waiting.includes(`${NERD_GLYPHS.waiting} ?t/s`), waiting);
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
	// The first non-empty chunk cannot prove a rate yet; the reserved slot holds `?t/s` instead.
	const firstChunk = render();
	assert.ok(firstChunk.includes(`${NERD_GLYPHS.speed} ?t/s`), firstChunk);
	assert.doesNotMatch(firstChunk, /~?\d+\.\dt\/s/);
	assert.equal(firstChunk.indexOf("23.0%"), waiting.indexOf("23.0%"));
	assert.equal(firstChunk.lastIndexOf("t/s"), waiting.lastIndexOf("t/s"));
	clock += 600;
	// 110 tokens total: frame 36 is an open mouth, and the live window now measures a rate.
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
	assert.match(streamed, /~\d+\.\dt\/s/);
	// The number replaces `?t/s` in the same right-aligned slot; lane and percent keep their columns.
	assert.equal(streamed.indexOf("23.0%"), waiting.indexOf("23.0%"));
	assert.equal(streamed.lastIndexOf("t/s"), waiting.lastIndexOf("t/s"));

	handlers.get("tool_execution_start")?.({ type: "tool_execution_start" }, ctx);
	handlers.get("message_end")?.({ type: "message_end", message: { role: "user" } }, ctx);
	clock = 3_000;
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
	// 50 output tokens over 2 s active streaming settles the calibrated reading.
	assert.ok(idle.includes("25.0t/s"), idle);

	// The next turn starts unknown for the window but keeps the wait state's last measured reading.
	clock = 4_000;
	handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
	handlers.get("turn_start")?.({ type: "turn_start", turnIndex: 1, timestamp: 0 }, ctx);
	const nextWaiting = render();
	assert.ok(nextWaiting.includes(`${NERD_GLYPHS.waiting} 25.0t/s`), nextWaiting);
	assert.ok(!nextWaiting.includes("?t/s"), nextWaiting);
	clock = 4_600;
	handlers.get("message_start")?.(
		{ type: "message_start", message: { role: "assistant", provider: "openai", model: "gpt" } },
		ctx,
	);
	handlers.get("message_update")?.(
		{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "z".repeat(40) } },
		ctx,
	);
	// Until the window spans enough time the field holds the last reading as a live estimate.
	const held = render();
	assert.ok(held.includes("~25.0t/s"), held);
	clock = 5_200;
	handlers.get("message_update")?.(
		{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "w".repeat(400) } },
		ctx,
	);
	assert.match(render(), /~\d+\.\dt\/s/);
	handlers.get("message_end")?.({ type: "message_end", message: { role: "assistant", usage: { output: 50 } } }, ctx);
	handlers.get("turn_end")?.(
		{ type: "turn_end", turnIndex: 1, message: { role: "assistant", stopReason: "stop" }, messageEntryId: "entry-2" },
		ctx,
	);
	handlers.get("agent_settled")?.({ type: "agent_settled", aborted: false }, ctx);

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
