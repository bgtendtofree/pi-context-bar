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
	/** Provider badges: cod-openai `\uec81` / cod-claude `\uec82`, Nerd Font v3.5.0+. Empty when ASCII. */
	providerOpenai: string;
	providerAnthropic: string;
	/** Cache-hit database md-database `\u{f01bc}`; replaces the `CH` label in Nerd mode. */
	cache: string;
	/** Speedometer md-speedometer `\u{f04c5}`; never shown without `t/s`. */
	speed: string;
	/** ASCII fallbacks compact their reset/credit tokens ("r52m", "R1") and omit icons. */
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
	providerOpenai: "\uec81",
	providerAnthropic: "\uec82",
	cache: "\u{f01bc}",
	speed: "\u{f04c5}",
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
	providerOpenai: "",
	providerAnthropic: "",
	cache: "",
	speed: "",
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

/**
 * Lane activity after Pi assembles context. Pi also emits `context` mid-tool, so an active tool or
 * streaming phase must survive; only a fresh model turn promotes to thinking. Without this the
 * ghost flickers tools → thinking → tools inside one tool loop.
 */
export const activityAfterContext = (current: LaneActivity): LaneActivity =>
	current === "working" ? "thinking" : current;

/** Role-based theme painter; the editor binds it to the live theme's `fg`. */
export type ChromeStyles = Readonly<{ fg: (token: ThemeColor, text: string) => string }>;

/** Compact context-window size: 200_000 → 200K, 512 → 512. */
export const formatWindowSize = (tokens: number): string => {
	const thousands = Math.round(tokens / 1000);
	if (thousands >= 1000) {
		const millions = thousands / 1000;
		return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
	}
	return tokens >= 1000 ? `${thousands}K` : `${tokens}`;
};

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
	const remainingMinutes = minutes % 60;
	if (hours < 24) return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
	const days = Math.floor(hours / 24);
	const remainingHours = hours % 24;
	return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
};

const tint = (text: string, token: ThemeColor, styles: ChromeStyles): string => (text ? styles.fg(token, text) : "");

/** Used percent above which health metrics warn; shared by context usage and quota windows. */
export const USAGE_WARNING_PERCENT = 70;

/** Color health metrics by usage: error > 90%, warning > 70%, else quiet dim. */
export const styleUsage = (text: string, percent: number, styles: ChromeStyles): string => {
	if (percent > 90) return styles.fg("error", text);
	if (percent > USAGE_WARNING_PERCENT) return styles.fg("warning", text);
	return styles.fg("dim", text);
};

const styleCache = (text: string, rate: number | undefined, styles: ChromeStyles): string => {
	if (rate === undefined || rate >= 80) return styles.fg("dim", text);
	if (rate >= 50) return styles.fg("warning", text);
	return styles.fg("error", text);
};

/** Session average joins the CH label only when it diverges meaningfully from the latest turn. */
export const CH_AVG_DIVERGENCE_POINTS = 5;

/**
 * Cache-hit label variants, widest → tightest. Nerd mode leads with the md-database icon
 * (`󰆼 98/94%`); the icon is decorative and drops before the numbers, never the average.
 * ASCII keeps the `CH` label (`CH98/94%`). The latest turn keeps its warning/error color;
 * the average stays dim.
 */
const cacheLabelOptions = (usage: SessionUsage, styles: ChromeStyles, glyphs: GlyphSet): readonly string[] => {
	const latest = usage.cacheHitRate;
	if (latest === undefined) return [];
	const avg = usage.cacheHitRateAvg;
	const diverged = avg !== undefined && Math.abs(latest - avg) > CH_AVG_DIVERGENCE_POINTS;
	const avgPart = diverged ? styles.fg("dim", `/${Math.round(avg)}`) : "";
	const withIcon = styleCache(`${glyphs.cache} ${Math.round(latest)}`, latest, styles);
	const withoutIcon = styleCache(`${glyphs.cache ? "" : "CH"}${Math.round(latest)}`, latest, styles);
	return glyphs.cache ? [`${withIcon}${avgPart}%`, `${withoutIcon}${avgPart}%`] : [`${withoutIcon}${avgPart}%`];
};

