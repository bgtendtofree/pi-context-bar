import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelInfo } from "./lib/border.ts";
import { type ChromeStyles, type LaneActivity, renderChromeLine } from "./lib/chrome.ts";
import { accumulateSessionUsage, type ContextSnapshot, type SessionUsage } from "./lib/context.ts";
import { type GitState, parseGitStatus, sameGitState } from "./lib/git.ts";
import {
	completedTokenSpeed,
	estimateDeltaTokens,
	recordTokenSpeed,
	type TokenSpeedSample,
	type TokenSpeedSnapshot,
} from "./lib/speed.ts";
import { registerRoundedEditor } from "./ui/rounded-editor.ts";

const WIDGET_KEY = "context-bar";
const PACMAN_ANIMATION_INTERVAL_MS = 110;
const GIT_REFRESH_DEBOUNCE_MS = 200;
const GIT_IDLE_POLL_MS = 2500;

type RenderRequester = Readonly<{ requestRender: () => void }>;

type ChromeState = Readonly<{
	context: ContextSnapshot;
	git: GitState | null;
	usage: SessionUsage;
	gitRefreshGeneration: number;
	gitRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	gitPollTimer: ReturnType<typeof setInterval> | undefined;
	gitRefreshInFlight: boolean;
	pendingGitRefresh: ExtensionAPI | undefined;
	gitPollingEnabled: boolean;
	animationFrame: number;
	animationTimer: ReturnType<typeof setInterval> | undefined;
	laneActivity: LaneActivity;
	tokenSpeed: TokenSpeedSnapshot | null;
	speedSamples: readonly TokenSpeedSample[];
	speedStreamStartedAt: number | undefined;
	speedMessageStartedAt: number | undefined;
	speedTurnOutputTokens: number;
	speedTurnActiveMs: number;
	tui: RenderRequester | undefined;
	ctx: ExtensionContext | undefined;
}>;

const freshState = (): ChromeState => ({
	context: { usedTokens: 0, contextWindow: 0 },
	git: null,
	usage: { cost: 0, cacheHitRate: undefined },
	gitRefreshGeneration: 0,
	gitRefreshTimer: undefined,
	gitPollTimer: undefined,
	gitRefreshInFlight: false,
	pendingGitRefresh: undefined,
	gitPollingEnabled: false,
	animationFrame: 0,
	animationTimer: undefined,
	laneActivity: "idle",
	tokenSpeed: null,
	speedSamples: [],
	speedStreamStartedAt: undefined,
	speedMessageStartedAt: undefined,
	speedTurnOutputTokens: 0,
	speedTurnActiveMs: 0,
	tui: undefined,
	ctx: undefined,
});

let state = freshState();

const patch = (next: Partial<ChromeState>): void => {
	state = { ...state, ...next };
};

const stopPacmanAnimation = (): void => {
	if (state.animationTimer) clearInterval(state.animationTimer);
	patch({ animationTimer: undefined, animationFrame: 0 });
};

const startPacmanAnimation = (): void => {
	stopPacmanAnimation();
	patch({
		animationTimer: setInterval(() => {
			patch({ animationFrame: state.animationFrame + 1 });
			state.tui?.requestRender();
		}, PACMAN_ANIMATION_INTERVAL_MS),
	});
	state.tui?.requestRender();
};

const refreshSnapshot = (ctx: ExtensionContext): void => {
	if (!ctx.hasUI) return;
	const usage = ctx.getContextUsage();
	patch({ context: { usedTokens: usage?.tokens ?? 0, contextWindow: usage?.contextWindow ?? 0 } });
};

const refreshSessionUsage = (ctx: ExtensionContext): void => {
	patch({ usage: accumulateSessionUsage(ctx.sessionManager.getEntries()) });
};

const currentModel = (ctx: ExtensionContext): ModelInfo => {
	const model = ctx.model;
	return model ? { id: model.id, reasoning: Boolean(model.reasoning) } : null;
};

const requestRender = (): void => state.tui?.requestRender();

const changeLaneActivity = (next: LaneActivity): boolean => {
	if (state.laneActivity === next) return false;
	patch({ laneActivity: next });
	return true;
};

const resetTurnSpeed = (): void => {
	patch({
		tokenSpeed: null,
		speedSamples: [],
		speedStreamStartedAt: undefined,
		speedMessageStartedAt: undefined,
		speedTurnOutputTokens: 0,
		speedTurnActiveMs: 0,
	});
};

