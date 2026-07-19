/** Pure chrome math + formatting for pi-context-bar. No Pi runtime dependencies. */

export const CHARACTERS_PER_TOKEN = 4;
export const IMAGE_TOKEN_ESTIMATE = 1200;
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** Classic Pac-Man palette: cream pellets, yellow hero, phase-colored ghost. */
export const PACMAN_TEXT = "#FFFF00";
export const PELLET_TEXT = "#FFB8AE";
export const PACMAN_FRAMES = ["󰮯", "●"] as const;
export const PACMAN_GLYPH = PACMAN_FRAMES[0];
export const GHOST_GLYPH = "󰊠";
export const PELLET_GLYPH = "•";
export const PACMAN_LANE_MAX_WIDTH = 96;

export const LANE_ACTIVITY_TEXT = {
	working: "#FF0000",
	thinking: "#FFB852",
	assistant: "#00FFFF",
	tools: "#5B5BFF",
} as const;

export type LaneActivity = "idle" | keyof typeof LANE_ACTIVITY_TEXT;
export const FREE_SEGMENT_TEXT = "#6B7280";
export const FREE_SEGMENT_TEXT_HOT = "#B45309";
export const FREE_SEGMENT_TEXT_FULL = "#B91C1C";
export const CACHE_HIT_TEXT = "#00FFFF";
export const COST_TEXT = "#6B7280";

