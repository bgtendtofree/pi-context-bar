/** Context estimation, segment allocation, and session usage. No Pi runtime dependencies. */

export const CHARACTERS_PER_TOKEN = 4;
export const IMAGE_TOKEN_ESTIMATE = 1200;

export const CONTEXT_SEGMENTS = [
	{ key: "system", name: "system" },
	{ key: "prompt", name: "prompt" },
	{ key: "assistant", name: "reply" },
	{ key: "thinking", name: "reasoning" },
	{ key: "tools", name: "tools" },
] as const;

export type ContextSegmentKey = (typeof CONTEXT_SEGMENTS)[number]["key"];
export type ContextSegments = Readonly<Record<ContextSegmentKey, number>>;
export type WritableContextSegments = Record<ContextSegmentKey, number>;

export type ContextSnapshot = Readonly<{
	segments: ContextSegments;
	usedTokens: number;
	contextWindow: number;
	usageIsEstimated: boolean;
}>;

export type SessionUsage = Readonly<{
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Cache hit rate 0–100 of the most recent assistant turn that reported prompt tokens. */
	cacheHitRate: number | undefined;
}>;

export type AssistantUsage = Readonly<{
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: Readonly<{ total: number }>;
}>;

export type SessionUsageEntry = Readonly<{
	type: string;
	message: Readonly<{
		role: string;
		usage: AssistantUsage;
	}>;
}>;

export const emptyContextSegments = (): WritableContextSegments => ({
	system: 0,
	prompt: 0,
	assistant: 0,
	thinking: 0,
	tools: 0,
});

export const formatTokens = (count: number): string => {
	const value = Math.max(0, Math.round(count));
	if (value < 1000) return String(value);
	if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1000000) return `${Math.round(value / 1000)}k`;
	if (value < 10000000) return `${(value / 1000000).toFixed(1)}M`;
	return `${Math.round(value / 1000000)}M`;
};

export const estimateTextTokens = (text: string): number => Math.ceil(text.length / CHARACTERS_PER_TOKEN);

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";

export const estimateContentTokens = (content: unknown): number => {
	if (typeof content === "string") return estimateTextTokens(content);
	if (!Array.isArray(content)) return 0;

	let textLength = 0;
	let images = 0;
	for (const part of content) {
		if (!isRecord(part)) continue;
		if (part.type === "text" && typeof part.text === "string") textLength += part.text.length;
		if (part.type === "image") images++;
	}
	return Math.ceil(textLength / CHARACTERS_PER_TOKEN) + images * IMAGE_TOKEN_ESTIMATE;
};

const estimateToolCallTokens = (part: Record<string, unknown>): number => {
	const name = typeof part.name === "string" ? part.name : "";
	const input = JSON.stringify(part.arguments ?? {});
	return estimateTextTokens(`${name}${input}`);
};

const addAssistantTokens = (segments: WritableContextSegments, content: unknown): void => {
	if (!Array.isArray(content)) return;
	for (const part of content) {
		if (!isRecord(part)) continue;
		if (part.type === "text" && typeof part.text === "string") {
			segments.assistant += estimateTextTokens(part.text);
		}
		if (part.type === "thinking" && typeof part.thinking === "string") {
			segments.thinking += estimateTextTokens(part.thinking);
		}
		if (part.type === "toolCall") segments.assistant += estimateToolCallTokens(part);
	}
};

export const segmentSessionMessages = (messages: readonly unknown[], systemPrompt: string): ContextSegments => {
	const segments = emptyContextSegments();
	segments.system = estimateTextTokens(systemPrompt);
	for (const message of messages) {
		if (!isRecord(message)) continue;
		if (message.role === "user") segments.prompt += estimateContentTokens(message.content);
		if (message.role === "assistant") addAssistantTokens(segments, message.content);
		if (message.role === "toolResult") segments.tools += estimateContentTokens(message.content);
	}
	return segments;
};

export const segmentTotal = (segments: ContextSegments): number =>
	CONTEXT_SEGMENTS.reduce((total, segment) => total + segments[segment.key], 0);

export const allocateProportionally = (values: readonly number[], columns: number): readonly number[] => {
	if (columns <= 0) return values.map(() => 0);
	const total = values.reduce((sum, value) => sum + value, 0);
	if (total <= 0) return values.map(() => 0);

	const rawColumns = values.map((value) => (value / total) * columns);
	const allocatedColumns = rawColumns.map(Math.floor);
	let remainingColumns = columns - allocatedColumns.reduce((sum, value) => sum + value, 0);
	const largestRemainders = rawColumns
		.map((value, index) => ({ index, remainder: value - Math.floor(value) }))
		.sort((left, right) => right.remainder - left.remainder);

	for (let index = 0; index < largestRemainders.length && remainingColumns > 0; index++, remainingColumns--) {
		const slot = largestRemainders[index];
		if (!slot) break;
		allocatedColumns[slot.index] = (allocatedColumns[slot.index] ?? 0) + 1;
	}
	return allocatedColumns;
};

export const segmentsFromValues = (values: readonly number[]): ContextSegments => {
	const segments = emptyContextSegments();
	for (const [index, segment] of CONTEXT_SEGMENTS.entries()) segments[segment.key] = values[index] ?? 0;
	return segments;
};

export const scaleSegmentsToUsage = (segments: ContextSegments, usedTokens: number): ContextSegments => {
	if (usedTokens <= 0 || segmentTotal(segments) <= 0) return segments;
	return segmentsFromValues(
		allocateProportionally(
			CONTEXT_SEGMENTS.map((segment) => segments[segment.key]),
			Math.round(usedTokens),
		),
	);
};

export const makeContextSnapshot = (
	messages: readonly unknown[],
	systemPrompt: string,
	measuredTokens: number | undefined,
	contextWindow: number,
): ContextSnapshot => {
	const rawSegments = segmentSessionMessages(messages, systemPrompt);
	const estimatedTokens = segmentTotal(rawSegments);
	const usedTokens = measuredTokens ?? estimatedTokens;
	return {
		segments: scaleSegmentsToUsage(rawSegments, usedTokens),
		usedTokens,
		contextWindow,
		usageIsEstimated: measuredTokens === undefined,
	};
};

export const cacheHitRate = (usage: AssistantUsage): number | undefined => {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	return promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
};

export const accumulateSessionUsage = (entries: readonly SessionUsageEntry[]): SessionUsage => {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let hitRate: number | undefined;

	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		input += usage.input;
		output += usage.output;
		cacheRead += usage.cacheRead;
		cacheWrite += usage.cacheWrite;
		cost += usage.cost.total;
		const rate = cacheHitRate(usage);
		if (rate !== undefined) hitRate = rate;
	}
	return { input, output, cacheRead, cacheWrite, cost, cacheHitRate: hitRate };
};
