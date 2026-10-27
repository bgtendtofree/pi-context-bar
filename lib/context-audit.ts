/**
 * Read-only, bounded diagnostics over Pi's effective model context.
 *
 * Nothing here is a provider token count: the buckets are text volume (UTF-16 code units) of what
 * Pi says it will send, after compaction and context edits. Values are never scaled to Pi's own
 * context estimate, and unobservable sources stay unavailable instead of becoming zero.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ContextSnapshot } from "./context.ts";
import { isObject } from "./json.ts";

/** Scan bounds keep one summary bounded even when a tool result is enormous or history is long. */
export const MAX_SCAN_MESSAGES = 2000;
export const MAX_SCAN_CHARS = 8 * 1024 * 1024;
export const MAX_TOOL_NAME_CHARS = 64;
/** Same per-label input bound as /status: strip and truncate must not allocate a huge label. */
export const MAX_TOOL_NAME_INPUT = 4096;
export const LARGEST_TOOL_RESULTS = 3;
/** Shared block and JSON traversal budgets keep one summary from multiplying per-message caps. */
export const MAX_SCAN_BLOCKS = 10_000;
export const MAX_JSON_NODES = 100_000;
export const MAX_JSON_DEPTH = 64;

type JsonBudget = { nodes: number };
type ScanBudget = JsonBudget & { blocks: number };

export type RequestUsage = Readonly<{
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	total: number;
	reasoning: number | undefined;
	stopReason: string;
}>;

const finiteCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Provider-reported usage of the latest assistant response on the current branch, raw and
 * unmodified. An all-zero block is Pi's placeholder for "no report" (typical on provider errors),
 * and a partial/non-finite block cannot be trusted; both stay unavailable instead of showing 0.
 */
export const latestRequestUsage = (entries: readonly SessionEntry[]): RequestUsage | undefined => {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		if (usage === undefined) return undefined;
		const { input, cacheRead, cacheWrite, output, totalTokens } = usage;
		if (![input, cacheRead, cacheWrite, output, totalTokens].every(finiteCount)) return undefined;
		if (input === 0 && cacheRead === 0 && cacheWrite === 0 && output === 0 && totalTokens === 0) return undefined;
		return {
			input,
			cacheRead,
			cacheWrite,
			output,
			total: totalTokens,
			reasoning: finiteCount(usage.reasoning) ? usage.reasoning : undefined,
			stopReason: typeof entry.message.stopReason === "string" ? entry.message.stopReason : "unknown",
		};
	}
	return undefined;
};

/** One active tool declaration as Pi's public registry describes it. */
export type ToolDeclaration = Readonly<{
	name: string;
	/** Name + description + serialized parameter schema; excludes Pi-side prompt guidelines. */
	textChars: number;
	schemaKnown: boolean;
}>;

