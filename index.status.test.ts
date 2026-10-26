import assert from "node:assert/strict";
import { test } from "node:test";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import zContext from "./index.ts";
import { stashHarness } from "./test-support/stash-harness.ts";

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
