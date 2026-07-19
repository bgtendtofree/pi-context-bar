import { buildSessionContext, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelInfo } from "./lib/border.ts";
import { type ChromeStyles, type LaneActivity, renderChromeLine } from "./lib/chrome.ts";
import {
	accumulateSessionUsage,
	type ContextSnapshot,
	emptyContextSegments,
	makeContextSnapshot,
	type SessionUsageEntry,
} from "./lib/context.ts";
import { type GitState, parseGitStatus } from "./lib/git.ts";
import { registerRoundedEditor } from "./ui/rounded-editor.ts";

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

const refreshSnapshot = (ctx: ExtensionContext, messages = sessionMessages(ctx)): void => {
	if (!ctx.hasUI) return;
	const usage = ctx.getContextUsage();
	const measuredTokens = typeof usage?.tokens === "number" && usage.tokens > 0 ? usage.tokens : undefined;
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	latestContextSnapshot = makeContextSnapshot(messages, ctx.getSystemPrompt(), measuredTokens, contextWindow);
};

const sessionUsage = (ctx: ExtensionContext) =>
	accumulateSessionUsage(ctx.sessionManager.getEntries() as readonly SessionUsageEntry[]);

const currentModel = (ctx: ExtensionContext): ModelInfo => {
	const model = ctx.model;
	return model ? { id: model.id, provider: model.provider, reasoning: Boolean(model.reasoning) } : null;
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

const registerChrome = (pi: ExtensionAPI, ctx: ExtensionContext): void => {
	if (!ctx.hasUI) return;
	boundCtx = ctx;
	refreshSnapshot(ctx);
	void refreshGit(pi, ctx);

	if (ctx.mode === "tui") ctx.ui.setWorkingVisible(false);
	registerRoundedEditor(ctx, {
		getModel: () => currentModel(ctx),
		getThinkingLevel: () => pi.getThinkingLevel(),
		getGit: () => latestGitState,
		onTui: (tui) => {
			activeTui = tui;
		},
	});

	ctx.ui.setFooter((_tui, _theme, footerData) => {
		const unsubscribe = footerData.onBranchChange(() => void refreshGit(pi, ctx));
		return { render: () => [], invalidate: () => {}, dispose: unsubscribe };
	});

	ctx.ui.setWidget(
		WIDGET_KEY,
		(tui, theme) => {
			activeTui = tui;
			const styles: ChromeStyles = {
				dim: (text) => theme.fg("dim", text),
				warning: (text) => theme.fg("warning", text),
				error: (text) => theme.fg("error", text),
			};
			return {
				render: (width: number) =>
					boundCtx
						? [
								renderChromeLine(
									latestContextSnapshot,
									sessionUsage(boundCtx),
									width,
									styles,
									animationFrame,
									laneActivity,
								),
							]
						: [],
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
		const next =
			type === "thinking_start" || type === "thinking_delta"
				? "thinking"
				: type === "text_start" || type === "text_delta" || type === "toolcall_start" || type === "toolcall_delta"
					? "assistant"
					: undefined;
		if (next && changeLaneActivity(next)) requestRender();
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

	pi.on("model_select", requestRender);
	pi.on("thinking_level_select", requestRender);
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