export const USED_SEGMENTS = [
	{ key: "system", label: "S", color: "#FF0000" },
	{ key: "prompt", label: "P", color: "#FFB8FF" },
	{ key: "assistant", label: "A", color: "#00FFFF" },
	{ key: "thinking", label: "T", color: "#FFB852" },
	{ key: "tools", label: "X", color: "#5B5BFF" },
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

export type ModelInfo = Readonly<{
	id: string;
	provider: string;
	reasoning: boolean;
}> | null;

export type GitState = Readonly<{
	branch: string | null;
	detachedOid: string | null;
	ahead: number;
	behind: number;
	staged: number;
	unstaged: number;
	untracked: number;
}>;

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

export const foreground = (hex: string, text: string): string => {
	const value = Number.parseInt(hex.replace(/^#/, ""), 16);
	const red = (value >> 16) & 0xff;
	const green = (value >> 8) & 0xff;
	const blue = value & 0xff;

	return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
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
		// Keep the most recent turn that actually has prompt-token data. A trailing
		// turn with zero prompt tokens (error/partial/no-usage) must not blank CH%.
		const rate = cacheHitRate(usage);
		if (rate !== undefined) hitRate = rate;
	}

	return { input, output, cacheRead, cacheWrite, cost, cacheHitRate: hitRate };
};

export const freeTextColor = (percent: number): string => {
	if (percent > 90) return FREE_SEGMENT_TEXT_FULL;
	if (percent > 70) return FREE_SEGMENT_TEXT_HOT;
	return FREE_SEGMENT_TEXT;
};

export type DominantSegment = Readonly<{
	key: ContextSegmentKey;
	label: string;
	percent: number;
}>;

export const dominantSegments = (snapshot: ContextSnapshot, limit = 3): readonly DominantSegment[] => {
	const total = segmentTotal(snapshot.segments);
	if (snapshot.usedTokens <= 0 || total <= 0 || limit <= 0) return [];

	return USED_SEGMENTS.map((segment, index) => ({
		key: segment.key,
		label: segment.label,
		percent: Math.round((snapshot.segments[segment.key] / total) * 100),
		index,
	}))
		.filter((segment) => segment.percent > 0)
		.sort((left, right) => right.percent - left.percent || left.index - right.index)
		.slice(0, limit)
		.map(({ key, label, percent }) => ({ key, label, percent }));
};

export const segmentMixText = (snapshot: ContextSnapshot, limit = 3): string => {
	const segments = dominantSegments(snapshot, limit);
	if (segments.length === 0) return "";

	return `≈ ${segments.map((segment) => `${segment.label}${segment.percent}`).join(" ")}`;
};

export const formatCost = (cost: number): string => {
	if (cost <= 0) return "";
	return `$${cost >= 1 ? cost.toFixed(2) : cost.toFixed(3)}`;
};

const metricGroup = (...parts: readonly string[]): string => parts.filter(Boolean).join("   ");
const efficiencyGroup = (ch: string, cost: string): string => [ch, cost].filter(Boolean).join("  ");

/** Free-zone metric options, widest → tightest. Core health survives before mix and cost. */
export const freeMetricOptions = (snapshot: ContextSnapshot, usage: SessionUsage): readonly string[] => {
	const prefix = snapshot.usageIsEstimated ? "~" : "";
	const percent =
		snapshot.contextWindow > 0 ? `${prefix}${((snapshot.usedTokens / snapshot.contextWindow) * 100).toFixed(1)}%` : "";
	const mix = segmentMixText(snapshot, 3);
	const mixShort = segmentMixText(snapshot, 2);
	const ch = usage.cacheHitRate !== undefined ? `CH${Math.round(usage.cacheHitRate)}%` : "";
	const cost = formatCost(usage.cost);
	const options = ch
		? [
				metricGroup(percent, mix, efficiencyGroup(ch, cost)),
				metricGroup(percent, mix, ch),
				metricGroup(percent, mixShort, ch),
				metricGroup(percent, efficiencyGroup(ch, cost)),
				metricGroup(percent, ch),
				percent,
				ch,
				"",
			]
		: [
				metricGroup(percent, mix, cost),
				metricGroup(percent, mix),
				metricGroup(percent, mixShort),
				metricGroup(percent, cost),
				percent,
				cost,
				"",
			];

	return [...new Set(options)];
};

export const pickFirstFitting = (options: readonly string[], width: number): string => {
	for (const option of options) {
		if (plainWidth(option) <= width) return option;
	}

	return "";
};

const styleSegmentMix = (text: string): string => {
	let styled = foreground(FREE_SEGMENT_TEXT, "≈ ");
	const values = text.slice("≈ ".length).split(" ");

	for (const [index, value] of values.entries()) {
		const segment = USED_SEGMENTS.find((candidate) => candidate.label === value[0]);
		if (!segment) continue;
		if (index > 0) styled += foreground(FREE_SEGMENT_TEXT, " ");
		styled += foreground(segment.color, segment.label);
		styled += foreground(FREE_SEGMENT_TEXT, value.slice(segment.label.length));
	}

	return styled;
};

export const styleFreeMetrics = (plain: string, percent: number): string => {
	if (plain.length === 0) return "";

	const color = freeTextColor(percent);
	const tokens = plain.split(/( {2,})/);
	return tokens
		.map((token) => {
			if (/^ {2,}$/.test(token)) return foreground(FREE_SEGMENT_TEXT, token);
			if (token.startsWith("≈ ")) return styleSegmentMix(token);
			if (token.startsWith("CH")) return foreground(CACHE_HIT_TEXT, token);
			if (token.startsWith("$")) return foreground(COST_TEXT, token);
			if (token.includes("%")) return foreground(color, token);
			return foreground(FREE_SEGMENT_TEXT, token);
		})
		.join("");
};

const coloredCells = (color: string, glyph: string, count: number, cellWidth: number): string =>
	foreground(color, `${glyph}${" ".repeat(cellWidth - 1)}`.repeat(Math.max(0, count)));

const renderConsumedZone = (
	cellCount: number,
	ghostCellIndex: number | undefined,
	ghostColor: string | undefined,
	cellWidth: number,
): string => {
	if (!ghostColor || ghostCellIndex === undefined || ghostCellIndex < 0 || ghostCellIndex >= cellCount) {
		return " ".repeat(cellCount * cellWidth);
	}

	return `${" ".repeat(ghostCellIndex * cellWidth)}${coloredCells(ghostColor, GHOST_GLYPH, 1, cellWidth)}${" ".repeat(
		(cellCount - ghostCellIndex - 1) * cellWidth,
	)}`;
};

/**
 * Fixed-width lane. Pac-Man moves left → right as context fills.
 * Eaten pellets become empty space; cream pellets remain ahead. While the agent
 * runs, a phase-colored ghost chases just behind the truthful context boundary.
 */
export const renderPacmanLane = (
	snapshot: ContextSnapshot,
	width: number,
	animationFrame = 0,
	activity: LaneActivity = "idle",
): string => {
	if (width <= 0) return "";

	const frameIndex = Math.abs(Math.trunc(animationFrame)) % PACMAN_FRAMES.length;
	const pacmanGlyph = PACMAN_FRAMES[frameIndex] ?? PACMAN_GLYPH;
	if (width === 1) return foreground(PACMAN_TEXT, pacmanGlyph);

	const cellWidth = 2;
	const cellCount = Math.max(1, Math.floor(width / cellWidth));
	const ratio = snapshot.contextWindow > 0 ? Math.min(1, Math.max(0, snapshot.usedTokens / snapshot.contextWindow)) : 0;
	const consumedCellCount = Math.round(ratio * Math.max(0, cellCount - 1));
	const pelletCellCount = Math.max(0, cellCount - consumedCellCount - 1);
	const pacman = coloredCells(PACMAN_TEXT, pacmanGlyph, 1, cellWidth);
	const ghostColor = activity === "idle" ? undefined : LANE_ACTIVITY_TEXT[activity];
	const preferredGhostDistance = Math.floor(Math.abs(Math.trunc(animationFrame)) / 2) % 2 === 0 ? 2 : 3;
	const ghostDistance = Math.min(preferredGhostDistance, consumedCellCount);
	const ghostCellIndex = ghostColor && consumedCellCount >= 2 ? consumedCellCount - ghostDistance : undefined;
	const consumed = renderConsumedZone(consumedCellCount, ghostCellIndex, ghostColor, cellWidth);
	const pellets = coloredCells(PELLET_TEXT, PELLET_GLYPH, pelletCellCount, cellWidth);
	const remainder = " ".repeat(width - cellCount * cellWidth);

	return `${consumed}${pacman}${pellets}${remainder}`;
};

export const editorModelOptions = (model: ModelInfo, thinkingLevel: string): readonly string[] => {
	if (!model) return ["no-model", "?"];

	const id = model.id;
	const shortId = id.includes("/") ? (id.split("/").pop() ?? id) : id;
	const thinking = model.reasoning && thinkingLevel !== "off" ? thinkingLevel : "";
	const withThinking = thinking ? `${id} · ${thinking}` : id;
	const shortWithThinking = thinking ? `${shortId} · ${thinking}` : shortId;

	return [
		...new Set(
			[withThinking, shortWithThinking, shortId, shortId.length > 16 ? `${shortId.slice(0, 15)}…` : shortId].filter(
				Boolean,
			),
		),
	];
};

export const parseGitStatus = (output: string): GitState | null => {
	let branch: string | null = null;
	let detachedOid: string | null = null;
	let ahead = 0;
	let behind = 0;
	let staged = 0;
	let unstaged = 0;
	let untracked = 0;
	let sawStatus = false;

	for (const line of output.split("\n")) {
		if (!line) continue;
		sawStatus = true;
		if (line.startsWith("# branch.head ")) {
			const head = line.slice("# branch.head ".length).trim();
			branch = head && head !== "(detached)" ? head : null;
			continue;
		}
		if (line.startsWith("# branch.oid ")) {
			const oid = line.slice("# branch.oid ".length).trim();
			detachedOid = oid && oid !== "(initial)" ? oid.slice(0, 7) : null;
			continue;
		}
		if (line.startsWith("# branch.ab ")) {
			const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
			if (match) {
				ahead = Number.parseInt(match[1] ?? "0", 10);
				behind = Number.parseInt(match[2] ?? "0", 10);
			}
			continue;
		}
		if (line.startsWith("? ")) {
			untracked++;
			continue;
		}
		if (line.startsWith("1 ") || line.startsWith("2 ")) {
			const status = line.slice(2, 4);
			if ((status[0] ?? ".") !== ".") staged++;
			if ((status[1] ?? ".") !== ".") unstaged++;
			continue;
		}
		if (line.startsWith("u ")) unstaged++;
	}

	return sawStatus ? { branch, detachedOid, ahead, behind, staged, unstaged, untracked } : null;
};

export const gitLabelOptions = (git: GitState | null): readonly string[] => {
	if (!git) return [];
	const head = git.branch ?? (git.detachedOid ? `@${git.detachedOid}` : "");
	if (!head) return [];

	const changes = [
		git.staged > 0 ? `+${git.staged}` : "",
		git.unstaged > 0 ? `*${git.unstaged}` : "",
		git.untracked > 0 ? `?${git.untracked}` : "",
	].filter(Boolean);
	const sync = [git.ahead > 0 ? `↑${git.ahead}` : "", git.behind > 0 ? `↓${git.behind}` : ""].filter(Boolean);
	const branch = `⎇ ${head}`;
	const dirty = changes.length > 0 ? `${branch} ●` : branch;

	return [
		...new Set(
			[[branch, ...changes, ...sync].join(" "), [branch, ...changes].join(" "), dirty, branch].filter(Boolean),
		),
	];
};

export const pickEditorBorderLabels = (
	modelLabels: readonly string[],
	gitLabels: readonly string[],
	width: number,
): Readonly<{ modelLabel: string; gitLabel: string }> => {
	const fits = (modelLabel: string, gitLabel: string): boolean => {
		const leftWidth = modelLabel ? plainWidth(modelLabel) + 3 : 1;
		const rightWidth = gitLabel ? plainWidth(gitLabel) + 4 : 1;
		return 2 + leftWidth + rightWidth + 3 <= width;
	};

	for (const modelLabel of modelLabels) {
		for (const gitLabel of gitLabels) {
			if (fits(modelLabel, gitLabel)) return { modelLabel, gitLabel };
		}
	}
	for (const modelLabel of modelLabels) {
		if (fits(modelLabel, "")) return { modelLabel, gitLabel: "" };
	}

	return { modelLabel: "", gitLabel: "" };
};

export const renderLabeledBorder = (
	width: number,
	leftCorner: string,
	rightCorner: string,
	leftLabel: string,
	rightLabel: string,
	border: (text: string) => string,
): string => {
	if (width <= 0) return "";
	if (width === 1) return border("─");

	const left = leftLabel ? `${border("─")} ${leftLabel} ` : border("─");
	const right = rightLabel ? ` ${rightLabel} ${border("──")}` : border("─");
	const fillWidth = Math.max(0, width - 2 - plainWidth(left) - plainWidth(right));

	return `${border(leftCorner)}${left}${border("─".repeat(fillWidth))}${right}${border(rightCorner)}`;
};

export const renderChromeLine = (
	snapshot: ContextSnapshot,
	usage: SessionUsage,
	width: number,
	dim: (text: string) => string,
	animationFrame = 0,
	activity: LaneActivity = "idle",
): string => {
	if (width <= 0) return "";
	if (width <= 2) return fitStyledText(dim("·"), width);

	const contentWidth = width - 2;
	if (snapshot.contextWindow <= 0) {
		const unavailable = dim("ctx unavailable");
		return ` ${" ".repeat(Math.max(0, contentWidth - plainWidth(unavailable)))}${fitStyledText(unavailable, contentWidth)} `;
	}

	const percent = (snapshot.usedTokens / snapshot.contextWindow) * 100;
	const minimumLaneWidth = Math.min(12, Math.max(4, Math.floor(contentWidth * 0.35)));
	const metricWidth = Math.max(0, contentWidth - minimumLaneWidth - 2);
	const metricText = pickFirstFitting(freeMetricOptions(snapshot, usage), metricWidth);
	const minimumGap = metricText.length > 0 ? 2 : 0;
	const availableLaneWidth = Math.max(0, contentWidth - plainWidth(metricText) - minimumGap);
	const laneWidth = Math.min(PACMAN_LANE_MAX_WIDTH, availableLaneWidth);
	const flexibleGap = contentWidth - laneWidth - plainWidth(metricText);
	const lane = renderPacmanLane(snapshot, laneWidth, animationFrame, activity);
	const metrics = styleFreeMetrics(metricText, percent);

	return ` ${lane}${" ".repeat(Math.max(0, flexibleGap))}${metrics} `;
};
