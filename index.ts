import { buildSessionContext, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelInfo } from "./lib/border.ts";
import { type ChromeStyles, type LaneActivity, renderChromeLine } from "./lib/chrome.ts";
import {
	accumulateSessionUsage,
	type ContextSnapshot,
	emptyContextSegments,
	makeContextSnapshot,
	type SessionUsage,
	type SessionUsageEntry,
} from "./lib/context.ts";
import { type GitState, parseGitStatus, sameGitState } from "./lib/git.ts";
import { registerRoundedEditor } from "./ui/rounded-editor.ts";

const WIDGET_KEY = "context-bar";
const PACMAN_ANIMATION_INTERVAL_MS = 110;
const GIT_REFRESH_DEBOUNCE_MS = 200;
const GIT_IDLE_POLL_MS = 2500;

type RenderRequester = Readonly<{ requestRender: () => void }>;

let latestContextSnapshot: ContextSnapshot = {
	segments: emptyContextSegments(),
	usedTokens: 0,
	contextWindow: 0,
	usageIsEstimated: false,
};
let latestGitState: GitState | null = null;
let latestSessionUsage: SessionUsage = {
	cost: 0,
	cacheHitRate: undefined,
};
let gitRefreshGeneration = 0;
let gitRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let gitPollTimer: ReturnType<typeof setInterval> | undefined;
let gitRefreshInFlight = false;
let pendingGitRefresh: Readonly<{ pi: ExtensionAPI; ctx: ExtensionContext }> | undefined;
let gitPollingEnabled = false;
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

const refreshSessionUsage = (ctx: ExtensionContext): void => {
	latestSessionUsage = accumulateSessionUsage(ctx.sessionManager.getEntries() as readonly SessionUsageEntry[]);
};

const currentModel = (ctx: ExtensionContext): ModelInfo => {
	const model = ctx.model;
	return model ? { id: model.id, reasoning: Boolean(model.reasoning) } : null;
};

const requestRender = (): void => activeTui?.requestRender();

const changeLaneActivity = (next: LaneActivity): boolean => {
	if (laneActivity === next) return false;
	laneActivity = next;
	return true;
};

const runGitRefresh = async (pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> => {
	if (boundCtx !== ctx) return;
	if (gitRefreshInFlight) {
		pendingGitRefresh = { pi, ctx };
		return;
	}

	gitRefreshInFlight = true;
	const generation = ++gitRefreshGeneration;
	try {
		const result = await pi
			.exec("git", ["status", "--porcelain=v2", "--branch"], { cwd: ctx.cwd, timeout: 1500 })
			.catch(() => undefined);
		if (boundCtx !== ctx || generation !== gitRefreshGeneration || !result) return;

		gitPollingEnabled = result.code === 0;
		const nextGitState = result.code === 0 ? parseGitStatus(result.stdout) : null;
		if (sameGitState(latestGitState, nextGitState)) return;
		latestGitState = nextGitState;
		requestRender();
	} finally {
		gitRefreshInFlight = false;
		const pending = pendingGitRefresh;
		pendingGitRefresh = undefined;
		if (pending && boundCtx === pending.ctx) void runGitRefresh(pending.pi, pending.ctx);
	}
};

const scheduleGitRefresh = (pi: ExtensionAPI, ctx: ExtensionContext, delay = GIT_REFRESH_DEBOUNCE_MS): void => {
	if (boundCtx !== ctx) return;
	if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
	gitRefreshTimer = setTimeout(() => {
		gitRefreshTimer = undefined;
		void runGitRefresh(pi, ctx);
	}, delay);
};

const stopGitRefresh = (): void => {
	if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
	if (gitPollTimer) clearInterval(gitPollTimer);
	gitRefreshTimer = undefined;
	gitPollTimer = undefined;
	pendingGitRefresh = undefined;
	gitPollingEnabled = false;
	gitRefreshGeneration++;
};

const startGitPolling = (pi: ExtensionAPI, ctx: ExtensionContext): void => {
	if (gitPollTimer) clearInterval(gitPollTimer);
	if (ctx.mode !== "tui") return;
	gitPollTimer = setInterval(() => {
		if (boundCtx === ctx && gitPollingEnabled && ctx.isIdle()) scheduleGitRefresh(pi, ctx);
	}, GIT_IDLE_POLL_MS);
};

const registerChrome = (pi: ExtensionAPI, ctx: ExtensionContext): void => {
	if (!ctx.hasUI) return;
	boundCtx = ctx;
	refreshSnapshot(ctx);
	refreshSessionUsage(ctx);
	scheduleGitRefresh(pi, ctx, 0);
	startGitPolling(pi, ctx);

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
		const unsubscribe = footerData.onBranchChange(() => scheduleGitRefresh(pi, ctx, 0));
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
						? [renderChromeLine(latestContextSnapshot, latestSessionUsage, width, styles, animationFrame, laneActivity)]
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
	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName === "edit" || event.toolName === "write" || event.toolName === "bash") {
			scheduleGitRefresh(pi, ctx);
		}
	});
	pi.on("turn_end", (_event, ctx) => {
		refreshSessionUsage(ctx);
		requestRender();
		scheduleGitRefresh(pi, ctx, 0);
	});

	pi.on("agent_end", (_event, ctx) => {
		changeLaneActivity("idle");
		stopPacmanAnimation();
		refreshSnapshot(ctx);
		refreshSessionUsage(ctx);
		requestRender();
	});
	pi.on("agent_settled", (_event, ctx) => scheduleGitRefresh(pi, ctx, 0));

	pi.on("model_select", requestRender);
	pi.on("thinking_level_select", requestRender);
	pi.on("session_compact", (_event, ctx) => {
		refreshSnapshot(ctx);
		refreshSessionUsage(ctx);
		requestRender();
	});
	pi.on("session_tree", (_event, ctx) => {
		refreshSnapshot(ctx);
		refreshSessionUsage(ctx);
		requestRender();
		scheduleGitRefresh(pi, ctx, 0);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		laneActivity = "idle";
		latestGitState = null;
		latestSessionUsage = {
			cost: 0,
			cacheHitRate: undefined,
		};
		stopGitRefresh();
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