const jsonChars = (value: unknown, limit: number, budget: JsonBudget): Readonly<{ chars: number; known: boolean }> => {
	let used = 0;
	let complete = true;
	const stack = new Set<object>();
	const takeNode = (): boolean => {
		if (budget.nodes <= 0) {
			complete = false;
			return false;
		}
		budget.nodes--;
		return true;
	};
	const add = (chars: number): boolean => {
		used += chars;
		if (used <= limit) return true;
		complete = false;
		return false;
	};
	const addString = (text: string): boolean => {
		if (!add(2)) return false;
		for (let index = 0; index < text.length; index++) {
			const code = text.charCodeAt(index);
			let width = 1;
			if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13)
				width = 2;
			else if (code < 0x20) width = 6;
			else if (code >= 0xd800 && code <= 0xdbff) {
				const next = text.charCodeAt(index + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					index++;
					width = 2;
				} else width = 6;
			} else if (code >= 0xdc00 && code <= 0xdfff) width = 6;
			if (!add(width)) return false;
		}
		return true;
	};
	const walk = (current: unknown, depth: number): "ok" | "omit" | "unknown" | "overflow" => {
		if (!complete) return "overflow";
		if (depth > MAX_JSON_DEPTH || !takeNode()) {
			complete = false;
			return "overflow";
		}
		if (current === null) return add(4) ? "ok" : "overflow";
		switch (typeof current) {
			case "string":
				return addString(current) ? "ok" : "overflow";
			case "number":
				return add(Number.isFinite(current) ? String(current).length : 4) ? "ok" : "overflow";
			case "boolean":
				return add(current ? 4 : 5) ? "ok" : "overflow";
			case "undefined":
			case "function":
			case "symbol":
				return "omit";
			case "bigint":
				complete = false;
				return "unknown";
			case "object": {
				const object = current as object;
				try {
					// JSON.stringify would call toJSON; never execute it, and only count plain objects exactly.
					if ("toJSON" in object) {
						complete = false;
						return "unknown";
					}
					if (!Array.isArray(object)) {
						const proto = Object.getPrototypeOf(object);
						if (proto !== Object.prototype && proto !== null) {
							complete = false;
							return "unknown";
						}
					}
				} catch {
					complete = false;
					return "unknown";
				}
				if (stack.has(object)) {
					complete = false;
					return "unknown";
				}
				stack.add(object);
				try {
					if (Array.isArray(object)) {
						if (!add(1)) return "overflow";
						for (let index = 0; index < object.length; index++) {
							if (index > 0 && !add(1)) return "overflow";
							const result = walk(object[index], depth + 1);
							if (result === "unknown" || result === "overflow") return result;
							if (result === "omit" && !add(4)) return "overflow";
						}
						return add(1) ? "ok" : "overflow";
					}
					if (!add(1)) return "overflow";
					let first = true;
					for (const key in object) {
						if (!Object.hasOwn(object, key)) continue;
						let child: unknown;
						try {
							child = (object as Record<string, unknown>)[key];
						} catch {
							complete = false;
							return "unknown";
						}
						const result = walk(child, depth + 1);
						if (result === "omit") continue;
						if (result !== "ok") return result;
						if (!first && !add(1)) return "overflow";
						first = false;
						if (!addString(key) || !add(1)) return "overflow";
					}
					return add(1) ? "ok" : "overflow";
				} finally {
					stack.delete(object);
				}
			}
		}
		complete = false;
		return "unknown";
	};
	let result: "ok" | "omit" | "unknown" | "overflow";
	try {
		result = walk(value, 0);
	} catch {
		complete = false;
		result = "unknown";
	}
	return { chars: used, known: complete && result !== "unknown" };
};

type ToolLike = Readonly<{
	name: string;
	description?: string | undefined;
	parameters?: unknown;
}>;

type SchemaBudget = { nodes: number; chars: number };

const declaration = (tool: ToolLike, budget: SchemaBudget): ToolDeclaration => {
	const labelChars = tool.name.length + (tool.description?.length ?? 0);
	// Once the shared budget is spent, the remaining schemas stay unknown without another walk.
	if (budget.nodes <= 0 || budget.chars <= 0) {
		return { name: tool.name, textChars: labelChars, schemaKnown: false };
	}
	const schema = jsonChars(tool.parameters, budget.chars, budget);
	budget.chars = Math.max(0, budget.chars - schema.chars);
	return {
		name: tool.name,
		textChars: labelChars + (schema.known ? schema.chars : 0),
		schemaKnown: schema.known,
	};
};

export const toolDeclaration = (tool: ToolLike): ToolDeclaration =>
	declaration(tool, { nodes: MAX_JSON_NODES, chars: MAX_SCAN_CHARS });

/** Summarize the whole schema list with one shared node/character traversal budget. */
export const toolDeclarations = (tools: readonly ToolLike[]): readonly ToolDeclaration[] => {
	const budget: SchemaBudget = { nodes: MAX_JSON_NODES, chars: MAX_SCAN_CHARS };
	return tools.map((tool) => declaration(tool, budget));
};

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
/** Complete CSI/OSC strings, built from codes so this source carries no escape literal. */
const TERMINAL_STRING = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, "g");

