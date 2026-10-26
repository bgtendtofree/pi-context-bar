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

const jsonChars = (value: unknown): number | undefined => {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		// Cycles and BigInt cannot be serialized as a tool schema; report the schema as unknown.
		return undefined;
	}
};

export const toolDeclaration = (
	tool: Readonly<{
		name: string;
		description?: string | undefined;
		parameters?: unknown;
	}>,
): ToolDeclaration => {
	const schemaChars = jsonChars(tool.parameters);
	return {
		name: tool.name,
		textChars: tool.name.length + (tool.description?.length ?? 0) + (schemaChars ?? 0),
		schemaKnown: schemaChars !== undefined,
	};
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

const blockVolume = (content: unknown): Readonly<{ chars: number; images: number }> => {
	if (typeof content === "string") return { chars: content.length, images: 0 };
	if (!Array.isArray(content)) return { chars: 0, images: 0 };
	let chars = 0;
	let images = 0;
	for (const block of content) {
		if (typeof block === "string") {
			chars += block.length;
			continue;
		}
		if (!isObject(block)) continue;
		if (block.type === "image") {
			images++;
			continue;
		}
		if (typeof block.text === "string") chars += block.text.length;
		if (typeof block.thinking === "string") chars += block.thinking.length;
		// Tool-call arguments are part of the assistant message sent back to the model.
		if (block.type === "toolCall") chars += jsonChars(block.arguments) ?? 0;
	}
	return { chars, images };
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

	for (const message of input.messages.slice(0, MAX_SCAN_MESSAGES)) {
		const content = blockVolume(message.content);
		scannedChars += content.chars;
		imageParts += content.images;
		const role = message.role;
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
		} else if (role === "system") {
			// The leading/replayed prompt is measured from getCurrentSystemPrompt, never from the
			// transcript system entries, so the System bucket cannot double count it.
			continue;
		} else if (role === "custom" || role === undefined) {
			otherChars += content.chars;
		} else {
			const summaryLength = typeof message.summary === "string" ? message.summary.length : 0;
			otherChars += content.chars + summaryLength;
			scannedChars += summaryLength;
		}
		if (scannedChars > MAX_SCAN_CHARS) {
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
