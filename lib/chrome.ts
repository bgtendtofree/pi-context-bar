/** Pure Pac-Man lane, health metric formatting, and one-line layout. */

import { parseColor, styleText, visibleWidth } from "@earendil-works/pi-tui";
import type { ContextSnapshot, SessionUsage } from "./context.ts";
import { formatTokenSpeed, type TokenSpeedSnapshot } from "./speed.ts";

/** Native color formatting for standalone renders; the editor supplies its active theme. */
export const foreground = (hex: string, text: string): string => styleText(text, { fg: parseColor(hex) }, "truecolor");

/** Classic arcade colors stay limited to game elements. */
export const PACMAN_TEXT = "#FFFF00";
export const PELLET_TEXT = "#FFB8AE";
export const PACMAN_GLYPH = "󰮯";
export const PACMAN_CLOSED_GLYPH = "●";
export const PACMAN_FRAMES = [PACMAN_GLYPH, PACMAN_CLOSED_GLYPH] as const;
export const GHOST_GLYPH = "󰊠";
export const PELLET_GLYPH = "•";
export const POWER_PELLET_GLYPH = "o";

/** Terminal glyph choices: Nerd Font icons by default, ASCII for terminals without the font. */
export type GlyphSet = Readonly<{
	pacmanOpen: string;
	pacmanClosed: string;
	ghost: string;
}>;

export const NERD_GLYPHS: GlyphSet = {
	pacmanOpen: PACMAN_GLYPH,
	pacmanClosed: PACMAN_CLOSED_GLYPH,
	ghost: GHOST_GLYPH,
};

export const ASCII_GLYPHS: GlyphSet = { pacmanOpen: "C", pacmanClosed: "O", ghost: "0" };
/** Lane ratios matching the warning/error metric thresholds. */
export const POWER_PELLET_RATIOS = [0.7, 0.9] as const;

export const LANE_ACTIVITY_TEXT = {
	working: "#FF0000",
	thinking: "#FFB852",
	assistant: "#00FFFF",
	tools: "#5B5BFF",
} as const;

export type LaneActivity = "idle" | keyof typeof LANE_ACTIVITY_TEXT;

/** Arcade colors for the lane; classic warm hues on dark, darkened variants on light terminals. */
export type ArcadePalette = Readonly<{
	pacman: string;
	pellet: string;
	ghosts: Readonly<Record<keyof typeof LANE_ACTIVITY_TEXT, string>>;
}>;

/** Classic arcade palette: bright yellow Pac-Man, cream pellets, saturated ghost phase colors. */
export const DARK_ARCADE: ArcadePalette = {
	pacman: PACMAN_TEXT,
	pellet: PELLET_TEXT,
	ghosts: LANE_ACTIVITY_TEXT,
};

/** Light-terminal palette: yellow/cream vanish on pale backgrounds, so darken to goldenrod and sienna. */
const LIGHT_ARCADE: ArcadePalette = {
	pacman: "#B8860B",
	pellet: "#9C4A1E",
	ghosts: { working: "#C2181B", thinking: "#B25E00", assistant: "#00707D", tools: "#3B4FB5" },
};

/** Lane palette for a theme appearance; unknown appearances keep the classic dark palette. */
export const arcadePalette = (appearance: "dark" | "light" | undefined): ArcadePalette =>
	appearance === "light" ? LIGHT_ARCADE : DARK_ARCADE;

export type ChromeStyles = Readonly<{
	dim: (text: string) => string;
	warning: (text: string) => string;
	error: (text: string) => string;
	foreground?: typeof foreground;
	/** Theme background the chrome paints on; light switches the lane to the darkened arcade palette. */
	appearance?: "dark" | "light";
}>;

/** Compact context-window size: 200_000 → 200K, 512 → 512. */
export const formatWindowSize = (tokens: number): string =>
	tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : `${tokens}`;

export const formatCost = (cost: number): string => {
	if (cost <= 0) return "";
	return `$${cost >= 1 ? cost.toFixed(2) : cost.toFixed(3)}`;
};

