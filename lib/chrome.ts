/** Pure chrome math + formatting for pi-context-bar. No Pi runtime dependencies. */

export const CHARACTERS_PER_TOKEN = 4;
export const IMAGE_TOKEN_ESTIMATE = 1200;
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/**
 * Monochrome cool-slate ramp for used segments (dark → light = early → late).
 * One accent (cache hit). Free zone is quiet — no loud multi-hue chrome.
 */
export const USED_SEGMENT_TEXT = "#0E1218";
/** Free zone: no fill block; metrics sit on terminal bg. */
export const FREE_SEGMENT_FILL = "";
export const FREE_SEGMENT_TEXT = "#6B7280";
export const FREE_SEGMENT_TEXT_HOT = "#B45309";
export const FREE_SEGMENT_TEXT_FULL = "#B91C1C";
/** Sole accent in the free metrics. */
export const CACHE_HIT_TEXT = "#2DD4BF";
/** Cost stays muted — secondary to % and CH. */
export const COST_TEXT = "#6B7280";

/** Min columns before a used segment shows its short label. Wider → full label. */
export const LABEL_MIN_WIDTH = 4;

export const USED_SEGMENTS = [
	{ key: "system", color: "#3D4F5F", labels: ["system", "sys", "s"] },
	{ key: "prompt", color: "#4F6578", labels: ["prompt", "pr", "p"] },
	{ key: "assistant", color: "#6A8499", labels: ["assistant", "ast", "a"] },
	{ key: "thinking", color: "#8AA0B2", labels: ["think", "th", "t"] },
	{ key: "tools", color: "#A8B9C7", labels: ["tools", "tl", "x"] },
] as const;

export type ContextSegmentKey = (typeof USED_SEGMENTS)[number]["key"];
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
	/** Last assistant turn cache hit rate 0–100, when prompt tokens known. */
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

export type ModelInfo = Readonly<{
	id: string;
	provider: string;
	reasoning: boolean;
}> | null;

export const emptyContextSegments = (): WritableContextSegments => ({
	system: 0,
	prompt: 0,
	assistant: 0,
	thinking: 0,
	tools: 0,
});

export const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, "");

export const plainWidth = (text: string): number => Array.from(stripAnsi(text)).length;

export const truncatePlainText = (text: string, width: number): string => {
	if (width <= 0) return "";

	const characters = Array.from(text);
	if (characters.length <= width) return text;
	if (width === 1) return "…";

	return `${characters.slice(0, width - 1).join("")}…`;
};

export const fitStyledText = (text: string, width: number): string =>
	plainWidth(text) <= width ? text : truncatePlainText(stripAnsi(text), width);

export const estimateTextTokens = (text: string): number => Math.ceil(text.length / CHARACTERS_PER_TOKEN);

export const formatTokens = (count: number): string => {
	const value = Math.max(0, Math.round(count));

	if (value < 1000) return String(value);
	if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1000000) return `${Math.round(value / 1000)}k`;
	if (value < 10000000) return `${(value / 1000000).toFixed(1)}M`;

	return `${Math.round(value / 1000000)}M`;
};

