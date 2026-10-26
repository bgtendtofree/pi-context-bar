/** Pure Pac-Man lane, health metric formatting, and one-line layout. Theme tokens only. */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ContextSnapshot, SessionUsage } from "./context.ts";
import { formatTokenSpeed, type TokenSpeedSnapshot } from "./speed.ts";

export const PACMAN_GLYPH = "󰮯";
export const PACMAN_CLOSED_GLYPH = "󰝥";
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
	/** Cache-hit database md-database `\u{f01bc}`; replaces the `CH` label in Nerd mode. */
	cache: string;
	/** Speedometer md-speedometer `\u{f04c5}`; never shown without `t/s`. */
	speed: string;
	/** Remaining-capacity pellet; ASCII's `.` keeps the lane single-cell in any font. */
	pellet: string;
	/** Power pellet marking the warning/error ratios; ASCII's `o` replaces the circular `○`. */
	powerPellet: string;
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
	cache: "\u{f01bc}",
	speed: "\u{f04c5}",
	pellet: PELLET_GLYPH,
	powerPellet: POWER_PELLET_GLYPH,
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
	cache: "",
	speed: "",
	pellet: ".",
	powerPellet: "o",
	ascii: true,
};

/** Used percent above which health metrics warn; shared by context usage and quota windows. */
export const USAGE_WARNING_PERCENT = 70;

/** Used percent above which health metrics fail; the upper power-pellet ratio. */
export const USAGE_ERROR_PERCENT = 90;

/** Lane ratios derived from the metric thresholds so pellets and colors cannot drift apart. */
export const POWER_PELLET_RATIOS = [USAGE_WARNING_PERCENT / 100, USAGE_ERROR_PERCENT / 100] as const;

export type LaneActivity = "idle" | "working" | "thinking" | "assistant" | "tools";

/**
 * The ghost carries three states, not four: quiet (`muted`), generating (`accent`), answering
 * (`success`). Reasoning and tool calls both mean "the model is streaming output", and Omarchy's
 * palette has exactly one hue that is neither identity (`accent`) nor a state (green/yellow/red),
 * so a fourth phase color would have to borrow a content role (`mdHeading`, `mdCode`) that some
 * themes map onto `accent` or red. Hue therefore expresses identity, magnitude, and failure only —
 * the way Omarchy's bar reserves `urgent` for attention — while the lane's shape and motion carry
 * *which* work is happening. Activity also stays out of `warning`/`error` so a busy turn can never
 * read as a crossed threshold or a failure. Keep `thinking` and `tools` distinct in `LaneActivity`:
 * they are real information, and the mouth speed already differs because tool calls are not answer
 * tokens.
 */
export const GHOST_TOKENS: Readonly<Record<Exclude<LaneActivity, "idle">, ThemeColor>> = {
	working: "muted",
	thinking: "accent",
	assistant: "success",
	tools: "accent",
};

/**
 * Lane activity for one assistant streaming event. Tool-call arguments are model output, so they
 * keep the generating `tools` ghost instead of promising an answer that has not started yet.
 */
