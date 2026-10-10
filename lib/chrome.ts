/** Pure Pac-Man lane, health metric formatting, and one-line layout. Theme tokens only. */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ContextSnapshot, SessionUsage } from "./context.ts";
import { formatTokenSpeed, type TokenSpeedSnapshot } from "./speed.ts";

export const PACMAN_GLYPH = "󰮯";
export const PACMAN_CLOSED_GLYPH = "●";
export const PACMAN_FRAMES = [PACMAN_GLYPH, PACMAN_CLOSED_GLYPH] as const;
export const GHOST_GLYPH = "󰊠";
export const PELLET_GLYPH = "•";
export const POWER_PELLET_GLYPH = "○";

/** Terminal glyph choices: Nerd Font icons by default, ASCII for terminals without the font. */
export type GlyphSet = Readonly<{
	pacmanOpen: string;
	pacmanClosed: string;
	ghost: string;
	promptReady: string;
	promptFailure: string;
	reset: string;
	credit: string;
	/** ASCII fallbacks compact their reset/credit tokens ("r52m", "R1"). */
	ascii: boolean;
}>;

export const NERD_GLYPHS: GlyphSet = {
	pacmanOpen: PACMAN_GLYPH,
	pacmanClosed: PACMAN_CLOSED_GLYPH,
	ghost: GHOST_GLYPH,
	promptReady: "❯",
	promptFailure: "✗",
	reset: "󰦛",
	credit: "󰔖",
	ascii: false,
};

export const ASCII_GLYPHS: GlyphSet = {
	pacmanOpen: "C",
	pacmanClosed: "O",
	ghost: "0",
	promptReady: ">",
	promptFailure: "x",
	reset: "r",
	credit: "R",
	ascii: true,
};

/** Lane ratios matching the warning/error metric thresholds. */
export const POWER_PELLET_RATIOS = [0.7, 0.9] as const;

export type LaneActivity = "idle" | "working" | "thinking" | "assistant" | "tools";

/** Ghost color by lane activity; Pac-Man uses text, pellets dim, power pellets muted. */
export const GHOST_TOKENS: Readonly<Record<Exclude<LaneActivity, "idle">, ThemeColor>> = {
	working: "muted",
	thinking: "warning",
	assistant: "success",
	tools: "accent",
};

/** Role-based theme painter; the editor binds it to the live theme's `fg`. */
export type ChromeStyles = Readonly<{ fg: (token: ThemeColor, text: string) => string }>;

/** Compact context-window size: 200_000 → 200K, 512 → 512. */
export const formatWindowSize = (tokens: number): string =>
	tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : `${tokens}`;

export const formatCost = (cost: number): string => {
	if (cost <= 0) return "";
	return `$${cost >= 1 ? cost.toFixed(2) : cost.toFixed(3)}`;
};

