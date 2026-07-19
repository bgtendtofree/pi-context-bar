import {
	buildSessionContext,
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	accumulateSessionUsage,
	type ContextSnapshot,
	editorModelOptions,
	emptyContextSegments,
	type GitState,
	gitLabelOptions,
	type LaneActivity,
	type ModelInfo,
	makeContextSnapshot,
	parseGitStatus,
	pickEditorBorderLabels,
	renderChromeLine,
	renderLabeledBorder,
	type SessionUsageEntry,
	stripAnsi,
} from "./lib/chrome.ts";

const WIDGET_KEY = "context-bar";
const PACMAN_ANIMATION_INTERVAL_MS = 110;

type RenderRequester = Readonly<{ requestRender: () => void }>;

let latestContextSnapshot: ContextSnapshot = {
	segments: emptyContextSegments(),
	usedTokens: 0,
	contextWindow: 0,
	usageIsEstimated: false,
};
let latestGitState: GitState | null = null;
let animationFrame = 0;
let animationTimer: ReturnType<typeof setInterval> | undefined;
let laneActivity: LaneActivity = "idle";
let activeTui: RenderRequester | undefined;
// ctx captured at widget/editor registration. Its getters stay live for the session.
let boundCtx: ExtensionContext | undefined;

const stopPacmanAnimation = (): void => {
	if (animationTimer) clearInterval(animationTimer);
	animationTimer = undefined;
	animationFrame = 0;
};

const startPacmanAnimation = (): void => {
	stopPacmanAnimation();
	animationTimer = setInterval(() => {
		animationFrame++;
		activeTui?.requestRender();
	}, PACMAN_ANIMATION_INTERVAL_MS);
	activeTui?.requestRender();
};

const sessionMessages = (ctx: ExtensionContext): readonly unknown[] => {
	const context = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
	return context.messages as readonly unknown[];
};

const snapshotFromContext = (ctx: ExtensionContext, messages: readonly unknown[]): ContextSnapshot => {
	const usage = ctx.getContextUsage();
	const measuredTokens = typeof usage?.tokens === "number" && usage.tokens > 0 ? usage.tokens : undefined;
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	return makeContextSnapshot(messages, ctx.getSystemPrompt(), measuredTokens, contextWindow);
};

const usageFromContext = (ctx: ExtensionContext) => {
	const entries = ctx.sessionManager.getEntries() as readonly SessionUsageEntry[];
	return accumulateSessionUsage(entries);
};

const modelFromContext = (ctx: ExtensionContext): ModelInfo => {
	const model = ctx.model;
	if (!model) return null;
	return { id: model.id, provider: model.provider, reasoning: Boolean(model.reasoning) };
};

const refreshSnapshot = (ctx: ExtensionContext, messages?: readonly unknown[]): void => {
	if (!ctx.hasUI) return;
	latestContextSnapshot = snapshotFromContext(ctx, messages ?? sessionMessages(ctx));
};

const requestRender = (): void => activeTui?.requestRender();

const changeLaneActivity = (next: LaneActivity): boolean => {
	if (laneActivity === next) return false;
	laneActivity = next;
	return true;
};

const refreshGit = async (pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> => {
	const result = await pi
		.exec("git", ["status", "--porcelain=v2", "--branch"], { cwd: ctx.cwd, timeout: 1500 })
		.catch(() => undefined);
	if (boundCtx !== ctx) return;
	latestGitState = result?.code === 0 ? parseGitStatus(result.stdout) : null;
	requestRender();
};

const isHorizontalBorder = (text: string): boolean => {
	const plain = stripAnsi(text);
	return plain.length > 0 && plain.replace(/─/g, "") === "";
};

const styleModelLabel = (label: string, ctx: ExtensionContext): string => {
	const separator = label.lastIndexOf(" · ");
	if (separator < 0) return ctx.ui.theme.fg(label === "no-model" ? "muted" : "accent", label);
	return (
		ctx.ui.theme.fg("accent", label.slice(0, separator)) +
		ctx.ui.theme.fg("dim", " · ") +
		ctx.ui.theme.fg("dim", label.slice(separator + 3))
	);
};

const styleGitLabel = (label: string, git: GitState | null, ctx: ExtensionContext): string => {
	if (!label) return "";
	const dirty = Boolean(git && git.staged + git.unstaged + git.untracked > 0);
	return label
		.split(" ")
		.map((part, index) => {
			if (index === 0) return ctx.ui.theme.fg("dim", part);
			if (index === 1) return ctx.ui.theme.fg(dirty ? "warning" : "success", part);
			if (part.startsWith("+")) return ctx.ui.theme.fg("success", part);
			if (part.startsWith("*") || part === "●") return ctx.ui.theme.fg("warning", part);
			if (part.startsWith("?")) return ctx.ui.theme.fg("muted", part);
			if (part.startsWith("↑")) return ctx.ui.theme.fg("success", part);
			if (part.startsWith("↓")) return ctx.ui.theme.fg("error", part);
			return ctx.ui.theme.fg("dim", part);
		})
		.join(" ");
};

const registerRoundedEditor = (pi: ExtensionAPI, ctx: ExtensionContext): void => {
	if (ctx.mode !== "tui") return;

	class ContextBarEditor extends CustomEditor {
		constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
			super(tui, theme, keybindings, { paddingX: 0 });
			activeTui = tui;
		}

		override render(width: number): string[] {
			if (width < 6) return super.render(width);

			const innerWidth = width - 2;
			const lines = super.render(innerWidth - 2);
			if (lines.length < 2) return lines;

			const borderColor = (text: string) => this.borderColor(text);
			const prompt = `${ctx.ui.theme.fg("accent", "›")} `;
			const wrap = (line: string, left: string, right: string, prefix: string): string => {
				const borderLike = stripAnsi(line).endsWith("─");
				const content = borderLike ? line : prefix + line;
				const gap = Math.max(0, innerWidth - visibleWidth(content));
				const fill = borderLike ? borderColor("─".repeat(gap)) : " ".repeat(gap);
				return borderColor(left) + content + fill + borderColor(right);
			};

			const bottomIndex = lines.findLastIndex((line, index) => index > 0 && isHorizontalBorder(line));
			const endOfEditor = bottomIndex === -1 ? lines.length : bottomIndex;
			const body = lines.slice(1, endOfEditor);
			const extra = bottomIndex === -1 ? [] : lines.slice(bottomIndex + 1);
			const result = [renderLabeledBorder(width, "╭", "╮", "", "", borderColor)];

			for (const [index, line] of body.entries()) {
				result.push(wrap(line, "│", "│", index === 0 ? prompt : "  "));
			}
			for (const line of extra) result.push(wrap(line, "│", "│", "  "));

			const modelLabels = editorModelOptions(modelFromContext(ctx), pi.getThinkingLevel());
			const gitLabels = gitLabelOptions(latestGitState);
			const picked = pickEditorBorderLabels(modelLabels, gitLabels, width);
			result.push(
				renderLabeledBorder(
					width,
					"╰",
					"╯",
					styleModelLabel(picked.modelLabel, ctx),
					styleGitLabel(picked.gitLabel, latestGitState, ctx),
					borderColor,
				),
			);
			return result;
		}
	}

	ctx.ui.setEditorComponent((tui, theme, keybindings) => new ContextBarEditor(tui, theme, keybindings));
};