/** Compact remaining time: "2d 3h", "5h 10m", "12m", or "expired" once past. */
export const formatDuration = (ms: number): string => {
	const minutes = Math.floor(ms / 60_000);
	if (minutes <= 0) return "expired";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

/** Color health metrics by usage: error > 90%, warning > 70%, else quiet dim. */
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

/** Session average joins the CH label only when it diverges meaningfully from the latest turn. */
export const CH_AVG_DIVERGENCE_POINTS = 5;

/** CH label: latest turn's rate, with the token-weighted session average appended when it diverges. */
const cacheLabel = (usage: SessionUsage, styles: ChromeStyles): string => {
	const latest = usage.cacheHitRate;
	if (latest === undefined) return "";
	const avg = usage.cacheHitRateAvg;
	const diverged = avg !== undefined && Math.abs(latest - avg) > CH_AVG_DIVERGENCE_POINTS;
	const latestPart = styleCache(`CH${Math.round(latest)}`, latest, styles);
	const avgPart = diverged ? styles.dim(`/${Math.round(avg)}`) : "";
	return `${latestPart}${avgPart}%`;
};

/** Cache/cost options, widest → tightest, styled at construction. CH survives before cost. */
export const freeMetricOptions = (usage: SessionUsage, styles: ChromeStyles): readonly string[] => {
	const ch = cacheLabel(usage, styles);
	const cost = styled(formatCost(usage.cost), styles.dim);
	return [[ch, cost].filter(Boolean).join(styles.dim("  ")), ch, ""];
};

export type QuotaLimit = Readonly<{
	label: string;
	/** Used percent 0–100 of this limit window. */
	percent: number;
	/** Epoch ms when this window resets; undefined when the provider omits it. */
	resetAt?: number;
}>;

/** Shared subscription-quota snapshot; each provider parser fills the parts its plan reports. */
export type QuotaUsage = Readonly<{
	/** Used percent 0–100 of the weekly quota, undefined when the plan reports none. */
	weeklyPercent: number | undefined;
	limits: readonly QuotaLimit[];
	/** Banked usage-limit reset credits (OpenAI Codex plans); absent on providers without resets. */
	resetCredits?: number;
}>;

/** Empty snapshot for absent or unparseable payloads. */
export const EMPTY_QUOTA: QuotaUsage = { weeklyPercent: undefined, limits: [] };

/** Quota metric variants, widest → tightest, styled at construction. Weekly survives before limits. */
export const quotaMetricOptions = (usage: QuotaUsage, styles: ChromeStyles, now = Date.now()): readonly string[] => {
	const styledUsage = (text: string, percent: number): string => styleUsage(text, percent, styles);
	const weekly =
		usage.weeklyPercent !== undefined ? styledUsage(`W${Math.round(usage.weeklyPercent)}%`, usage.weeklyPercent) : "";
	const renderLimits = (withReset: boolean): string =>
		usage.limits
			.map((limit) => {
				const base = styledUsage(`${limit.label}${Math.round(limit.percent)}%`, limit.percent);
				const remaining = limit.resetAt !== undefined ? limit.resetAt - now : undefined;
				const reset =
					withReset && remaining !== undefined && remaining > 0
						? ` ${styles.dim(`↻${formatDuration(remaining)}`)}`
						: "";
				return base + reset;
			})
			.join(styles.dim(" "));
	const limits = renderLimits(true);
	const plainLimits = renderLimits(false);
	// Banked resets are quiet chrome; zero or unknown stays hidden.
	const resets = usage.resetCredits ? styles.dim(`R${usage.resetCredits}`) : "";
	const candidates = [
		[weekly, limits, resets].filter(Boolean).join(styles.dim(" ")),
		...(limits === plainLimits ? [] : [[weekly, plainLimits, resets].filter(Boolean).join(styles.dim(" "))]),
		weekly || resets,
		"",
	];
	const options: string[] = [];
	for (const value of candidates) if (options.at(-1) !== value) options.push(value);
	return options;
};

const coloredCells = (
	color: string,
	glyph: string,
	count: number,
	cellWidth: number,
	paint: typeof foreground,
): string => paint(color, `${glyph}${" ".repeat(cellWidth - 1)}`.repeat(Math.max(0, count)));

/** Fixed-width truthful lane: empty consumed space, Pac-Man boundary, remaining pellets. */
export const renderPacmanLane = (
	snapshot: ContextSnapshot,
	width: number,
	animationFrame = 0,
	activity: LaneActivity = "idle",
	glyphs: GlyphSet = NERD_GLYPHS,
	paint: typeof foreground = foreground,
	palette: ArcadePalette = DARK_ARCADE,
): string => {
	if (width <= 0) return "";
	const frameIndex = activity === "idle" ? 0 : Math.abs(Math.trunc(animationFrame)) % PACMAN_FRAMES.length;
	const pacmanGlyph = frameIndex === 0 ? glyphs.pacmanOpen : glyphs.pacmanClosed;
	if (width === 1) return paint(palette.pacman, pacmanGlyph);

	const cellWidth = 2;
	const cellCount = Math.max(1, Math.floor(width / cellWidth));
	const ratio = snapshot.contextWindow > 0 ? Math.min(1, Math.max(0, snapshot.usedTokens / snapshot.contextWindow)) : 0;
	const consumedCellCount = Math.round(ratio * Math.max(0, cellCount - 1));
	const pelletCellCount = Math.max(0, cellCount - consumedCellCount - 1);
	const pacman = coloredCells(palette.pacman, pacmanGlyph, 1, cellWidth, paint);
	const powerCells = new Set(
		POWER_PELLET_RATIOS.map((powerRatio) => Math.round(powerRatio * Math.max(0, cellCount - 1))),
	);
	const pelletCells = Array.from(
		{ length: pelletCellCount },
		(_, index) =>
			`${powerCells.has(consumedCellCount + 1 + index) ? POWER_PELLET_GLYPH : PELLET_GLYPH}${" ".repeat(cellWidth - 1)}`,
	).join("");
	const pellets = paint(palette.pellet, pelletCells);
	const ghostColor = activity === "idle" ? undefined : palette.ghosts[activity];
	const preferredGhostDistance = Math.floor(Math.abs(Math.trunc(animationFrame)) / 2) % 2 === 0 ? 2 : 3;
	const ghostDistance = Math.min(preferredGhostDistance, consumedCellCount);
	const ghostCellIndex = ghostColor && consumedCellCount >= 2 ? consumedCellCount - ghostDistance : undefined;
	const consumed =
		ghostColor && ghostCellIndex !== undefined
			? `${" ".repeat(ghostCellIndex * cellWidth)}${coloredCells(ghostColor, glyphs.ghost, 1, cellWidth, paint)}${" ".repeat(
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
	glyphs: GlyphSet = NERD_GLYPHS,
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
	const lane = renderPacmanLane(
		snapshot,
		Math.max(0, laneWidth(pickedPercent, pickedSpeed)),
		animationFrame,
		activity,
		glyphs,
		styles.foreground ?? foreground,
		arcadePalette(styles.appearance),
	);
	return ` ${[lane, pickedPercent, pickedSpeed].filter(Boolean).join(" ")} `;
};
