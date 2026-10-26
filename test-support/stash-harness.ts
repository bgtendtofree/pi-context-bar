/** Draft-stash integration harness shared by the stash and status suites. */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import zContext from "../index.ts";

export type StashHarness = Readonly<{
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
export const stashHarness = (): StashHarness => {
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