/** Cache/cost options, widest → tightest, styled at construction. CH survives before cost. */
export const freeMetricOptions = (
	usage: SessionUsage,
	styles: ChromeStyles,
	glyphs: GlyphSet = NERD_GLYPHS,
): readonly string[] => {
	const cost = tint(formatCost(usage.cost), "dim", styles);
	const gap = styles.fg("dim", "  ");
	const caches = cacheLabelOptions(usage, styles, glyphs);
	const withCost = caches.length > 0 ? caches.map((ch) => `${ch}${gap}${cost}`) : [cost];
	const candidates = [...(cost ? withCost : []), ...caches, ""];
	const options: string[] = [];
	for (const value of candidates) if (options.at(-1) !== value) options.push(value);
	return options;
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

/**
 * Quota label split for the bottom border. `essentials` are window percentages, widest →
 * tightest, and never carry countdowns or credits. `upgrades` are optional enrichments of an
 * essential label (countdowns, credits), richest → narrowest, to be used only while model,
 * window percentages, and cache/cost still fit. Healthy windows stay percentage-only; a window
 * above the warning threshold shows its future countdown, and banked credits show only while any
 * reported quota is above the warning threshold.
 */
export type QuotaRender = Readonly<{
	essentials: readonly string[];
	upgrades: readonly string[];
}>;

export const quotaRender = (
	usage: QuotaUsage,
	styles: ChromeStyles,
	now = Date.now(),
	glyphs: GlyphSet = NERD_GLYPHS,
): QuotaRender => {
	const styledUsage = (text: string, percent: number): string => styleUsage(text, percent, styles);
	const gap = styles.fg("dim", "  ");
	const weekly =
		usage.weeklyPercent !== undefined ? styledUsage(`W${Math.round(usage.weeklyPercent)}%`, usage.weeklyPercent) : "";
	// Nerd icons breathe ("󰦛 52m"); ASCII tokens stay compact ("r52m").
	const token = (icon: string, value: string): string =>
		styles.fg("dim", glyphs.ascii ? `${icon}${value}` : `${icon} ${value}`);
	const renderLimit = (limit: QuotaLimit, withCountdown: boolean): string => {
		const base = styledUsage(`${limit.label} ${Math.round(limit.percent)}%`, limit.percent);
		const remaining = limit.resetAt !== undefined ? limit.resetAt - now : undefined;
		const countdown =
			withCountdown && limit.percent > USAGE_WARNING_PERCENT && remaining !== undefined && remaining > 0
				? ` ${token(glyphs.reset, formatDuration(remaining))}`
				: "";
		return base + countdown;
	};
	const fullLimits = usage.limits.map((limit) => renderLimit(limit, true)).join(gap);
	const plainLimits = usage.limits.map((limit) => renderLimit(limit, false)).join(gap);
	const anyHigh = [usage.weeklyPercent, ...usage.limits.map((limit) => limit.percent)].some(
		(percent) => percent !== undefined && percent > USAGE_WARNING_PERCENT,
	);
	// Banked resets are quiet chrome; zero, unknown, and healthy sessions keep them hidden.
	const resets =
		usage.resetCredits !== undefined && usage.resetCredits > 0 && anyHigh
			? token(glyphs.credit, `${usage.resetCredits}`)
			: "";
	const group = (...parts: readonly string[]): string => parts.filter(Boolean).join(gap);
	const dedupe = (values: readonly string[]): string[] => {
		const unique: string[] = [];
		for (const value of values) if (!unique.includes(value)) unique.push(value);
		return unique;
	};
	const essentials = dedupe([group(weekly, plainLimits), weekly, ""]);
	const upgrades = dedupe([
		resets ? group(weekly, fullLimits, resets) : "",
		fullLimits === plainLimits ? "" : group(weekly, fullLimits),
		resets ? group(weekly, plainLimits, resets) : "",
	])
		.filter((value) => value !== "" && !essentials.includes(value))
		.sort((left, right) => visibleWidth(right) - visibleWidth(left));
	return { essentials, upgrades };
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
	// The speedometer is decorative: try it, then plain `t/s`, then drop speed entirely.
	const speedOptions = rawSpeed
		? [glyphs.speed ? `${glyphs.speed} ${rawSpeed}` : rawSpeed, rawSpeed].filter(
				(value, index, all) => all.indexOf(value) === index,
			)
		: [];
	const styleSpeed = (value: string): string => (value ? styles.fg("dim", value) : "");
	const laneWidth = (pickedPercent: string | undefined, pickedSpeed: string | undefined): number =>
		width -
		2 -
		(pickedPercent ? visibleWidth(pickedPercent) + 1 : 0) -
		(pickedSpeed ? visibleWidth(pickedSpeed) + 1 : 0);
	let pickedPercent: string | undefined;
	let pickedSpeed = "";
	for (const candidate of percentOptions) {
		for (const option of speedOptions) {
			if (laneWidth(candidate, option) >= 4) {
				pickedPercent = candidate;
				pickedSpeed = styleSpeed(option);
				break;
			}
		}
		if (pickedPercent) break;
		if (laneWidth(candidate, undefined) >= 4) {
			pickedPercent = candidate;
			pickedSpeed = "";
			break;
		}
	}
	if (!pickedPercent) {
		for (const option of speedOptions) {
			if (laneWidth(undefined, option) >= 4) {
				pickedSpeed = styleSpeed(option);
				break;
			}
		}
	}
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
