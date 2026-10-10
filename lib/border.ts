/** Pure model label fitting and framed border rendering. */

import { visibleWidth } from "@earendil-works/pi-tui";

export type ModelInfo = Readonly<{
	id: string;
	reasoning: boolean;
	routed?: Readonly<{ id: string; thinkingLevel: string | undefined }> | undefined;
}> | null;

/** Routed labels separate the active and physical model with a dim arrow. */
export const MODEL_ARROW = " → ";

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
