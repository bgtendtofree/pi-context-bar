import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	boundedToolName,
	buildEffectiveContext,
	type ContextMessage,
	compareContext,
	formatCount,
	formatExactCount,
	latestRequestUsage,
	MAX_JSON_DEPTH,
	MAX_JSON_NODES,
	MAX_SCAN_BLOCKS,
	MAX_SCAN_CHARS,
	MAX_SCAN_MESSAGES,
	MAX_TOOL_NAME_CHARS,
	toolDeclaration,
	toolDeclarations,
} from "./context-audit.ts";

const usage = (
	stopReason: "stop" | "error" | "aborted" = "stop",
): Extract<SessionEntry, { type: "message" }>["message"] => ({
	role: "assistant",
	content: [],
	api: "test",
	provider: "test",
	model: "test",
	usage: {
		input: 100,
		output: 40,
		cacheRead: 900,
		cacheWrite: 20,
		reasoning: 7,
		totalTokens: 1060,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason,
	timestamp: 1,
});

const assistantEntry = (id: string, stopReason: "stop" | "error" | "aborted" = "stop"): SessionEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "",
	message: usage(stopReason),
});

const text = (body: string): readonly ContextMessage[] => [{ role: "user", content: [{ type: "text", text: body }] }];

test("latest request usage is the last assistant response, raw and including errors", () => {
	const entries = [assistantEntry("a"), assistantEntry("b", "error")];
	assert.deepEqual(latestRequestUsage(entries), {
		input: 100,
		cacheRead: 900,
		cacheWrite: 20,
		output: 40,
		total: 1060,
		reasoning: 7,
		stopReason: "error",
	});
	assert.equal(latestRequestUsage([]), undefined);
	assert.equal(
		latestRequestUsage([
			{
				type: "message",
				id: "u",
				parentId: null,
				timestamp: "",
				message: { role: "user", content: "hi", timestamp: 0 },
			},
		]),
		undefined,
	);
});

test("all-zero, partial, and non-finite usage stay unavailable instead of reporting zero", () => {
	type UsageLike = {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	};
	const assistant = (usage: UsageLike, stopReason: "stop" | "error"): SessionEntry => ({
		type: "message",
		id: "usage",
		parentId: null,
		timestamp: "",
		message: {
			role: "assistant",
			content: [],
			api: "test",
			provider: "test",
			model: "test",
			usage,
			stopReason,
			timestamp: 0,
		},
	});
	const zeroUsage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	assert.equal(latestRequestUsage([assistant(zeroUsage, "error")]), undefined);
	// Pi's zero placeholder is not a provider report even on a clean stop.
	assert.equal(latestRequestUsage([assistant(zeroUsage, "stop")]), undefined);
	const broken = (patch: Record<string, unknown>): SessionEntry =>
		assistant({ ...zeroUsage, input: 10, output: 2, totalTokens: 12, ...patch } as UsageLike, "stop");
	for (const patch of [
		{ input: Number.NaN },
		{ cacheRead: Number.POSITIVE_INFINITY },
		{ output: -1 },
		{ totalTokens: undefined },
	]) {
		assert.equal(latestRequestUsage([broken(patch)]), undefined, JSON.stringify(patch));
	}
});