const runGitRefresh = async (pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> => {
	if (state.ctx !== ctx) return;
	if (state.gitRefreshInFlight) {
		patch({ pendingGitRefresh: pi });
		return;
	}

	patch({ gitRefreshInFlight: true, gitRefreshGeneration: state.gitRefreshGeneration + 1 });
	const generation = state.gitRefreshGeneration;
	try {
		const result = await pi
			.exec("git", ["status", "--porcelain=v2", "--branch"], { cwd: ctx.cwd, timeout: 1500 })
			.catch(() => undefined);
		if (state.ctx !== ctx || generation !== state.gitRefreshGeneration || !result) return;

		const nextGitState = result.code === 0 ? parseGitStatus(result.stdout) : null;
		patch({ gitPollingEnabled: result.code === 0 });
		if (sameGitState(state.git, nextGitState)) return;
		patch({ git: nextGitState });
		requestRender();
	} finally {
		const pending = state.pendingGitRefresh;
		patch({ gitRefreshInFlight: false, pendingGitRefresh: undefined });
		if (pending) void runGitRefresh(pending, ctx);
	}
};

const scheduleGitRefresh = (pi: ExtensionAPI, ctx: ExtensionContext, delay = GIT_REFRESH_DEBOUNCE_MS): void => {
	if (state.ctx !== ctx) return;
	if (state.gitRefreshTimer) clearTimeout(state.gitRefreshTimer);
	patch({
		gitRefreshTimer: setTimeout(() => {
			patch({ gitRefreshTimer: undefined });
			void runGitRefresh(pi, ctx);
		}, delay),
	});
};

const stopGitRefresh = (): void => {
	if (state.gitRefreshTimer) clearTimeout(state.gitRefreshTimer);
	if (state.gitPollTimer) clearInterval(state.gitPollTimer);
	patch({
		gitRefreshTimer: undefined,
		gitPollTimer: undefined,
		pendingGitRefresh: undefined,
		gitPollingEnabled: false,
		gitRefreshGeneration: state.gitRefreshGeneration + 1,
	});
};

const startGitPolling = (pi: ExtensionAPI, ctx: ExtensionContext): void => {
	if (state.gitPollTimer) clearInterval(state.gitPollTimer);
	if (ctx.mode !== "tui") return;
	patch({
		gitPollTimer: setInterval(() => {
			if (state.ctx === ctx && state.gitPollingEnabled && ctx.isIdle()) scheduleGitRefresh(pi, ctx);
		}, GIT_IDLE_POLL_MS),
	});
};

const registerChrome = (pi: ExtensionAPI, ctx: ExtensionContext): void => {
	if (!ctx.hasUI) return;
	patch({ ctx });
	refreshSnapshot(ctx);
	refreshSessionUsage(ctx);
	scheduleGitRefresh(pi, ctx, 0);
	startGitPolling(pi, ctx);

	if (ctx.mode === "tui") ctx.ui.setWorkingVisible(false);
	registerRoundedEditor(ctx, {
		getModel: () => currentModel(ctx),
		getThinkingLevel: () => pi.getThinkingLevel(),
		getGit: () => state.git,
		onTui: (tui) => {
			patch({ tui });
		},
	});

	ctx.ui.setFooter((_tui, _theme, footerData) => {
		const unsubscribe = footerData.onBranchChange(() => scheduleGitRefresh(pi, ctx, 0));
		return { render: () => [], invalidate: () => {}, dispose: unsubscribe };
	});

	ctx.ui.setWidget(
		WIDGET_KEY,
		(tui, theme) => {
			patch({ tui });
			const styles: ChromeStyles = {
				dim: (text) => theme.fg("dim", text),
				warning: (text) => theme.fg("warning", text),
				error: (text) => theme.fg("error", text),
			};
			return {
				render: (width: number) =>
					state.ctx
						? [
								renderChromeLine(
									state.context,
									state.usage,
									width,
									styles,
									state.animationFrame,
									state.laneActivity,
									state.tokenSpeed,
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

	pi.on("context", (_event, ctx) => {
		if (state.laneActivity !== "idle") changeLaneActivity("thinking");
		refreshSnapshot(ctx);
		requestRender();
	});

	pi.on("agent_start", (_event, ctx) => {
		changeLaneActivity("working");
		if (ctx.mode === "tui") startPacmanAnimation();
	});

	pi.on("turn_start", () => {
		resetTurnSpeed();
		requestRender();
	});

	pi.on("message_start", (event) => {
		if (event.message.role !== "assistant") return;
		patch({ speedSamples: [], speedStreamStartedAt: undefined, speedMessageStartedAt: undefined });
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

		const delta =
			type === "text_delta" || type === "thinking_delta" || type === "toolcall_delta"
				? event.assistantMessageEvent.delta
				: undefined;
		if (!delta) return;
		const now = performance.now();
		const streamStartedAt = state.speedStreamStartedAt ?? now;
		const measured = recordTokenSpeed(state.speedSamples, now, streamStartedAt, estimateDeltaTokens(delta));
		patch({
			speedStreamStartedAt: streamStartedAt,
			speedMessageStartedAt: state.speedMessageStartedAt ?? now,
			speedSamples: measured.samples,
			tokenSpeed: measured.snapshot,
		});
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		patch({
			speedTurnActiveMs:
				state.speedMessageStartedAt !== undefined
					? state.speedTurnActiveMs + performance.now() - state.speedMessageStartedAt
					: state.speedTurnActiveMs,
			speedTurnOutputTokens: state.speedTurnOutputTokens + event.message.usage.output,
			speedMessageStartedAt: undefined,
		});
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
		patch({
			tokenSpeed: completedTokenSpeed(state.speedTurnOutputTokens, state.speedTurnActiveMs) ?? state.tokenSpeed,
		});
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
		stopGitRefresh();
		stopPacmanAnimation();
		state = freshState();
		if (ctx.mode === "tui") {
			ctx.ui.setWorkingVisible(true);
			ctx.ui.setEditorComponent(undefined);
		}
		ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
		ctx.ui.setFooter(undefined);
	});
}
