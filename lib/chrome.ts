/** Pure Pac-Man lane, health metric formatting, and one-line layout. */

import type { ContextSnapshot, SessionUsage } from "./context.ts";
import { formatTokenSpeed, type TokenSpeedSnapshot } from "./speed.ts";
import { fitStyledText, foreground, plainWidth } from "./text.ts";

/** Classic arcade colors stay limited to game elements. */
export const PACMAN_TEXT = "#FFFF00";
export const PELLET_TEXT = "#FFB8AE";
export const PACMAN_FRAMES = ["󰮯", "●"] as const;
export const PACMAN_GLYPH = PACMAN_FRAMES[0];
export const GHOST_GLYPH = "󰊠";
export const PELLET_GLYPH = "•";
export const POWER_PELLET_GLYPH = "o";
/** Lane ratios matching the warning/error metric thresholds. */
export const POWER_PELLET_RATIOS = [0.7, 0.9] as const;
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

export const formatCost = (cost: number): string => {
	if (cost <= 0) return "";
	return `$${cost >= 1 ? cost.toFixed(2) : cost.toFixed(3)}`;
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

const styled = (text: string, style: (text: string) => string): string => (text ? style(text) : "");

/** Metric options, widest → tightest, styled at construction. `%` and CH survive before cost. */
export const freeMetricOptions = (
	snapshot: ContextSnapshot,
	usage: SessionUsage,
	styles: ChromeStyles,
	speed: TokenSpeedSnapshot | null = null,
): readonly string[] => {
	const percentValue = snapshot.contextWindow > 0 ? (snapshot.usedTokens / snapshot.contextWindow) * 100 : 0;
	const percent = styled(snapshot.contextWindow > 0 ? `${percentValue.toFixed(1)}%` : "", (text) =>
		styleUsage(text, percentValue, styles),
	);
	const ch = styled(usage.cacheHitRate !== undefined ? `CH${Math.round(usage.cacheHitRate)}%` : "", (text) =>
		styleCache(text, usage.cacheHitRate, styles),
	);
	const speedText = styled(formatTokenSpeed(speed), styles.dim);
	const cost = styled(formatCost(usage.cost), styles.dim);
	const metricGroup = (separator: string, ...parts: readonly string[]): string =>
		parts.filter(Boolean).join(styles.dim(separator));
	const core = metricGroup("  ", ch, speedText);
	const options = [
		metricGroup("   ", percent, metricGroup("  ", ch, speedText, cost)),
		metricGroup("   ", percent, core),
		percent,
		core || cost,
		"",
	];
	return [...new Set(options)];
};

export const pickFirstFitting = (options: readonly string[], width: number): string => {
	for (const option of options) if (plainWidth(option) <= width) return option;
	return "";
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
	const powerCells = new Set(
		POWER_PELLET_RATIOS.map((powerRatio) => Math.round(powerRatio * Math.max(0, cellCount - 1))),
	);
	const pelletCells = Array.from(
		{ length: pelletCellCount },
		(_, index) =>
			`${powerCells.has(consumedCellCount + 1 + index) ? POWER_PELLET_GLYPH : PELLET_GLYPH}${" ".repeat(cellWidth - 1)}`,
	).join("");
	const pellets = foreground(PELLET_TEXT, pelletCells);
	const ghostColor = activity === "idle" ? undefined : LANE_ACTIVITY_TEXT[activity];
	const preferredGhostDistance = Math.floor(Math.abs(Math.trunc(animationFrame)) / 2) % 2 === 0 ? 2 : 3;
	const ghostDistance = Math.min(preferredGhostDistance, consumedCellCount);
	const ghostCellIndex = ghostColor && consumedCellCount >= 2 ? consumedCellCount - ghostDistance : undefined;
	const consumed = renderConsumedZone(consumedCellCount, ghostCellIndex, ghostColor, cellWidth);
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
	speed: TokenSpeedSnapshot | null = null,
): string => {
	if (width <= 0) return "";
	if (width <= 2) return fitStyledText(styles.dim("·"), width);

	const contentWidth = width - 2;
	if (snapshot.contextWindow <= 0) {
		const unavailable = styles.dim("ctx unavailable");
		const gap = " ".repeat(Math.max(0, contentWidth - plainWidth(unavailable)));
		return ` ${gap}${fitStyledText(unavailable, contentWidth)} `;
	}

	const minimumLaneWidth = Math.min(12, Math.max(4, Math.floor(contentWidth * 0.35)));
	const metricWidth = Math.max(0, contentWidth - minimumLaneWidth - 2);
	const metrics = pickFirstFitting(freeMetricOptions(snapshot, usage, styles, speed), metricWidth);
	const minimumGap = metrics.length > 0 ? 2 : 0;
	const availableLaneWidth = Math.max(0, contentWidth - plainWidth(metrics) - minimumGap);
	const laneWidth = Math.min(PACMAN_LANE_MAX_WIDTH, availableLaneWidth);
	const flexibleGap = contentWidth - laneWidth - plainWidth(metrics);
	const lane = renderPacmanLane(snapshot, laneWidth, animationFrame, activity);
	return ` ${lane}${" ".repeat(Math.max(0, flexibleGap))}${metrics} `;
};
