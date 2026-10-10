/** Pure model label fitting and framed border rendering. */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { GlyphSet } from "./chrome.ts";

export type ModelInfo = Readonly<{
	id: string;
	reasoning: boolean;
	/** Selected provider id; badges only through `providerBadge`, never inferred from the model id. */
	provider?: string;
	routed?: Readonly<{ id: string; thinkingLevel: string | undefined }> | undefined;
}> | null;

/** Routed labels separate the active and physical model with a dim arrow. */
export const MODEL_ARROW = " → ";

/** Provider badge for exact known selected providers; unknown or virtual selections stay badge-free. */
export const providerBadge = (
	provider: string | undefined,
	glyphs: Pick<GlyphSet, "providerOpenai" | "providerAnthropic">,
): string => {
	if (provider === "openai" || provider === "openai-codex") return glyphs.providerOpenai;
	if (provider === "anthropic") return glyphs.providerAnthropic;
	return "";
};

/** Insert the decorative brain before every `· level` thinking label; routed labels included. */
export const withThinkingGlyph = (label: string, glyph: string): string =>
	glyph ? label.split(" · ").join(` · ${glyph} `) : label;

/**
 * Apply the decorative provider badge and thinking brain to a fitted model label, keeping only the
 * widest variant that still fits beside the chosen quota and metrics. Icons are tried before any
 * useful model, quota, cache, or cost text is dropped.
 */
export const decorateModel = (
	model: string,
	modelInfo: ModelInfo,
	glyphs: GlyphSet,
	width: number,
	quota: string,
	metric: string,
	gap: number,
	scrollReserve: number,
): string => {
	const badge = providerBadge(modelInfo?.provider, glyphs);
	const thinking = model.includes(" · ") ? withThinkingGlyph(model, glyphs.thinking) : model;
	const candidates = [
		badge && thinking !== model ? `${badge} ${thinking}` : "",
		badge ? `${badge} ${model}` : "",
		thinking,
		model,
	];
	const unique = candidates.filter((value, index) => value.length > 0 && candidates.indexOf(value) === index);
	return (
		unique.find((candidate) => bottomBorderFits({ width, model: candidate, quota, metric, gap, scrollReserve })) ??
		model
	);
};

/** Whether a bottom-border model/quota/metric triple fits; decorations must clear this before staying. */
export const bottomBorderFits = (
	input: Readonly<{
		width: number;
		model: string;
		quota: string;
		metric: string;
		gap: number;
		scrollReserve: number;
	}>,
): boolean => {
	const { width, model, quota, metric, gap, scrollReserve } = input;
	const quotaWidth = quota ? visibleWidth(quota) + gap : 0;
	if (2 + visibleWidth(model) + quotaWidth + 3 + 1 + scrollReserve > width) return false;
	const usedByModel = visibleWidth(model) + (quota ? visibleWidth(quota) + gap : 0) + 3;
	return metric === "" || visibleWidth(metric) + 4 <= width - 2 - usedByModel - scrollReserve;
};

export const editorModelOptions = (model: ModelInfo, thinkingLevel: string): readonly string[] => {
	if (!model) return ["no-model", "?"];

	const id = model.id;
	const shortId = id.includes("/") ? (id.split("/").pop() ?? id) : id;
	const thinking = model.reasoning && thinkingLevel !== "off" ? thinkingLevel : "";
	const withThinking = thinking ? `${id} · ${thinking}` : id;
	const shortWithThinking = thinking ? `${shortId} · ${thinking}` : shortId;
	const routed = model.routed;
	const routedId = routed?.id.split("/").at(-1) ?? "";
	const routedThinking = routed?.thinkingLevel && routed.thinkingLevel !== "off" ? ` · ${routed.thinkingLevel}` : "";
	const routeOptions = routed
		? [
				`${withThinking} → ${routed.id}${routedThinking}`,
				`${shortWithThinking} → ${routedId}${routedThinking}`,
				`${shortId} → ${routedId}`,
				`${shortId} → ${routedId.length > 16 ? `${routedId.slice(0, 15)}…` : routedId}`,
			]
		: [];

	return Array.from(
		new Set([
			...routeOptions,
			withThinking,
			shortWithThinking,
			shortId,
			shortId.length > 16 ? `${shortId.slice(0, 15)}…` : shortId,
		]),
	);
};

export const renderLabeledBorder = (
	width: number,
	leftCorner: string,
	rightCorner: string,
	leftLabel: string,
	rightLabel: string,
	border: (text: string) => string,
	middle?: (width: number) => string,
): string => {
	if (width <= 0) return "";
	if (width === 1) return border("─");

	const left = leftLabel ? `${border("─")} ${leftLabel} ` : border("─");
	const right = rightLabel ? ` ${rightLabel} ${border("──")}` : border("─");
	const middleWidth = Math.max(0, width - 2 - visibleWidth(left) - visibleWidth(right));
	const content = middle ? middle(middleWidth) : "";
	const fillWidth = Math.max(0, middleWidth - visibleWidth(content));
	return `${border(leftCorner)}${left}${content}${border("─".repeat(fillWidth))}${right}${border(rightCorner)}`;
};