export const ansiColor = (mode: 38 | 48, hex: string, text: string): string => {
	const value = Number.parseInt(hex.replace(/^#/, ""), 16);
	const red = (value >> 16) & 0xff;
	const green = (value >> 8) & 0xff;
	const blue = value & 0xff;
	const reset = mode === 38 ? 39 : 49;

	return `\x1b[${mode};2;${red};${green};${blue}m${text}\x1b[${reset}m`;
};

export const foreground = (hex: string, text: string): string => ansiColor(38, hex, text);

export const background = (hex: string, text: string): string => ansiColor(48, hex, text);

export const centeredText = (text: string, width: number): string => {
	const textWidth = plainWidth(text);
	if (textWidth > width) return " ".repeat(width);

	const left = Math.floor((width - textWidth) / 2);
	const right = width - textWidth - left;

	return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object";

const contentRecords = (content: unknown): readonly Record<string, unknown>[] =>
	Array.isArray(content) ? content.filter(isRecord) : [];

const textFromContent = (content: unknown): string => {
	if (typeof content === "string") return content;

	return contentRecords(content)
		.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("");
};

const imageCount = (content: unknown): number => contentRecords(content).filter((part) => part.type === "image").length;

export const estimateContentTokens = (content: unknown): number =>
	estimateTextTokens(textFromContent(content)) + imageCount(content) * IMAGE_TOKEN_ESTIMATE;

const estimateToolCallTokens = (part: Record<string, unknown>): number => {
	const name = typeof part.name === "string" ? part.name : "";
	const input = JSON.stringify(part.arguments ?? {});

	return estimateTextTokens(`${name}${input}`);
};

const addAssistantTokens = (segments: WritableContextSegments, content: unknown): void => {
	for (const part of contentRecords(content)) {
		if (part.type === "text" && typeof part.text === "string") {
			segments.assistant += estimateTextTokens(part.text);
		}

		if (part.type === "thinking" && typeof part.thinking === "string") {
			segments.thinking += estimateTextTokens(part.thinking);
		}

		if (part.type === "toolCall") {
			segments.assistant += estimateToolCallTokens(part);
		}
	}
};

export const segmentSessionMessages = (messages: readonly unknown[], systemPrompt: string): ContextSegments => {
	const segments = emptyContextSegments();
	segments.system = estimateTextTokens(systemPrompt);

	for (const message of messages) {
		if (!isRecord(message)) continue;

		if (message.role === "user") {
			segments.prompt += estimateContentTokens(message.content);
		}

		if (message.role === "assistant") {
			addAssistantTokens(segments, message.content);
		}

		if (message.role === "toolResult") {
			segments.tools += estimateContentTokens(message.content);
		}
	}

	return segments;
};

export const segmentTotal = (segments: ContextSegments): number =>
	USED_SEGMENTS.reduce((total, segment) => total + segments[segment.key], 0);

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

	for (const [index, segment] of USED_SEGMENTS.entries()) {
		segments[segment.key] = values[index] ?? 0;
	}

	return segments;
};

export const scaleSegmentsToUsage = (segments: ContextSegments, usedTokens: number): ContextSegments => {
	if (usedTokens <= 0 || segmentTotal(segments) <= 0) return segments;

	const values = USED_SEGMENTS.map((segment) => segments[segment.key]);

	return segmentsFromValues(allocateProportionally(values, Math.round(usedTokens)));
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
		hitRate = cacheHitRate(usage);
	}

	return { input, output, cacheRead, cacheWrite, cost, cacheHitRate: hitRate };
};

export const chooseLabel = (labels: readonly string[], width: number): string => {
	for (const label of labels) {
		if (plainWidth(label) <= width) return label;
	}

	return "";
};

export const renderUsedSegment = (labels: readonly string[], color: string, width: number): string => {
	if (width <= 0) return "";

	// Prefer pure color blocks; labels only when segment is wide enough.
	const label = width >= LABEL_MIN_WIDTH ? chooseLabel(labels, width) : "";
	const text = label.length > 0 ? foreground(USED_SEGMENT_TEXT, centeredText(label, width)) : " ".repeat(width);

	return background(color, text);
};

export const freeTextColor = (percent: number): string => {
	if (percent > 90) return FREE_SEGMENT_TEXT_FULL;
	if (percent > 70) return FREE_SEGMENT_TEXT_HOT;
	return FREE_SEGMENT_TEXT;
};

/**
 * Free-zone metric options, widest → tightest.
 * Keep only health signals: % · CH · optional $. No ↑↓RW / absolute totals.
 */
export const freeMetricOptions = (snapshot: ContextSnapshot, usage: SessionUsage): readonly string[] => {
	const prefix = snapshot.usageIsEstimated ? "~" : "";
	const percent =
		snapshot.contextWindow > 0 ? `${prefix}${((snapshot.usedTokens / snapshot.contextWindow) * 100).toFixed(1)}%` : "";
	const ch = usage.cacheHitRate !== undefined ? `CH${usage.cacheHitRate.toFixed(1)}%` : "";
	const chShort = usage.cacheHitRate !== undefined ? `CH${Math.round(usage.cacheHitRate)}%` : "";
	const cost = usage.cost > 0 ? `$${usage.cost.toFixed(3)}` : "";
	const costShort = usage.cost > 0 ? `$${usage.cost.toFixed(2)}` : "";

	const join = (...parts: string[]) => parts.filter(Boolean).join(" · ");

	return [
		join(percent, ch, cost),
		join(percent, chShort, costShort),
		join(percent, chShort),
		join(percent, ch ? "CH" : ""),
		percent,
		chShort,
		"",
	];
};

export const pickFirstFitting = (options: readonly string[], width: number): string => {
	for (const option of options) {
		if (plainWidth(option) <= width) return option;
	}

	return "";
};

export const styleFreeMetrics = (plain: string, percent: number): string => {
	if (plain.length === 0) return "";

	const color = freeTextColor(percent);
	// Split on middle-dot separators so "45% · CH92% · $0.04" styles cleanly.
	const tokens = plain.split(" · ");
	const styled = tokens.map((token) => {
		if (token.startsWith("CH")) return foreground(CACHE_HIT_TEXT, token);
		if (token.startsWith("$")) return foreground(COST_TEXT, token);
		// Only the usage % uses hot/full threshold colors.
		if (token.includes("%") && !token.startsWith("CH")) return foreground(color, token);
		return foreground(FREE_SEGMENT_TEXT, token);
	});

	return styled.join(foreground(FREE_SEGMENT_TEXT, " · "));
};

export const renderFreeSegment = (width: number, metricOptions: readonly string[], percent: number): string => {
	if (width <= 0) return "";

	const chosen = pickFirstFitting(metricOptions, width);

	if (chosen.length === 0) {
		return " ".repeat(width);
	}

	// Left-align metrics in free zone (reads as trailing status, not a second bar).
	const metrics = styleFreeMetrics(chosen, percent);
	const pad = Math.max(0, width - plainWidth(chosen));
	const leftPad = pad > 0 ? " " : "";
	const rightPad = " ".repeat(Math.max(0, pad - (leftPad ? 1 : 0)));

	return `${leftPad}${metrics}${rightPad}`;
};

export const allocateBarColumns = (values: readonly number[], width: number): readonly number[] => {
	const usedCount = USED_SEGMENTS.length;
	const visibleUsedSegments = USED_SEGMENTS.map((_, index) => index).filter((index) => (values[index] ?? 0) > 0);

	if (visibleUsedSegments.length === 0 || visibleUsedSegments.length >= width) {
		return allocateProportionally(values, width);
	}

	// Only enforce min-1 on used segments; free zone (last slot) may be zero.
	const minimumColumns = Array.from({ length: values.length }, () => 0);

	for (const index of visibleUsedSegments) {
		if (index < usedCount) minimumColumns[index] = 1;
	}

	const minTotal = visibleUsedSegments.length;
	const remainingColumns = allocateProportionally(values, width - minTotal);

	return minimumColumns.map((minimum, index) => minimum + (remainingColumns[index] ?? 0));
};

export const formatModel = (model: ModelInfo, thinkingLevel: string, providerCount: number): string => {
	if (!model) return "no-model";

	const thinking = model.reasoning ? ` · ${thinkingLevel}` : "";
	const base = `${model.id}${thinking}`;

	return providerCount > 1 ? `(${model.provider}) ${base}` : base;
};

export const modelOptions = (model: ModelInfo, thinkingLevel: string, providerCount: number): readonly string[] => {
	if (!model) return ["no-model", "?"];

	const id = model.id;
	const shortId = id.includes("/") ? (id.split("/").pop() ?? id) : id;
	const thinking = model.reasoning ? thinkingLevel : "";
	const withThinking = thinking ? `${id} · ${thinking}` : id;
	const shortWithThinking = thinking ? `${shortId} · ${thinking}` : shortId;
	const withProvider = `(${model.provider}) ${withThinking}`;
	const shortProvider = `(${model.provider}) ${shortWithThinking}`;

	const options = [
		providerCount > 1 ? withProvider : withThinking,
		withThinking,
		providerCount > 1 ? shortProvider : shortWithThinking,
		shortWithThinking,
		shortId,
		shortId.length > 12 ? `${shortId.slice(0, 11)}…` : shortId,
		"·",
	];

	return [...new Set(options.filter(Boolean))];
};

export const pickModelAndBarWidth = (
	models: readonly string[],
	width: number,
): Readonly<{ modelText: string; barWidth: number }> => {
	const minBarWidth = Math.min(12, Math.max(6, Math.floor(width * 0.55)));

	for (const option of models) {
		const gap = option.length > 0 ? 1 : 0;
		const nextBarWidth = width - plainWidth(option) - gap;
		if (nextBarWidth >= minBarWidth) {
			return { modelText: option, barWidth: nextBarWidth };
		}
	}

	return { modelText: "", barWidth: width };
};

export const renderChromeLine = (
	snapshot: ContextSnapshot,
	usage: SessionUsage,
	width: number,
	model: ModelInfo,
	thinkingLevel: string,
	providerCount: number,
	dim: (text: string) => string,
): string => {
	if (snapshot.contextWindow <= 0) {
		const modelText = formatModel(model, thinkingLevel, providerCount);
		const left = dim("ctx unavailable");
		const gap = Math.max(1, width - plainWidth(stripAnsi(left)) - plainWidth(modelText));
		return fitStyledText(`${left}${" ".repeat(gap)}${dim(modelText)}`, width);
	}

	const percent = snapshot.contextWindow > 0 ? (snapshot.usedTokens / snapshot.contextWindow) * 100 : 0;

	const models = modelOptions(model, thinkingLevel, providerCount);
	const { modelText, barWidth } = pickModelAndBarWidth(models, width);

	const freeTokens = Math.max(0, snapshot.contextWindow - snapshot.usedTokens);
	const values = [...USED_SEGMENTS.map((segment) => snapshot.segments[segment.key]), freeTokens];
	const columns = allocateBarColumns(values, barWidth);

	const freeWidth = columns[USED_SEGMENTS.length] ?? 0;
	const metrics = freeMetricOptions(snapshot, usage);

	const usedSegments = USED_SEGMENTS.map((segment, index) =>
		renderUsedSegment(segment.labels, segment.color, columns[index] ?? 0),
	).join("");
	const free = renderFreeSegment(freeWidth, metrics, percent);
	const bar = `${usedSegments}${free}`;

	if (modelText.length === 0) return bar;

	return `${bar} ${dim(modelText)}`;
};