describe("tool declarations and labels", () => {
	test("count name, description, and serialized schema; an unobservable schema is marked unknown", () => {
		const declaration = toolDeclaration({ name: "read", description: "Read", parameters: { type: "object" } });
		assert.equal(declaration.name, "read");
		assert.equal(declaration.textChars, 4 + 4 + JSON.stringify({ type: "object" }).length);
		assert.equal(declaration.schemaKnown, true);
		const broken = toolDeclaration({ name: "bad", description: "", parameters: { size: 1n } });
		assert.equal(broken.schemaKnown, false);
		assert.equal(broken.textChars, 3);
	});

	test("non-plain objects and toJSON values stay unknown instead of being mis-counted", () => {
		const date = toolDeclaration({
			name: "date",
			description: "",
			parameters: { type: "string", default: new Date("2020-01-01T00:00:00Z") },
		});
		assert.equal(date.schemaKnown, false);
		assert.equal(date.textChars, 4);

		const withToJSON = toolDeclaration({
			name: "json",
			description: "",
			parameters: { type: "string", default: { toJSON: () => "not executed" } },
		});
		assert.equal(withToJSON.schemaKnown, false);

		class Box {
			readonly value = 1;
		}
		assert.equal(toolDeclaration({ name: "box", parameters: { default: new Box() } }).schemaKnown, false);
	});

	test("tool schema lists share node and character budgets without repeating a spent walk", () => {
		const small = [
			{ name: "read", description: "Read", parameters: { type: "object" } },
			{ name: "bash", description: "", parameters: { type: "object", properties: { command: { type: "string" } } } },
		];
		assert.deepEqual(toolDeclarations(small), small.map(toolDeclaration));

		const wide = { values: Array.from({ length: 60_000 }, (_, index) => index) };
		let touched = 0;
		const forbidden = new Proxy(
			{},
			{
				get: () => {
					touched++;
					return undefined;
				},
				has: () => {
					touched++;
					return false;
				},
				ownKeys: () => {
					touched++;
					return [];
				},
				getPrototypeOf: () => {
					touched++;
					return Object.prototype;
				},
			},
		);
		const declarations = toolDeclarations([
			{ name: "first", parameters: wide },
			{ name: "second", parameters: wide },
			{ name: "third", parameters: forbidden },
		]);
		assert.equal(declarations[0]?.schemaKnown, true);
		assert.equal(declarations[1]?.schemaKnown, false);
		assert.equal(declarations[2]?.schemaKnown, false);
		assert.equal(touched, 0);

		const giant = "x".repeat(MAX_SCAN_CHARS - 2);
		const exhausted = toolDeclarations([
			{ name: "giant", parameters: giant },
			{ name: "after", parameters: { type: "object" } },
		]);
		assert.equal(exhausted[0]?.schemaKnown, true);
		assert.equal(exhausted[1]?.schemaKnown, false);
	});

	test("tool names lose controls, stay bounded, and never become empty", () => {
		const esc = String.fromCharCode(27);
		const name = boundedToolName(`${esc}[31mevil${"\u0007"}\u202E${"x".repeat(1_000_000)}`);
		assert.equal([...name].length, MAX_TOOL_NAME_CHARS);
		assert.doesNotMatch(name, /[\p{Cc}\p{Cf}]/u);
		assert.equal(boundedToolName(`${esc}[31mevil`), "evil");
		assert.equal(boundedToolName(""), "unknown");
		assert.equal(boundedToolName(undefined), "unknown");
		assert.equal(boundedToolName("bash"), "bash");
	});
});

