/** Pure model label fitting and rounded border rendering. */

import { visibleWidth } from "@earendil-works/pi-tui";

export type ModelInfo = Readonly<{
	id: string;
	reasoning: boolean;
}> | null;

export const editorModelOptions = (model: ModelInfo, thinkingLevel: string): readonly string[] => {
	if (!model) return ["no-model", "?"];

	const id = model.id;
	const shortId = id.includes("/") ? (id.split("/").pop() ?? id) : id;
	const thinking = model.reasoning && thinkingLevel !== "off" ? thinkingLevel : "";
	const withThinking = thinking ? `${id} · ${thinking}` : id;
	const shortWithThinking = thinking ? `${shortId} · ${thinking}` : shortId;

	return [withThinking, shortWithThinking, shortId, shortId.length > 16 ? `${shortId.slice(0, 15)}…` : shortId].filter(
		Boolean,
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