export const activityForAssistantEvent = (type: string): Exclude<LaneActivity, "idle"> | undefined => {
	if (type === "thinking_start" || type === "thinking_delta") return "thinking";
	if (type === "text_start" || type === "text_delta") return "assistant";
	if (type === "toolcall_start" || type === "toolcall_delta") return "tools";
	return undefined;
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

/** Compact context-window size: 200_000 → 200K, 1_500 → 1.5K, 1_048_576 → 1M, 512 → 512. */
export const formatWindowSize = (tokens: number): string => {
	// A non-finite or negative window has no honest compact form; callers drop the label.
	if (!Number.isFinite(tokens) || tokens < 0) return "";
	if (tokens < 1000) return `${tokens}`;
	// Kept to one decimal in the current unit, so a mid-sized window stays honest instead of rounding away.
	const thousands = Math.round(tokens / 100) / 10;
	if (thousands < 1000) return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
	const millions = Math.round(thousands / 100) / 10;
	return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
};

export const formatCost = (cost: number): string => {
	if (!Number.isFinite(cost) || cost <= 0) return "";
	// A sub-mill cost is real money; never round it down to a misleading `$0.000`.
	if (cost < 0.001) return "<$0.001";
	return `$${cost >= 1 ? cost.toFixed(2) : cost.toFixed(3)}`;
};

/** Compact remaining time: "2d 3h", "5h 10m", "12m", or "expired" once past. */
export const formatDuration = (ms: number): string => {
	if (!Number.isFinite(ms) || ms <= 0) return "expired";
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

/** Color health metrics by usage: error above the error threshold, warning above the warning one. */
export const styleUsage = (text: string, percent: number, styles: ChromeStyles): string => {
	if (percent > USAGE_ERROR_PERCENT) return styles.fg("error", text);
	if (percent > USAGE_WARNING_PERCENT) return styles.fg("warning", text);
	return styles.fg("dim", text);
};

/** Cache-hit rate is healthy at/above 80%, warns down to 50%, and fails below. */
const CACHE_QUIET_PERCENT = 80;
const CACHE_WARNING_PERCENT = 50;

const styleCache = (text: string, rate: number | undefined, styles: ChromeStyles): string => {
	if (rate === undefined || rate >= CACHE_QUIET_PERCENT) return styles.fg("dim", text);
	if (rate >= CACHE_WARNING_PERCENT) return styles.fg("warning", text);
	return styles.fg("error", text);
};

/** Session average joins the CH label only when it diverges meaningfully from the latest turn. */
export const CH_AVG_DIVERGENCE_POINTS = 5;

/** One health reading: its plain label plus the same reading behind an optional decorative icon. */
export type MetricOption = Readonly<{ plain: string; decorated: string }>;

/**
 * Cache/cost options, widest → tightest, styled at construction. Every form carries an identifiable
 * label: the `CH` label always, with the md-database icon replacing it only when the glyph set has
 * one — a bare `98%` would be an unlabelled number, so there is no number-only form to fall back to.
 * The icon and the label take the same columns, so the icon can never buy width from useful text.
 * Keeping both forms explicit lets the border fit the plain reading first and pick the icon only
 * while the chosen model and quota still fit, instead of parsing already-styled strings. The
 * latest-turn threshold color and the session average are preserved on both forms.
 */
export const metricOptions = (
	usage: SessionUsage,
	styles: ChromeStyles,
	glyphs: GlyphSet = NERD_GLYPHS,
): readonly MetricOption[] => {
	const cost = tint(formatCost(usage.cost), "dim", styles);
	const gap = styles.fg("dim", "  ");
	const latest = usage.cacheHitRate;
	const caches: MetricOption[] = [];
	if (latest !== undefined) {
		const avg = usage.cacheHitRateAvg;
		const diverged = avg !== undefined && Math.abs(latest - avg) > CH_AVG_DIVERGENCE_POINTS;
		const avgPart = diverged ? styles.fg("dim", `/${Math.round(avg)}`) : "";
		// Color the same rounded number the label shows, so text and warning color cannot disagree.
		const roundedLatest = Math.round(latest);
		const plain = `${styleCache(`CH${roundedLatest}`, roundedLatest, styles)}${avgPart}%`;
		caches.push({
			plain,
			decorated: glyphs.cache
				? `${styleCache(`${glyphs.cache} ${roundedLatest}`, roundedLatest, styles)}${avgPart}%`
				: plain,
		});
	}
	const withCost =
		caches.length > 0
			? caches.map((cache) => ({
					plain: `${cache.plain}${gap}${cost}`,
					decorated: `${cache.decorated}${gap}${cost}`,
				}))
			: [{ plain: cost, decorated: cost }];
	return [...(cost ? withCost : []), ...caches, { plain: "", decorated: "" }];
};

export type QuotaLimit = Readonly<{
	label: string;
	/** Used percent 0–100 of this limit window. */
	percent: number;
	/** Epoch ms when this window resets; undefined when the provider omits it. */
	resetAt?: number;
}>;

/** Shared subscription-quota snapshot: reported rate-limit windows plus banked resets where the plan has them. */
export type QuotaUsage = Readonly<{
	limits: readonly QuotaLimit[];
	/** Banked usage-limit reset credits (OpenAI Codex plans); absent on providers without resets. */
	resetCredits?: number;
}>;

/** Empty snapshot for absent or unparseable payloads. */
export const EMPTY_QUOTA: QuotaUsage = { limits: [] };

/**
 * One quota reading for the bottom border: the window percentages that must fit, plus the optional
 * enrichments of exactly that reading. Keeping them together means a reading that narrowed to one
 * window can never inherit another window's countdown.
 */
export type QuotaOption = Readonly<{
	label: string;
	/** Optional enrichments of this label (countdowns, credits), richest → narrowest. */
	upgrades: readonly string[];
}>;

/**
 * Quota choices for the bottom border, widest → tightest: the whole window group first, then each
 * single window by used percentage, then an empty reading. Healthy windows stay percentage-only; a
 * window above the warning threshold shows its future countdown, and banked credits show only while
 * any reported quota is above the warning threshold. Enrichments never displace model, window
 * percentages, or cache/cost, which is why they are a second tier on the reading they extend.
 */
export type QuotaRender = Readonly<{ essentials: readonly QuotaOption[] }>;

export const quotaRender = (
	usage: QuotaUsage,
	styles: ChromeStyles,
	now = Date.now(),
	glyphs: GlyphSet = NERD_GLYPHS,
): QuotaRender => {
	const styledUsage = (text: string, percent: number): string => styleUsage(text, percent, styles);
	const gap = styles.fg("dim", "  ");
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
	const limitsLabel = (limits: readonly QuotaLimit[], withCountdown: boolean): string =>
		limits.map((limit) => renderLimit(limit, withCountdown)).join(gap);
	const anyHigh = usage.limits.some((limit) => limit.percent > USAGE_WARNING_PERCENT);
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
	// Whole group first; when it cannot fit, the most-used window survives instead of quota going
	// all-or-nothing. The sort is stable, so equal percentages keep the provider's order.
	const groups = [
		usage.limits,
		...[...usage.limits].sort((left, right) => right.percent - left.percent).map((limit) => [limit]),
	];
	const essentials = groups
		.map((limits) => ({ base: limitsLabel(limits, false), full: limitsLabel(limits, true) }))
		.filter(({ base }, index, all) => base !== "" && all.findIndex((entry) => entry.base === base) === index)
		.map(({ base, full }) => ({
			label: base,
			upgrades: dedupe([
				resets ? group(full, resets) : "",
				full === base ? "" : full,
				resets ? group(base, resets) : "",
			])
				.filter((value) => value !== "" && value !== base)
				.sort((left, right) => visibleWidth(right) - visibleWidth(left)),
		}));
	return { essentials: [...essentials, { label: "", upgrades: [] }] };
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
	const known = snapshot.contextWindow > 0 && snapshot.usedTokens !== null;
	const ratio = known ? Math.min(1, Math.max(0, snapshot.usedTokens / snapshot.contextWindow)) : 0;
	const consumedCellCount = Math.round(ratio * Math.max(0, cellCount - 1));
	const pelletCellCount = Math.max(0, cellCount - consumedCellCount - 1);
	const pacman = laneCell("text", pacmanGlyph, cellWidth, styles);
	const powerCells = new Set(
		POWER_PELLET_RATIOS.map((powerRatio) => Math.round(powerRatio * Math.max(0, cellCount - 1))),
	);
	// An unknown reading is a neutral lane: blank trailing cells instead of pellets that would claim full capacity.
	const pellets = known
		? Array.from({ length: pelletCellCount }, (_, index) => {
				const power = powerCells.has(consumedCellCount + 1 + index);
				return laneCell(power ? "muted" : "dim", power ? glyphs.powerPellet : glyphs.pellet, cellWidth, styles);
			}).join("")
		: " ".repeat(pelletCellCount * cellWidth);
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

/**
 * Widest speed reading a wide strip reserves for. Reserving one field width keeps the lane, Pac-Man,
 * and the context percent fixed while digits, the `~` estimate marker, or provider calibration change.
 */
const SPEED_FIELD_TEXT = "~100.0t/s";

/**
 * Top-border strip: auto-fit lane with context `%` (+ window size) and one reserved right slot.
 * The slot carries a live speed reading or, while Pi is waiting/retrying/compacting, a short dim
 * notice in the same field so the lane and percent do not move when output starts.
 */
export const renderLaneStrip = (
	snapshot: ContextSnapshot,
	width: number,
	styles: ChromeStyles,
	animationFrame = 0,
	activity: LaneActivity = "idle",
	speed: TokenSpeedSnapshot | null = null,
	glyphs: GlyphSet = NERD_GLYPHS,
	notice?: string,
): string => {
	if (width <= 2) return "";
	const percentValue =
		snapshot.contextWindow > 0 && snapshot.usedTokens !== null
			? (snapshot.usedTokens / snapshot.contextWindow) * 100
			: undefined;
	// An unknown reading is `?%`, never a false `0.0%` that would claim full capacity.
	const percent =
		percentValue === undefined
			? styles.fg("dim", "?%")
			: styleUsage(`${percentValue.toFixed(1)}%`, percentValue, styles);
	// Window size rides with the percent it is the denominator of; tight strips fall back to plain %.
	const window = percentValue === undefined ? "" : formatWindowSize(snapshot.contextWindow);
	// An unknown window still keeps the honest `?%`; only the `(size)` form needs a known denominator.
	const percentOptions = [...(window ? [`${percent} ${styles.fg("dim", `(${window})`)}`] : []), percent];
	const rawSpeed = formatTokenSpeed(speed);
	const noticeText = notice?.trim() ? notice : undefined;
	const slotText = noticeText ?? rawSpeed;
	// One reserved field (right-aligned reading) so common digit lengths, the `~` estimate marker,
	// provider calibration, and the wait notice cannot resize the lane. A longer real reading grows
	// the field, never cuts it.
	const slotFieldWidth = slotText ? Math.max(visibleWidth(SPEED_FIELD_TEXT), visibleWidth(slotText)) : 0;
	// Pad by terminal columns: a Nerd Font glyph may be one cell but two UTF-16 units.
	const padLeft = (text: string, fieldWidth: number): string =>
		" ".repeat(Math.max(0, fieldWidth - visibleWidth(text))) + text;
	// The speedometer is decorative and never decorates a notice: icon field, plain field, then the
	// reading's own width on tight strips, then nothing.
	const slotOptions = slotText
		? [
				// A speed reading may spend two extra columns on the speedometer; a notice reserves the
				// same columns as blank space so the percent and lane keep their position when output
				// starts. Only glyph sets that have the icon reserve it.
				...(glyphs.speed
					? [padLeft(noticeText === undefined ? `${glyphs.speed} ${slotText}` : slotText, slotFieldWidth + 2)]
					: []),
				padLeft(slotText, slotFieldWidth),
				slotText,
			].filter((value, index, all) => all.indexOf(value) === index)
		: [];
	const styleSlot = (value: string): string => (value ? styles.fg("dim", value) : "");
	const laneWidth = (pickedPercent: string | undefined, pickedSlot: string | undefined): number =>
		width - 2 - (pickedPercent ? visibleWidth(pickedPercent) + 1 : 0) - (pickedSlot ? visibleWidth(pickedSlot) + 1 : 0);
	let pickedPercent: string | undefined;
	let pickedSlot = "";
	for (const candidate of percentOptions) {
		for (const option of slotOptions) {
			if (laneWidth(candidate, option) >= 4) {
				pickedPercent = candidate;
				pickedSlot = styleSlot(option);
				break;
			}
		}
		if (pickedPercent) break;
		if (laneWidth(candidate, undefined) >= 4) {
			pickedPercent = candidate;
			pickedSlot = "";
			break;
		}
	}
	if (!pickedPercent) {
		for (const option of slotOptions) {
			if (laneWidth(undefined, option) >= 4) {
				pickedSlot = styleSlot(option);
				break;
			}
		}
	}
	const lane = renderPacmanLane(
		snapshot,
		Math.max(0, laneWidth(pickedPercent, pickedSlot)),
		styles,
		animationFrame,
		activity,
		glyphs,
	);
	return ` ${[lane, pickedPercent, pickedSlot].filter(Boolean).join(" ")} `;
};