const registerChrome = (pi: ExtensionAPI, ctx: ExtensionContext): void => {
	if (!ctx.hasUI) return;
	boundCtx = ctx;
	refreshSnapshot(ctx);
	void refreshGit(pi, ctx);

	if (ctx.mode === "tui") ctx.ui.setWorkingVisible(false);
	registerRoundedEditor(pi, ctx);

	// Empty footer kills default chrome; branch callback keeps Git metadata reactive.
	ctx.ui.setFooter((_tui, _theme, footerData) => {
		const unsubscribe = footerData.onBranchChange(() => void refreshGit(pi, ctx));
		return {
			render: () => [],
			invalidate: () => {},
			dispose: unsubscribe,
		};
	});

	ctx.ui.setWidget(
		WIDGET_KEY,
		(tui, theme) => {
			activeTui = tui;
			const dim = (text: string) => theme.fg("dim", text);
			return {
				render: (width: number) => {
					if (!boundCtx) return [];
					const line = renderChromeLine(
						latestContextSnapshot,
						usageFromContext(boundCtx),
						width,
						dim,
						animationFrame,
						laneActivity,
					);
					return [line];
				},
				invalidate: () => {},
			};
		},
		{ placement: "belowEditor" },
	);
};

export default function zContext(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => registerChrome(pi, ctx));

	pi.on("context", (event, ctx) => {
		if (laneActivity !== "idle") changeLaneActivity("thinking");
		refreshSnapshot(ctx, event.messages as readonly unknown[]);
		requestRender();
	});

	pi.on("agent_start", (_event, ctx) => {
		changeLaneActivity("working");
		if (ctx.mode === "tui") startPacmanAnimation();
	});

	pi.on("message_update", (event) => {
		const type = event.assistantMessageEvent.type;
		const nextActivity =
			type === "thinking_start" || type === "thinking_delta"
				? "thinking"
				: type === "text_start" || type === "text_delta" || type === "toolcall_start" || type === "toolcall_delta"
					? "assistant"
					: undefined;
		if (nextActivity && changeLaneActivity(nextActivity)) requestRender();
	});

	pi.on("tool_execution_start", () => {
		if (changeLaneActivity("tools")) requestRender();
	});

	pi.on("turn_end", (_event, ctx) => void refreshGit(pi, ctx));

	pi.on("agent_end", (_event, ctx) => {
		changeLaneActivity("idle");
		stopPacmanAnimation();
		refreshSnapshot(ctx);
		requestRender();
	});

	pi.on("model_select", () => requestRender());
	pi.on("thinking_level_select", () => requestRender());

	pi.on("session_compact", (_event, ctx) => {
		refreshSnapshot(ctx);
		requestRender();
	});
	pi.on("session_tree", (_event, ctx) => {
		refreshSnapshot(ctx);
		void refreshGit(pi, ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		laneActivity = "idle";
		latestGitState = null;
		stopPacmanAnimation();
		activeTui = undefined;
		boundCtx = undefined;
		if (ctx.mode === "tui") {
			ctx.ui.setWorkingVisible(true);
			ctx.ui.setEditorComponent(undefined);
		}
		ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
		ctx.ui.setFooter(undefined);
	});
}
