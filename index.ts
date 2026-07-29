import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelInfo } from "./lib/border.ts";
import type { LaneActivity } from "./lib/chrome.ts";
import { accumulateSessionUsage, type ContextSnapshot, type SessionUsage } from "./lib/context.ts";
import { completedTokenSpeed, estimateDeltaTokens, estimateTokenSpeed, type TokenSpeedSnapshot } from "./lib/speed.ts";
import { registerRoundedEditor } from "./ui/rounded-editor.ts";

/** Streamed tokens per mouth frame: chomp speed follows throughput. */
const PACMAN_TOKENS_PER_FRAME = 8;
const REWIND_FRAMES = 6;
const REWIND_FRAME_MS = 70;

type RenderRequester = Readonly<{ requestRender: () => void }>;

type ChromeState = Readonly<{
	context: ContextSnapshot;
	usage: SessionUsage;
	chompTokens: number;
	rewind: Readonly<{ usedTokens: number; frame: number }> | undefined;
	rewindTimer: ReturnType<typeof setInterval> | undefined;
	laneActivity: LaneActivity;
	tokenSpeed: TokenSpeedSnapshot | null;
	speedStreamTokens: number;
	speedStreamStartedAt: number | undefined;
	speedTurnOutputTokens: number;
	speedTurnActiveMs: number;
	tui: RenderRequester | undefined;
}>;

const freshState = (): ChromeState => ({
	context: { usedTokens: 0, contextWindow: 0 },
	usage: { cost: 0, cacheHitRate: undefined },
	chompTokens: 0,
	rewind: undefined,
	rewindTimer: undefined,
	laneActivity: "idle",
	tokenSpeed: null,
	speedStreamTokens: 0,
	speedStreamStartedAt: undefined,
	speedTurnOutputTokens: 0,
	speedTurnActiveMs: 0,
	tui: undefined,
});

let state = freshState();

const patch = (next: Partial<ChromeState>): void => {
	state = { ...state, ...next };
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
		speedStreamTokens: 0,
		speedStreamStartedAt: undefined,
		speedTurnOutputTokens: 0,
		speedTurnActiveMs: 0,
		chompTokens: 0,
	});
};

/** Slide Pac-Man back from pre-compact usage to reclaimed usage, then self-clear. */
const startRewind = (fromUsedTokens: number): void => {
	if (state.rewindTimer) clearInterval(state.rewindTimer);
	const toUsedTokens = state.context.usedTokens;
	patch({ rewind: { usedTokens: fromUsedTokens, frame: 0 } });
	patch({
		rewindTimer: setInterval(() => {
			const rewind = state.rewind;
			if (!rewind || rewind.frame >= REWIND_FRAMES) {
				if (state.rewindTimer) clearInterval(state.rewindTimer);
				patch({ rewindTimer: undefined, rewind: undefined });
				requestRender();
				return;
			}
			const frame = rewind.frame + 1;
			patch({
				rewind: {
					usedTokens: toUsedTokens + (fromUsedTokens - toUsedTokens) * (1 - frame / REWIND_FRAMES),
					frame,
				},
			});
			requestRender();
		}, REWIND_FRAME_MS),
	});
};

const registerChrome = (pi: ExtensionAPI, ctx: ExtensionContext): void => {
	if (!ctx.hasUI) return;
	refreshSnapshot(ctx);
	refreshSessionUsage(ctx);

	if (ctx.mode === "tui") ctx.ui.setWorkingVisible(false);
	registerRoundedEditor(ctx, {
		getModel: () => currentModel(ctx),
		getThinkingLevel: () => pi.getThinkingLevel(),
		getHealth: () => ({
			snapshot: state.rewind ? { ...state.context, usedTokens: state.rewind.usedTokens } : state.context,
			usage: state.usage,
			speed: state.tokenSpeed,
			frame: Math.floor(state.chompTokens / PACMAN_TOKENS_PER_FRAME) + (state.rewind?.frame ?? 0),
			activity: state.laneActivity,
		}),
		onTui: (tui) => {
			patch({ tui });
		},
	});

	ctx.ui.setFooter(() => ({ render: () => [], invalidate: () => {}, dispose: () => {} }));
};

export default function zContext(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => registerChrome(pi, ctx));

	pi.on("context", (_event, ctx) => {
		if (state.laneActivity !== "idle") changeLaneActivity("thinking");
		refreshSnapshot(ctx);
		requestRender();
	});

	pi.on("agent_start", () => {
		if (changeLaneActivity("working")) requestRender();
	});

	pi.on("turn_start", () => {
		resetTurnSpeed();
		requestRender();
	});

	pi.on("message_start", (event) => {
		if (event.message.role !== "assistant") return;
		patch({ speedStreamTokens: 0, speedStreamStartedAt: undefined });
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
		const tokens = estimateDeltaTokens(delta);
		const streamStartedAt = state.speedStreamStartedAt ?? now;
		const totalTokens = state.speedStreamTokens + tokens;
		patch({
			speedStreamStartedAt: streamStartedAt,
			speedStreamTokens: totalTokens,
			tokenSpeed: estimateTokenSpeed(totalTokens, now - streamStartedAt) ?? state.tokenSpeed,
			chompTokens: state.chompTokens + tokens,
		});
		requestRender();
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		patch({
			speedTurnActiveMs:
				state.speedStreamStartedAt !== undefined
					? state.speedTurnActiveMs + performance.now() - state.speedStreamStartedAt
					: state.speedTurnActiveMs,
			speedTurnOutputTokens: state.speedTurnOutputTokens + event.message.usage.output,
			speedStreamStartedAt: undefined,
		});
	});

	pi.on("tool_execution_start", () => {
		if (changeLaneActivity("tools")) requestRender();
	});
	pi.on("turn_end", (_event, ctx) => {
		patch({
			tokenSpeed: completedTokenSpeed(state.speedTurnOutputTokens, state.speedTurnActiveMs) ?? state.tokenSpeed,
		});
		refreshSessionUsage(ctx);
		requestRender();
	});

	pi.on("agent_end", (_event, ctx) => {
		changeLaneActivity("idle");
		refreshSnapshot(ctx);
		refreshSessionUsage(ctx);
		requestRender();
	});
	pi.on("model_select", requestRender);
	pi.on("thinking_level_select", requestRender);
	pi.on("session_compact", (_event, ctx) => {
		const before = state.context;
		refreshSnapshot(ctx);
		refreshSessionUsage(ctx);
		if (
			ctx.mode === "tui" &&
			before.contextWindow > 0 &&
			before.contextWindow === state.context.contextWindow &&
			state.context.usedTokens < before.usedTokens
		) {
			startRewind(before.usedTokens);
		}
		requestRender();
	});
	pi.on("session_tree", (_event, ctx) => {
		refreshSnapshot(ctx);
		refreshSessionUsage(ctx);
		requestRender();
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (state.rewindTimer) clearInterval(state.rewindTimer);
		state = freshState();
		if (ctx.mode === "tui") {
			ctx.ui.setWorkingVisible(true);
			ctx.ui.setEditorComponent(undefined);
		}
		ctx.ui.setFooter(undefined);
	});
}