/** Bounded, control-free tool label; never stores more than the cap. */
export const boundedToolName = (value: unknown): string => {
	// Bound before replace/spread: a hostile or enormous label must not allocate an unbounded copy.
	const text = typeof value === "string" ? value.slice(0, MAX_TOOL_NAME_INPUT) : "";
	const stripped = text
		// Drop complete terminal strings before their printable payload (e.g. "[31m") is left behind.
		.replace(TERMINAL_STRING, "")
		.replace(/[\p{Cc}\p{Cf}]+/gu, "")
		.trim();
	const points = [...stripped];
	if (points.length === 0) return "unknown";
	if (points.length <= MAX_TOOL_NAME_CHARS) return stripped;
	return `${points.slice(0, MAX_TOOL_NAME_CHARS - 1).join("")}…`;
};

/** Structural view of the projection's AgentMessages; unknown future roles still count as Other. */
export type ContextMessage = Readonly<{
	role?: unknown;
	content?: unknown;
	summary?: unknown;
	toolName?: unknown;
	command?: unknown;
	output?: unknown;
	excludeFromContext?: unknown;
}>;

export type EffectiveContextSummary = Readonly<{
	systemChars: number | undefined;
	toolsChars: number | undefined;
	unknownToolSchemas: number;
	messagesChars: number;
	toolResultsChars: number;
	summaryChars: number;
	otherChars: number;
	imageParts: number;
	/** Largest tool results in the effective context, largest first, names bounded. */
	largestToolResults: readonly Readonly<{ name: string; chars: number }>[];
	/** A scan bound was hit; the buckets cover only the scanned prefix. */
	truncated: boolean;
	builtAt: number;
}>;

const blockVolume = (
	content: unknown,
	remaining: number,
	budget: ScanBudget,
): Readonly<{ chars: number; images: number; truncated: boolean }> => {
	if (typeof content === "string") return { chars: content.length, images: 0, truncated: false };
	if (!Array.isArray(content)) return { chars: 0, images: 0, truncated: false };
	let chars = 0;
	let images = 0;
	for (let index = 0; index < content.length; index++) {
		if (budget.blocks <= 0) return { chars, images, truncated: true };
		budget.blocks--;
		const block = content[index];
		if (typeof block === "string") {
			chars += block.length;
		} else if (isObject(block)) {
			if (block.type === "image") {
				images++;
			} else {
				if (typeof block.text === "string") chars += block.text.length;
				if (typeof block.thinking === "string") chars += block.thinking.length;
				// Tool-call arguments are part of the assistant message sent back to the model.
				if (block.type === "toolCall") {
					const args = jsonChars(block.arguments, Math.max(0, remaining - chars), budget);
					chars += args.chars;
					if (!args.known) return { chars, images, truncated: true };
				}
			}
		}
		if (chars > remaining) return { chars, images, truncated: true };
	}
	return { chars, images, truncated: false };
};

export type EffectiveContextInput = Readonly<{
	messages: readonly ContextMessage[];
	/** Pi's live effective prompt; undefined when the public API could not provide it. */
	systemPrompt: string | undefined;
	/** Active tool declarations; undefined when the registry or active set is unavailable. */
	tools: readonly ToolDeclaration[] | undefined;
	now: number;
}>;

const insertLargest = (
	largest: readonly Readonly<{ name: string; chars: number }>[],
	entry: Readonly<{ name: string; chars: number }>,
): readonly Readonly<{ name: string; chars: number }>[] => {
	const next = [...largest, entry].sort((left, right) => right.chars - left.chars);
	return next.slice(0, LARGEST_TOOL_RESULTS);
};

