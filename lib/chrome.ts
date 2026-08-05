/** Pure Pac-Man lane, health metric formatting, and one-line layout. */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { ContextSnapshot, SessionUsage } from "./context.ts";
import { formatTokenSpeed, type TokenSpeedSnapshot } from "./speed.ts";

/** True-color foreground escape; classic arcade colors stay limited to game elements. */
export const foreground = (hex: string, text: string): string => {
	const value = Number.parseInt(hex.replace(/^#/, ""), 16);
	const red = (value >> 16) & 0xff;
	const green = (value >> 8) & 0xff;
	const blue = value & 0xff;
	return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
};

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

/** Frames per full breath cycle; ticks at ~150ms give a ~1.8s inhale/exhale. */
export const BREATH_STEPS = 12;
/** Grayscale ramp bounds: quiet dark gray up to visible light gray, never a color. */
const BREATH_GRAY_MIN = 239;
const BREATH_GRAY_MAX = 247;

/** Breathing border styler: sine over the 256-color grayscale ramp, driven by breath frames. */
export const breathingBorderColor = (frame: number): ((text: string) => string) => {
	const phase = (Math.abs(Math.trunc(frame)) % BREATH_STEPS) / BREATH_STEPS;
	const gray = Math.round(
		BREATH_GRAY_MIN + (BREATH_GRAY_MAX - BREATH_GRAY_MIN) * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase)),
	);
	return (text) => `\x1b[38;5;${gray}m${text}\x1b[39m`;
};

/** Compact context-window size: 200_000 → 200K, 512 → 512. */
export const formatWindowSize = (tokens: number): string =>
	tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : `${tokens}`;

export const formatCost = (cost: number): string => {
	if (cost <= 0) return "";
	return `$${cost >= 1 ? cost.toFixed(2) : cost.toFixed(3)}`;
};

/** Dollar balances floor at zero and stay quiet when unknown or empty. */
export const formatDollarBalance = (dollars: number | undefined): string =>
	dollars !== undefined && dollars > 0 ? `$${dollars.toFixed(2)}` : "";

