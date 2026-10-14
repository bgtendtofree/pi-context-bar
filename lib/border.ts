/** Pure model label fitting and framed border rendering. */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MetricOption } from "./chrome.ts";

export type ModelInfo = Readonly<{
	id: string;
	reasoning: boolean;
	routed?: Readonly<{ id: string; thinkingLevel: string | undefined }> | undefined;
}> | null;

/** Routed labels separate the active and physical model with a dim arrow. */
export const MODEL_ARROW = " → ";

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
	// Measured once: every caller tries many candidate combinations against the same strings.
	const usedByModel = visibleWidth(model) + (quota ? visibleWidth(quota) + gap : 0) + 3;
	if (usedByModel + 3 + scrollReserve > width) return false;
	return metric === "" || visibleWidth(metric) + 4 <= width - 2 - usedByModel - scrollReserve;
};

/**
 * Choose the bottom-border model/quota/metric triple by essential content, not by decoration or
 * optional model detail. Window percentages and cache/cost outrank optional model detail (thinking
 * level, route arrow), and cache outranks cost, so the widest essential reading that fits wins
 * before a richer model label. Within one tier the widest option is tried first.
 *
 * Each metric carries a plain reading and the same reading with an optional decorative icon. The
 * plain form is what fits, because a decoration must never trade against useful text; the decorated
 * form is kept only when the chosen model, quota, and reading still fit with it.
 */
export const pickBottomBorderContent = (
	input: Readonly<{
		width: number;
		models: readonly string[];
		quotas: readonly string[];
		metrics: readonly MetricOption[];
		gap: number;
		scrollReserve: number;
	}>,
): { model: string; quota: string; metric: string } | undefined => {
	const { width, models, quotas, metrics, gap, scrollReserve } = input;
	for (const quota of quotas) {
		for (const option of metrics) {
			const model = models.find((candidate) =>
				bottomBorderFits({ width, model: candidate, quota, metric: option.plain, gap, scrollReserve }),
			);
			if (model === undefined) continue;
			const decorated =
				option.decorated !== option.plain &&
				bottomBorderFits({ width, model, quota, metric: option.decorated, gap, scrollReserve });
			return { model, quota, metric: decorated ? option.decorated : option.plain };
		}
	}
	return undefined;
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
	if (width === 2) return `${border(leftCorner)}${border(rightCorner)}`;
	if (width === 3) return `${border(leftCorner)}${border("─")}${border(rightCorner)}`;

	// A labeled block costs 3 extra columns on the left (`─ ` + label + ` `) and 4 on the right
	// (` ` + label + ` ` + `──`); a bare edge costs one. Shrink whichever label is currently wider
	// so labels degrade together instead of one label erasing the other.
	const blockWidth = (labelWidth: number, chrome: number): number => (labelWidth > 0 ? labelWidth + chrome : 1);
	const available = width - 2;
	const leftLabelWidth = visibleWidth(leftLabel);
	const rightLabelWidth = visibleWidth(rightLabel);
	let leftWidth = leftLabelWidth;
	let rightWidth = rightLabelWidth;
	while (blockWidth(leftWidth, 3) + blockWidth(rightWidth, 4) > available && (leftWidth > 0 || rightWidth > 0)) {
		if (leftWidth > rightWidth) leftWidth -= 1;
		else rightWidth -= 1;
	}

	const fittedLeft = leftWidth < leftLabelWidth ? truncateToWidth(leftLabel, leftWidth, "") : leftLabel;
	const fittedRight = rightWidth < rightLabelWidth ? truncateToWidth(rightLabel, rightWidth, "") : rightLabel;
	const left = leftWidth > 0 ? `${border("─")} ${fittedLeft} ` : border("─");
	const right = rightWidth > 0 ? ` ${fittedRight} ${border("──")}` : border("─");
	const middleWidth = Math.max(0, width - 2 - visibleWidth(left) - visibleWidth(right));
	const content = middle ? middle(middleWidth) : "";
	const fillWidth = Math.max(0, middleWidth - visibleWidth(content));
	return `${border(leftCorner)}${left}${content}${border("─".repeat(fillWidth))}${right}${border(rightCorner)}`;
};