export const buildEffectiveContext = (input: EffectiveContextInput): EffectiveContextSummary => {
	let messagesChars = 0;
	let toolResultsChars = 0;
	let summaryChars = 0;
	let otherChars = 0;
	let imageParts = 0;
	let scannedChars = 0;
	let largest: readonly Readonly<{ name: string; chars: number }>[] = [];
	let truncated = input.messages.length > MAX_SCAN_MESSAGES;
	const budget: ScanBudget = { blocks: MAX_SCAN_BLOCKS, nodes: MAX_JSON_NODES };

	for (const message of input.messages.slice(0, MAX_SCAN_MESSAGES)) {
		const role = message.role;
		// System transcript entries are never guessed from content; only the replayed prompt is counted.
		if (role === "system") continue;
		const content = blockVolume(message.content, Math.max(0, MAX_SCAN_CHARS - scannedChars), budget);
		scannedChars += content.chars;
		imageParts += content.images;
		if (role === "toolResult") {
			toolResultsChars += content.chars;
			largest = insertLargest(largest, { name: boundedToolName(message.toolName), chars: content.chars });
		} else if (role === "compactionSummary" || role === "branchSummary") {
			const summaryLength = typeof message.summary === "string" ? message.summary.length : 0;
			summaryChars += summaryLength || content.chars;
			scannedChars += summaryLength;
		} else if (role === "user" || role === "assistant") {
			messagesChars += content.chars;
		} else if (role === "bashExecution") {
			// `!!` bash output never reaches the model; only the included part is context volume.
			if (message.excludeFromContext !== true) {
				const commandChars = typeof message.command === "string" ? message.command.length : 0;
				const outputChars = typeof message.output === "string" ? message.output.length : 0;
				otherChars += commandChars + outputChars + content.chars;
				scannedChars += commandChars + outputChars;
			}
		} else if (role === "custom" || role === undefined) {
			otherChars += content.chars;
		} else {
			const summaryLength = typeof message.summary === "string" ? message.summary.length : 0;
			otherChars += content.chars + summaryLength;
			scannedChars += summaryLength;
		}
		if (content.truncated || scannedChars > MAX_SCAN_CHARS) {
			truncated = true;
			break;
		}
	}

	const tools = input.tools;
	return {
		systemChars: typeof input.systemPrompt === "string" ? input.systemPrompt.length : undefined,
		toolsChars: tools ? tools.reduce((sum, tool) => sum + tool.textChars, 0) : undefined,
		unknownToolSchemas: tools?.filter((tool) => !tool.schemaKnown).length ?? 0,
		messagesChars,
		toolResultsChars,
		summaryChars,
		otherChars,
		imageParts,
		largestToolResults: largest,
		truncated,
		builtAt: input.now,
	};
};

export type ContextChange =
	| Readonly<{ delta: number; before: number; after: number }>
	| Readonly<{ unavailable: string }>;

/** Compare this run's start and end readings; a changed window or unknown reading is not a delta. */
export const compareContext = (
	before: ContextSnapshot | undefined,
	after: ContextSnapshot,
	invalidReason?: string,
): ContextChange => {
	if (invalidReason) return { unavailable: invalidReason };
	if (!before) return { unavailable: "no reading from the run start" };
	if (before.contextWindow <= 0 || after.contextWindow <= 0) return { unavailable: "context window unknown" };
	if (before.contextWindow !== after.contextWindow) return { unavailable: "context window changed" };
	if (before.usedTokens === null || after.usedTokens === null) return { unavailable: "context reading unknown" };
	return { before: before.usedTokens, after: after.usedTokens, delta: after.usedTokens - before.usedTokens };
};

/** Exact integer for raw request counts; diagnostics must not round a provider number. */
export const formatExactCount = (count: number): string => (Number.isFinite(count) ? `${Math.trunc(count)}` : "?");

/** Compact count for text-volume diagnostics: 950, 12.3K, 1.2M. */
export const formatCount = (count: number): string => {
	if (!Number.isFinite(count)) return "?";
	if (Math.abs(count) < 1000) return `${Math.round(count)}`;
	const thousands = Math.round(count / 100) / 10;
	if (Math.abs(thousands) < 1000) return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
	const millions = Math.round(thousands / 100) / 10;
	return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
};