/** Compact remaining time: "2d 3h", "5h 10m", "12m", or "expired" once past. */
export const formatDuration = (ms: number): string => {
	if (ms <= 0) return "expired";
	const minutes = Math.floor(ms / 60_000);
	if (minutes === 0) return "<1m";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ${minutes % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

const tint = (text: string, token: ThemeColor, styles: ChromeStyles): string => (text ? styles.fg(token, text) : "");

/** Color health metrics by usage: error > 90%, warning > 70%, else quiet dim. */
export const styleUsage = (text: string, percent: number, styles: ChromeStyles): string => {
	if (percent > 90) return styles.fg("error", text);
	if (percent > 70) return styles.fg("warning", text);
	return styles.fg("dim", text);
};

const styleCache = (text: string, rate: number | undefined, styles: ChromeStyles): string => {
	if (rate === undefined || rate >= 80) return styles.fg("dim", text);
	if (rate >= 50) return styles.fg("warning", text);
	return styles.fg("error", text);
};

/** Session average joins the CH label only when it diverges meaningfully from the latest turn. */
export const CH_AVG_DIVERGENCE_POINTS = 5;

/** CH label: latest turn's rate, with the token-weighted session average appended when it diverges. */
const cacheLabel = (usage: SessionUsage, styles: ChromeStyles): string => {
	const latest = usage.cacheHitRate;
	if (latest === undefined) return "";
	const avg = usage.cacheHitRateAvg;
	const diverged = avg !== undefined && Math.abs(latest - avg) > CH_AVG_DIVERGENCE_POINTS;
	const latestPart = styleCache(`CH${Math.round(latest)}`, latest, styles);
	const avgPart = diverged ? styles.fg("dim", `/${Math.round(avg)}`) : "";
	return `${latestPart}${avgPart}%`;
};

/** Cache/cost options, widest → tightest, styled at construction. CH survives before cost. */
export const freeMetricOptions = (usage: SessionUsage, styles: ChromeStyles): readonly string[] => {
	const ch = cacheLabel(usage, styles);
	const cost = tint(formatCost(usage.cost), "dim", styles);
	return [[ch, cost].filter(Boolean).join(styles.fg("dim", "  ")), ch, ""];
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
export const quotaMetricOptions = (
	usage: QuotaUsage,
	styles: ChromeStyles,
	now = Date.now(),
	glyphs: GlyphSet = NERD_GLYPHS,
): readonly string[] => {
	const styledUsage = (text: string, percent: number): string => styleUsage(text, percent, styles);
	const weekly =
		usage.weeklyPercent !== undefined ? styledUsage(`W${Math.round(usage.weeklyPercent)}%`, usage.weeklyPercent) : "";
	// Nerd icons breathe ("󰦛 52m"); ASCII tokens stay compact ("r52m").
	const token = (icon: string, value: string): string =>
		styles.fg("dim", glyphs.ascii ? `${icon}${value}` : `${icon} ${value}`);
	const renderLimits = (withReset: boolean): string =>
		usage.limits
			.map((limit) => {
				const base = styledUsage(`${limit.label} ${Math.round(limit.percent)}%`, limit.percent);
				const remaining = limit.resetAt !== undefined ? limit.resetAt - now : undefined;
				const reset =
					withReset && remaining !== undefined && remaining > 0
						? ` ${token(glyphs.reset, formatDuration(remaining))}`
						: "";
				return base + reset;
			})
			.join(styles.fg("dim", "  "));
	const limits = renderLimits(true);
	const plainLimits = renderLimits(false);
	// Banked resets are quiet chrome; zero or unknown stays hidden.
	const resets = usage.resetCredits ? token(glyphs.credit, `${usage.resetCredits}`) : "";
	const candidates = [
		[weekly, limits, resets].filter(Boolean).join(styles.fg("dim", "  ")),
		...(limits === plainLimits ? [] : [[weekly, plainLimits, resets].filter(Boolean).join(styles.fg("dim", "  "))]),
		weekly || resets,
		"",
	];
	const options: string[] = [];
	for (const value of candidates) if (options.at(-1) !== value) options.push(value);
	return options;
};

/** One lane cell: glyph plus the remaining columns in its track. */
const laneCell = (token: ThemeColor, glyph: string, cellWidth: number, styles: ChromeStyles): string =>
	styles.fg(token, `${glyph}${" ".repeat(cellWidth - 1)}`);

/** Fixed-width truthful lane: empty consumed space, Pac-Man boundary, remaining pellets. */
export const renderPacmanLane = (
	snapshot: ContextSnapshot,
	width: number,
	styles: ChromeStyles,
	animationFrame = 0,
	activity: LaneActivity = "idle",
	glyphs: GlyphSet = NERD_GLYPHS,
): string => {
	if (width <= 0) return "";
	const frameIndex = activity === "idle" ? 0 : Math.abs(Math.trunc(animationFrame)) % PACMAN_FRAMES.length;
	const pacmanGlyph = frameIndex === 0 ? glyphs.pacmanOpen : glyphs.pacmanClosed;
	if (width === 1) return styles.fg("text", pacmanGlyph);

	// Wide lanes breathe more; narrow lanes keep finer usage resolution.
	const cellWidth = width >= 80 ? 3 : 2;
	const cellCount = Math.max(1, Math.floor(width / cellWidth));
	const ratio = snapshot.contextWindow > 0 ? Math.min(1, Math.max(0, snapshot.usedTokens / snapshot.contextWindow)) : 0;
	const consumedCellCount = Math.round(ratio * Math.max(0, cellCount - 1));
	const pelletCellCount = Math.max(0, cellCount - consumedCellCount - 1);
	const pacman = laneCell("text", pacmanGlyph, cellWidth, styles);
	const powerCells = new Set(
		POWER_PELLET_RATIOS.map((powerRatio) => Math.round(powerRatio * Math.max(0, cellCount - 1))),
	);
	const pellets = Array.from({ length: pelletCellCount }, (_, index) => {
		const power = powerCells.has(consumedCellCount + 1 + index);
		return laneCell(power ? "muted" : "dim", power ? POWER_PELLET_GLYPH : PELLET_GLYPH, cellWidth, styles);
	}).join("");
	const ghostToken = activity === "idle" ? undefined : GHOST_TOKENS[activity];
	const preferredGhostDistance = Math.floor(Math.abs(Math.trunc(animationFrame)) / 2) % 2 === 0 ? 2 : 3;
	const ghostDistance = Math.min(preferredGhostDistance, consumedCellCount);
	const ghostCellIndex = ghostToken && consumedCellCount >= 2 ? consumedCellCount - ghostDistance : undefined;
	const consumed =
		ghostToken && ghostCellIndex !== undefined
			? `${" ".repeat(ghostCellIndex * cellWidth)}${laneCell(ghostToken, glyphs.ghost, cellWidth, styles)}${" ".repeat(
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
	const percent = styleUsage(`${percentValue.toFixed(1)}%`, percentValue, styles);
	// Window size rides with the percent it is the denominator of; tight strips fall back to plain %.
	const percentOptions =
		snapshot.contextWindow > 0
			? [`${percent} ${styles.fg("dim", `(${formatWindowSize(snapshot.contextWindow)})`)}`, percent]
			: [];
	const rawSpeed = formatTokenSpeed(speed);
	const speedText = rawSpeed ? styles.fg("dim", rawSpeed) : "";
	const laneWidth = (pickedPercent: string | undefined, pickedSpeed: string | undefined): number =>
		width -
		2 -
		(pickedPercent ? visibleWidth(pickedPercent) + 1 : 0) -
		(pickedSpeed ? visibleWidth(pickedSpeed) + 1 : 0);
	let pickedPercent: string | undefined;
	let pickedSpeed = "";
	for (const candidate of percentOptions) {
		if (laneWidth(candidate, speedText) >= 4) {
			pickedPercent = candidate;
			pickedSpeed = speedText;
			break;
		}
		if (laneWidth(candidate, undefined) >= 4) {
			pickedPercent = candidate;
			pickedSpeed = "";
			break;
		}
	}
	if (!pickedPercent && laneWidth(undefined, speedText) >= 4) pickedSpeed = speedText;
	const lane = renderPacmanLane(
		snapshot,
		Math.max(0, laneWidth(pickedPercent, pickedSpeed)),
		styles,
		animationFrame,
		activity,
		glyphs,
	);
	return ` ${[lane, pickedPercent, pickedSpeed].filter(Boolean).join(" ")} `;
};