describe("effective context", () => {
	test("buckets effective messages by role without normalizing to Pi's token reading", () => {
		const messages: ContextMessage[] = [
			...text("hello"),
			{
				role: "assistant",
				content: [
					{ type: "text", text: "answer" },
					{ type: "thinking", thinking: "hmm" },
					{ type: "toolCall", arguments: { path: "x" } },
				],
			},
			{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "output" }] },
			{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "longer output" }] },
			{ role: "compactionSummary", summary: "sum" },
			{ role: "branchSummary", summary: "br" },
			{ role: "custom", content: [{ type: "text", text: "custom" }] },
			{ role: "bashExecution", command: "ls", output: "ok" },
			{ role: "bashExecution", command: "secret", output: "hidden", excludeFromContext: true },
			{ role: "system", content: [{ type: "text", text: "sysmsg" }] },
			{ role: "user", content: [{ type: "image", data: "xxxx" }] },
		];
		const summary = buildEffectiveContext({
			messages,
			systemPrompt: "SYS",
			tools: [
				{ name: "bash", textChars: 10, schemaKnown: true },
				{ name: "mystery", textChars: 7, schemaKnown: false },
			],
			now: 42,
		});
		assert.equal(summary.systemChars, 3);
		assert.equal(summary.toolsChars, 17);
		assert.equal(summary.unknownToolSchemas, 1);
		assert.equal(summary.messagesChars, 5 + 6 + 3 + JSON.stringify({ path: "x" }).length);
		assert.equal(summary.toolResultsChars, 6 + 13);
		assert.equal(summary.summaryChars, 5);
		// System transcript entries are skipped: the replayed prompt is the System bucket.
		assert.equal(summary.otherChars, 6 + 2 + 2);
		assert.equal(summary.imageParts, 1);
		assert.equal(summary.truncated, false);
		assert.equal(summary.builtAt, 42);
		assert.deepEqual(summary.largestToolResults, [
			{ name: "read", chars: 13 },
			{ name: "bash", chars: 6 },
		]);
	});

	test("keeps the three largest tool results, with control-free bounded names", () => {
		const summary = buildEffectiveContext({
			messages: [
				{ role: "toolResult", toolName: "a", content: "12345" },
				{ role: "toolResult", toolName: "b", content: "1234567890" },
				{ role: "toolResult", toolName: "c", content: "123" },
				{ role: "toolResult", toolName: "d", content: "1234567" },
				{ role: "toolResult", toolName: `${String.fromCharCode(27)}evil`, content: "1" },
			],
			systemPrompt: "",
			tools: [],
			now: 0,
		});
		assert.deepEqual(summary.largestToolResults, [
			{ name: "b", chars: 10 },
			{ name: "d", chars: 7 },
			{ name: "a", chars: 5 },
		]);
	});

	test("string blocks and unknown future roles stay counted as bounded Other volume", () => {
		const summary = buildEffectiveContext({
			messages: [
				{ role: "user", content: ["abc"] },
				{ role: "futureRole", content: [{ type: "text", text: "xy" }], summary: "zz" },
			],
			systemPrompt: "",
			tools: [],
			now: 0,
		});
		assert.equal(summary.messagesChars, 3);
		assert.equal(summary.otherChars, 4);
	});

	test("unavailable system prompt and tools stay unavailable; an empty active set is a real zero", () => {
		const missing = buildEffectiveContext({ messages: [], systemPrompt: undefined, tools: undefined, now: 0 });
		assert.equal(missing.systemChars, undefined);
		assert.equal(missing.toolsChars, undefined);
		assert.equal(missing.unknownToolSchemas, 0);
		const empty = buildEffectiveContext({ messages: [], systemPrompt: "", tools: [], now: 0 });
		assert.equal(empty.systemChars, 0);
		assert.equal(empty.toolsChars, 0);
	});

	test("tool declaration JSON counting is bounded instead of serializing a hostile schema", () => {
		const huge = toolDeclaration({
			name: "huge",
			description: "",
			parameters: { data: "x".repeat(MAX_SCAN_CHARS + 1) },
		});
		assert.equal(huge.schemaKnown, false);
		assert.equal(huge.textChars, 4);

		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		assert.equal(toolDeclaration({ name: "cycle", parameters: cyclic }).schemaKnown, false);
		const deep = Array.from({ length: MAX_JSON_DEPTH + 1 }).reduce<unknown>((value) => ({ value }), {});
		assert.equal(toolDeclaration({ name: "deep", parameters: deep }).schemaKnown, false);
		const wide = Object.fromEntries(Array.from({ length: MAX_JSON_NODES + 1 }, (_, index) => [`k${index}`, 1]));
		assert.equal(toolDeclaration({ name: "wide", parameters: wide }).schemaKnown, false);
	});

	test("message and volume bounds stop the scan and mark it truncated", () => {
		const many: ContextMessage[] = Array.from({ length: MAX_SCAN_MESSAGES + 1 }, () => ({
			role: "user",
			content: "",
		}));
		assert.equal(buildEffectiveContext({ messages: many, systemPrompt: "", tools: [], now: 0 }).truncated, true);
		const huge = buildEffectiveContext({
			messages: [{ role: "toolResult", toolName: "bash", content: "x".repeat(MAX_SCAN_CHARS + 1) }],
			systemPrompt: "",
			tools: [],
			now: 0,
		});
		assert.equal(huge.truncated, true);
		assert.equal(huge.toolResultsChars, MAX_SCAN_CHARS + 1);
		const hugeSummary = buildEffectiveContext({
			messages: [{ role: "compactionSummary", summary: "s".repeat(MAX_SCAN_CHARS + 1) }],
			systemPrompt: "",
			tools: [],
			now: 0,
		});
		assert.equal(hugeSummary.truncated, true);
		assert.equal(hugeSummary.summaryChars, MAX_SCAN_CHARS + 1);
	});

	test("system transcript blocks are skipped without being scanned or counted", () => {
		const summary = buildEffectiveContext({
			messages: [
				{
					role: "system",
					content: Array.from({ length: MAX_SCAN_BLOCKS + 1 }, () => ({ type: "image" })),
				},
			],
			systemPrompt: "SYS",
			tools: [],
			now: 0,
		});
		assert.equal(summary.truncated, false);
		assert.equal(summary.imageParts, 0);
		assert.equal(summary.otherChars, 0);
		assert.equal(summary.systemChars, 3);
	});

	test("bounds also apply inside one message's blocks and tool-call arguments", () => {
		const blocks = Array.from({ length: MAX_SCAN_BLOCKS + 1 }, () => ({ type: "image" }));
		const manyBlocks = buildEffectiveContext({
			messages: [{ role: "user", content: blocks }],
			systemPrompt: "",
			tools: [],
			now: 0,
		});
		assert.equal(manyBlocks.imageParts, MAX_SCAN_BLOCKS);
		assert.equal(manyBlocks.truncated, true);

		const hugeArgs = buildEffectiveContext({
			messages: [
				{ role: "assistant", content: [{ type: "toolCall", arguments: { data: "x".repeat(MAX_SCAN_CHARS + 1) } }] },
			],
			systemPrompt: "",
			tools: [],
			now: 0,
		});
		assert.equal(hugeArgs.truncated, true);
		assert.ok(hugeArgs.messagesChars > 0);

		const unknownArgs = buildEffectiveContext({
			messages: [{ role: "assistant", content: [{ type: "toolCall", arguments: { size: 1n } }] }],
			systemPrompt: "",
			tools: [],
			now: 0,
		});
		assert.equal(unknownArgs.truncated, true);

		const dateArgs = buildEffectiveContext({
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", arguments: { default: new Date("2020-01-01T00:00:00Z") } }],
				},
			],
			systemPrompt: "",
			tools: [],
			now: 0,
		});
		assert.equal(dateArgs.truncated, true);
	});

	test("block and JSON work budgets are shared across the whole summary", () => {
		const blockMessages: ContextMessage[] = Array.from({ length: MAX_SCAN_MESSAGES }, () => ({
			role: "user",
			content: Array.from({ length: 6 }, () => ({ type: "image" })),
		}));
		const blockSummary = buildEffectiveContext({
			messages: blockMessages,
			systemPrompt: "",
			tools: [],
			now: 0,
		});
		assert.equal(blockSummary.imageParts, MAX_SCAN_BLOCKS);
		assert.equal(blockSummary.truncated, true);

		const args = { values: Array.from({ length: 55 }, (_, index) => index) };
		const jsonMessages: ContextMessage[] = Array.from({ length: MAX_SCAN_MESSAGES }, () => ({
			role: "assistant",
			content: [{ type: "toolCall", arguments: args }],
		}));
		const jsonSummary = buildEffectiveContext({
			messages: jsonMessages,
			systemPrompt: "",
			tools: [],
			now: 0,
		});
		assert.equal(jsonSummary.truncated, true);
		assert.ok(jsonSummary.messagesChars > 0);
	});
});

