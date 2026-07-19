/** Pure model/Git label fitting and rounded border rendering. */

import { plainWidth } from "./text.ts";

export type ModelInfo = Readonly<{
	id: string;
	provider: string;
	reasoning: boolean;
}> | null;

export const editorModelOptions = (model: ModelInfo, thinkingLevel: string): readonly string[] => {
	if (!model) return ["no-model", "?"];

	const id = model.id;
	const shortId = id.includes("/") ? (id.split("/").pop() ?? id) : id;
	const thinking = model.reasoning && thinkingLevel !== "off" ? thinkingLevel : "";
	const withThinking = thinking ? `${id} · ${thinking}` : id;
	const shortWithThinking = thinking ? `${shortId} · ${thinking}` : shortId;

	return [
		...new Set(
			[withThinking, shortWithThinking, shortId, shortId.length > 16 ? `${shortId.slice(0, 15)}…` : shortId].filter(
				Boolean,
			),
		),
	];
};

export const pickEditorBorderLabels = (
	modelLabels: readonly string[],
	gitLabels: readonly string[],
	width: number,
): Readonly<{ modelLabel: string; gitLabel: string }> => {
	const fits = (modelLabel: string, gitLabel: string): boolean => {
		const leftWidth = modelLabel ? plainWidth(modelLabel) + 3 : 1;
		const rightWidth = gitLabel ? plainWidth(gitLabel) + 4 : 1;
		return 2 + leftWidth + rightWidth + 3 <= width;
	};

	for (const modelLabel of modelLabels) {
		for (const gitLabel of gitLabels) {
			if (fits(modelLabel, gitLabel)) return { modelLabel, gitLabel };
		}
	}
	for (const modelLabel of modelLabels) {
		if (fits(modelLabel, "")) return { modelLabel, gitLabel: "" };
	}
	return { modelLabel: "", gitLabel: "" };
};

export const renderLabeledBorder = (
	width: number,
	leftCorner: string,
	rightCorner: string,
	leftLabel: string,
	rightLabel: string,
	border: (text: string) => string,
): string => {
	if (width <= 0) return "";
	if (width === 1) return border("─");

	const left = leftLabel ? `${border("─")} ${leftLabel} ` : border("─");
	const right = rightLabel ? ` ${rightLabel} ${border("──")}` : border("─");
	const fillWidth = Math.max(0, width - 2 - plainWidth(left) - plainWidth(right));
	return `${border(leftCorner)}${left}${border("─".repeat(fillWidth))}${right}${border(rightCorner)}`;
};
