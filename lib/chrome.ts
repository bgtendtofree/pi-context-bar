/** Pure Pac-Man lane, health metric formatting, and one-line layout. */

import {
	CONTEXT_SEGMENTS,
	type ContextSegmentKey,
	type ContextSnapshot,
	type SessionUsage,
	segmentTotal,
} from "./context.ts";
import { fitStyledText, foreground, plainWidth } from "./text.ts";

/** Classic arcade colors stay limited to game elements. */
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

export type ChromeStyles = Readonly<{
	dim: (text: string) => string;
	warning: (text: string) => string;
	error: (text: string) => string;
}>;

export type DominantSegment = Readonly<{
	key: ContextSegmentKey;
	name: string;
	percent: number;
}>;

export const dominantSegments = (snapshot: ContextSnapshot, limit = 3): readonly DominantSegment[] => {
	const total = segmentTotal(snapshot.segments);
	if (snapshot.usedTokens <= 0 || total <= 0 || limit <= 0) return [];

	const ranked = CONTEXT_SEGMENTS.map((segment, index) => ({
		key: segment.key,
		name: segment.name,
		percent: Math.round((snapshot.segments[segment.key] / total) * 100),
		index,
	}))
		.filter((segment) => segment.percent > 0)
		.sort((left, right) => right.percent - left.percent || left.index - right.index);
	const visible = ranked.slice(0, Math.min(2, limit));
	const third = ranked[2];
	if (limit >= 3 && third && third.percent >= 10) visible.push(third);
	return visible.map(({ key, name, percent }) => ({ key, name, percent }));
};

export const segmentMixText = (snapshot: ContextSnapshot, limit = 3): string => {
	const segments = dominantSegments(snapshot, limit);
	if (segments.length === 0) return "";
	return `≈ ${segments.map((segment) => `${segment.name} ${segment.percent}%`).join("  ")}`;
};

export const formatCost = (cost: number): string => {
	if (cost <= 0) return "";
	return `$${cost >= 1 ? cost.toFixed(2) : cost.toFixed(3)}`;
};

const metricGroup = (...parts: readonly string[]): string => parts.filter(Boolean).join("   ");
const efficiencyGroup = (ch: string, cost: string): string => [ch, cost].filter(Boolean).join("  ");

/** Metric options, widest → tightest. `%` and CH survive before mix and cost. */
export const freeMetricOptions = (snapshot: ContextSnapshot, usage: SessionUsage): readonly string[] => {
	const prefix = snapshot.usageIsEstimated ? "~" : "";
	const percent =
		snapshot.contextWindow > 0 ? `${prefix}${((snapshot.usedTokens / snapshot.contextWindow) * 100).toFixed(1)}%` : "";
	const mix = segmentMixText(snapshot);
	const mixShort = segmentMixText(snapshot, 1);
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
	for (const option of options) if (plainWidth(option) <= width) return option;
	return "";
};

const styleUsage = (text: string, percent: number, styles: ChromeStyles): string => {
	if (percent > 90) return styles.error(text);
	if (percent > 70) return styles.warning(text);
	return styles.dim(text);
};

const styleCache = (text: string, rate: number | undefined, styles: ChromeStyles): string => {
	if (rate === undefined || rate >= 80) return styles.dim(text);
	if (rate >= 50) return styles.warning(text);
	return styles.error(text);
};

export const styleFreeMetrics = (
	plain: string,
	percent: number,
	cacheHitRate: number | undefined,
	styles: ChromeStyles,
): string => {
	if (plain.length === 0) return "";
	return plain
		.split(/( {2,})/)
		.map((token) => {
			if (/^~?\d+(?:\.\d+)?%$/.test(token)) return styleUsage(token, percent, styles);
			if (token.startsWith("CH")) return styleCache(token, cacheHitRate, styles);
			return styles.dim(token);
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

/** Fixed-width truthful lane: empty consumed space, Pac-Man boundary, remaining pellets. */
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

export const renderChromeLine = (
	snapshot: ContextSnapshot,
	usage: SessionUsage,
	width: number,
	styles: ChromeStyles,
	animationFrame = 0,
	activity: LaneActivity = "idle",
): string => {
	if (width <= 0) return "";
	if (width <= 2) return fitStyledText(styles.dim("·"), width);

	const contentWidth = width - 2;
	if (snapshot.contextWindow <= 0) {
		const unavailable = styles.dim("ctx unavailable");
		const gap = " ".repeat(Math.max(0, contentWidth - plainWidth(unavailable)));
		return ` ${gap}${fitStyledText(unavailable, contentWidth)} `;
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
	const metrics = styleFreeMetrics(metricText, percent, usage.cacheHitRate, styles);
	return ` ${lane}${" ".repeat(Math.max(0, flexibleGap))}${metrics} `;
};

export { fitStyledText, foreground, plainWidth, stripAnsi } from "./text.ts";