describe("context change", () => {
	test("only a known reading with the same window becomes a delta", () => {
		assert.deepEqual(
			compareContext({ usedTokens: 100, contextWindow: 1000 }, { usedTokens: 250, contextWindow: 1000 }),
			{
				before: 100,
				after: 250,
				delta: 150,
			},
		);
		assert.deepEqual(compareContext(undefined, { usedTokens: 1, contextWindow: 1 }), {
			unavailable: "no reading from the run start",
		});
		assert.deepEqual(compareContext({ usedTokens: 1, contextWindow: 0 }, { usedTokens: 2, contextWindow: 0 }), {
			unavailable: "context window unknown",
		});
		assert.deepEqual(compareContext({ usedTokens: 1, contextWindow: 10 }, { usedTokens: 2, contextWindow: 20 }), {
			unavailable: "context window changed",
		});
		assert.deepEqual(compareContext({ usedTokens: null, contextWindow: 10 }, { usedTokens: 2, contextWindow: 10 }), {
			unavailable: "context reading unknown",
		});
		assert.deepEqual(compareContext({ usedTokens: 1, contextWindow: 10 }, { usedTokens: 2, contextWindow: 10 }, "x"), {
			unavailable: "x",
		});
	});

	test("exact counts for raw provider numbers, compact only for text volume", () => {
		assert.equal(formatExactCount(12_340), "12340");
		assert.equal(formatExactCount(999), "999");
		assert.equal(formatExactCount(Number.NaN), "?");
		assert.equal(formatCount(950), "950");
		assert.equal(formatCount(12_340), "12.3K");
		assert.equal(formatCount(1_234_000), "1.2M");
		assert.equal(formatCount(-1500), "-1.5K");
	});
});