export const styleUsage = (text: string, percent: number, styles: ChromeStyles): string => {
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

/** Cache/cost options, widest → tightest, styled at construction. CH survives before cost. */
export const freeMetricOptions = (usage: SessionUsage, styles: ChromeStyles): readonly string[] => {
	const ch = styled(usage.cacheHitRate !== undefined ? `CH${Math.round(usage.cacheHitRate)}%` : "", (text) =>
		styleCache(text, usage.cacheHitRate, styles),
	);
	const cost = styled(formatCost(usage.cost), styles.dim);
	return [[ch, cost].filter(Boolean).join(styles.dim("  ")), ch, ""];
};

export type QuotaLimit = Readonly<{
	label: string;
	/** Used percent 0–100 of this limit window. */
	percent: number;
}>;

/** Shared subscription-quota snapshot; each provider parser fills the parts its plan reports. */
export type QuotaUsage = Readonly<{
	/** Used percent 0–100 of the weekly quota, undefined when the plan reports none. */
	weeklyPercent: number | undefined;
	limits: readonly QuotaLimit[];
	/** Banked usage-limit reset credits (OpenAI Codex plans); absent on providers without resets. */
	resetCredits?: number;
	/** Remaining key balance in dollars (OpenRouter limited keys); unlimited keys report spentDollars instead. */
	balanceDollars?: number;
	/** Lifetime spend in dollars (OpenRouter unlimited keys). */
	spentDollars?: number;
}>;

/** Quota metric variants, widest → tightest, styled at construction. Weekly survives before limits. */
export const quotaMetricOptions = (usage: QuotaUsage, styles: ChromeStyles): readonly string[] => {
	const styledUsage = (text: string, percent: number): string => styleUsage(text, percent, styles);
	const weekly =
		usage.weeklyPercent !== undefined ? styledUsage(`W${Math.round(usage.weeklyPercent)}%`, usage.weeklyPercent) : "";
	const limits = usage.limits
		.map((limit) => styledUsage(`${limit.label}${Math.round(limit.percent)}%`, limit.percent))
		.join(styles.dim(" "));
	// Banked resets and dollar balances are quiet chrome; zero or unknown stays hidden.
	const resets = usage.resetCredits ? styles.dim(`R${usage.resetCredits}`) : "";
	const balance = styled(formatDollarBalance(usage.balanceDollars), styles.dim);
	const spent = styled(usage.spentDollars !== undefined ? `used$${usage.spentDollars.toFixed(2)}` : "", styles.dim);
	return [
		[weekly, limits, resets, balance, spent].filter(Boolean).join(styles.dim(" ")),
		[weekly || resets, balance || spent].filter(Boolean).join(styles.dim(" ")),
		"",
	];
};

const coloredCells = (color: string, glyph: string, count: number, cellWidth: number): string =>
	foreground(color, `${glyph}${" ".repeat(cellWidth - 1)}`.repeat(Math.max(0, count)));

/** Fixed-width truthful lane: empty consumed space, Pac-Man boundary, remaining pellets. */
export const renderPacmanLane = (
	snapshot: ContextSnapshot,
	width: number,
	animationFrame = 0,
	activity: LaneActivity = "idle",
): string => {
	if (width <= 0) return "";
	const frameIndex = activity === "idle" ? 0 : Math.abs(Math.trunc(animationFrame)) % PACMAN_FRAMES.length;
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
	const consumed =
		ghostColor && ghostCellIndex !== undefined
			? `${" ".repeat(ghostCellIndex * cellWidth)}${coloredCells(ghostColor, GHOST_GLYPH, 1, cellWidth)}${" ".repeat(
					(consumedCellCount - ghostCellIndex - 1) * cellWidth,
				)}`
			: " ".repeat(consumedCellCount * cellWidth);
	const remainder = " ".repeat(width - cellCount * cellWidth);
	return `${consumed}${pacman}${pellets}${remainder}`;
};

/** Top-border strip: auto-fit lane with context `%` (+ window size), quiet speed at the right end. */
export const renderLaneStrip = (
	snapshot: ContextSnapshot,
	width: number,
	styles: ChromeStyles,
	animationFrame = 0,
	activity: LaneActivity = "idle",
	speed: TokenSpeedSnapshot | null = null,
): string => {
	if (width <= 2) return "";
	const percentValue = snapshot.contextWindow > 0 ? (snapshot.usedTokens / snapshot.contextWindow) * 100 : 0;
	const styledPercent = (text: string): string => styled(text, (value) => styleUsage(value, percentValue, styles));
	// Window size rides with the percent it is the denominator of; tight strips fall back to plain %.
	const percentOptions =
		snapshot.contextWindow > 0
			? [
					styledPercent(`${percentValue.toFixed(1)}% (${formatWindowSize(snapshot.contextWindow)})`),
					styledPercent(`${percentValue.toFixed(1)}%`),
				]
			: [];
	const speedText = styled(formatTokenSpeed(speed), styles.dim);
	const laneWidth = (percent: string | undefined, speed: string | undefined): number =>
		width - 2 - (percent ? visibleWidth(percent) + 1 : 0) - (speed ? visibleWidth(speed) + 1 : 0);
	let pickedPercent: string | undefined;
	let pickedSpeed = speedText;
	for (const candidate of percentOptions) {
		if (laneWidth(candidate, pickedSpeed) >= 4) {
			pickedPercent = candidate;
			break;
		}
		if (laneWidth(candidate, undefined) >= 4) {
			pickedPercent = candidate;
			pickedSpeed = "";
			break;
		}
	}
	const lane = renderPacmanLane(snapshot, Math.max(0, laneWidth(pickedPercent, pickedSpeed)), animationFrame, activity);
	return ` ${[lane, pickedPercent, pickedSpeed].filter(Boolean).join(" ")} `;
};
