import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyText, VERSION } from "@earendil-works/pi-coding-agent";
import type { ModelInfo } from "./lib/border.ts";
import type { LaneActivity, QuotaUsage } from "./lib/chrome.ts";
import { accumulateSessionUsage, type ContextSnapshot, type SessionUsage } from "./lib/context.ts";
import {
	COMPACT_HINT_DEFS,
	EXPANDED_HINT_DEFS,
	type HeaderStyles,
	type Hint,
	renderSweepLine,
	renderWelcome,
	SWEEP_FRAMES,
} from "./lib/header.ts";
import { fetchKimiUsage } from "./lib/kimi.ts";
import { fetchOpenAiUsage, fetchResetCreditIds, redeemResetCredit } from "./lib/openai.ts";
import { completedTokenSpeed, estimateDeltaTokens, estimateTokenSpeed, type TokenSpeedSnapshot } from "./lib/speed.ts";
import { registerRoundedEditor } from "./ui/rounded-editor.ts";

/** Streamed tokens per mouth frame: chomp speed follows throughput. */
const PACMAN_TOKENS_PER_FRAME = 3;
const REWIND_FRAMES = 6;
const REWIND_FRAME_MS = 70;
const BREATH_FRAME_MS = 150;
const SWEEP_FRAME_MS = 60;
/** Coding Plan quota poll interval; the API has no push, 5 min is fresh enough. */
const QUOTA_REFRESH_MS = 5 * 60 * 1000;

type RenderRequester = Readonly<{ requestRender: () => void }>;

type ChromeState = Readonly<{
	context: ContextSnapshot;
	usage: SessionUsage;
	chompTokens: number;
	rewind: Readonly<{ usedTokens: number; frame: number }> | undefined;
	rewindTimer: ReturnType<typeof setInterval> | undefined;
	laneActivity: LaneActivity;
	breathFrame: number;
	breathTimer: ReturnType<typeof setInterval> | undefined;
	tokenSpeed: TokenSpeedSnapshot | null;
	speedStreamTokens: number;
	speedStreamStartedAt: number | undefined;
	speedTurnOutputTokens: number;
	speedTurnActiveMs: number;
	tui: RenderRequester | undefined;
	welcomeTimer: ReturnType<typeof setInterval> | undefined;
	quota: QuotaUsage | undefined;
	quotaActive: boolean;
	quotaTimer: ReturnType<typeof setInterval> | undefined;
}>;

const freshState = (): ChromeState => ({
	context: { usedTokens: 0, contextWindow: 0 },
	usage: { cost: 0, cacheHitRate: undefined },
	chompTokens: 0,
	rewind: undefined,
	rewindTimer: undefined,
	laneActivity: "idle",
	breathFrame: 0,
	breathTimer: undefined,
	tokenSpeed: null,
	speedStreamTokens: 0,
	speedStreamStartedAt: undefined,
	speedTurnOutputTokens: 0,
	speedTurnActiveMs: 0,
	tui: undefined,
	welcomeTimer: undefined,
	quota: undefined,
	quotaActive: false,
	quotaTimer: undefined,
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

/** Quota belongs to the active model's provider; a non-subscription model hides and stops polling it. */
const quotaProvider = (ctx: ExtensionContext): "kimi-coding" | "openai-codex" | undefined => {
	const provider = ctx.model?.provider;
	return provider === "kimi-coding" || provider === "openai-codex" ? provider : undefined;
};

const syncQuotaActivity = (ctx: ExtensionContext): void => {
	const active = quotaProvider(ctx) !== undefined;
	if (!active && state.quota) patch({ quota: undefined });
	patch({ quotaActive: active });
};

/** Poll the subscription quota API; failures keep the last good snapshot and stay silent. */
const refreshQuota = async (ctx: ExtensionContext): Promise<void> => {
	if (!state.quotaActive) return;
	const provider = quotaProvider(ctx);
	if (!provider) return;
	const baseUrl = ctx.model?.baseUrl;
	if (provider === "kimi-coding" && !baseUrl) return;
	try {
		const key = await ctx.modelRegistry.getApiKeyForProvider(provider);
		if (!key) return;
		patch({
			quota:
				provider === "openai-codex" ? await fetchOpenAiUsage(key, baseUrl) : await fetchKimiUsage(key, baseUrl ?? ""),
		});
		requestRender();
	} catch {
		// ponytail: quota is advisory chrome; a failed poll must never break the editor
	}
};

const currentModel = (ctx: ExtensionContext): ModelInfo => {
	const model = ctx.model;
	return model ? { id: model.id, reasoning: Boolean(model.reasoning) } : null;
};

const requestRender = (): void => state.tui?.requestRender();

const changeLaneActivity = (next: LaneActivity): boolean => {
	if (state.laneActivity === next) return false;
	patch({ laneActivity: next });
	if (next === "idle") {
		if (state.breathTimer) clearInterval(state.breathTimer);
		patch({ breathTimer: undefined, breathFrame: 0 });
		return true;
	}
	if (!state.breathTimer) {
		patch({
			breathTimer: setInterval(() => {
				patch({ breathFrame: state.breathFrame + 1 });
				requestRender();
			}, BREATH_FRAME_MS),
		});
	}
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

const headerStyles = (ctx: ExtensionContext): HeaderStyles => ({
	accent: (text) => ctx.ui.theme.bold(ctx.ui.theme.fg("accent", text)),
	dim: (text) => ctx.ui.theme.fg("dim", text),
	muted: (text) => ctx.ui.theme.fg("muted", text),
});

const resolveHints = (
	defs: ReadonlyArray<Readonly<{ id: string; action: string; rawKey?: string }>>,
): readonly Hint[] =>
	defs.map(({ id, action, rawKey }) => ({
		key: rawKey ?? keyText(id as never),
		action,
	}));

/** Quiet header after the sweep; expandable via the same keybinding as pi's built-in header. */
const setWelcomeHeader = (ctx: ExtensionContext): void => {
	ctx.ui.setHeader(() => {
		let expanded = false;
		return {
			render: (width: number) => [
				...renderWelcome(
					VERSION,
					resolveHints(COMPACT_HINT_DEFS),
					resolveHints(EXPANDED_HINT_DEFS),
					expanded,
					width,
					headerStyles(ctx),
				),
			],
			invalidate: () => {},
			setExpanded: (next: boolean) => {
				expanded = next;
			},
		};
	});
};

/** Opening sweep: Pac-Man eats the header lane once, then the quiet welcome header stays. */
const playWelcome = (ctx: ExtensionContext): void => {
	if (ctx.mode !== "tui") return;
	let frame = 0;
	ctx.ui.setHeader(() => ({
		render: (width: number) => ["", renderSweepLine(frame, width)],
		invalidate: () => {},
	}));
	patch({
		welcomeTimer: setInterval(() => {
			frame += 1;
			if (frame > SWEEP_FRAMES) {
				if (state.welcomeTimer) clearInterval(state.welcomeTimer);
				patch({ welcomeTimer: undefined });
				setWelcomeHeader(ctx);
				return;
			}
			requestRender();
		}, SWEEP_FRAME_MS),
	});
};

const registerChrome = (pi: ExtensionAPI, ctx: ExtensionContext, reason: string): void => {
	if (!ctx.hasUI) return;
	refreshSnapshot(ctx);
	refreshSessionUsage(ctx);

	if (ctx.mode === "tui") ctx.ui.setWorkingVisible(false);
	if (reason === "startup" || reason === "new") playWelcome(ctx);
	syncQuotaActivity(ctx);
	void refreshQuota(ctx);
	if (!state.quotaTimer) patch({ quotaTimer: setInterval(() => void refreshQuota(ctx), QUOTA_REFRESH_MS) });
	registerRoundedEditor(ctx, {
		getModel: () => currentModel(ctx),
		getThinkingLevel: () => pi.getThinkingLevel(),
		getHealth: () => ({
			snapshot: state.rewind ? { ...state.context, usedTokens: state.rewind.usedTokens } : state.context,
			usage: state.usage,
			quota: state.quota,
			speed: state.tokenSpeed,
			frame: Math.floor(state.chompTokens / PACMAN_TOKENS_PER_FRAME) + (state.rewind?.frame ?? 0),
			activity: state.laneActivity,
			breathFrame: state.breathFrame,
		}),
		onTui: (tui) => {
			patch({ tui });
		},
	});

	ctx.ui.setFooter(() => ({ render: () => [], invalidate: () => {}, dispose: () => {} }));
};

export default function zContext(pi: ExtensionAPI): void {
	pi.registerCommand("openai-codex-reset", {
		description: "Redeem a banked OpenAI Codex (ChatGPT plan) usage-limit reset",
		handler: async (_args, ctx) => {
			if (ctx.model?.provider !== "openai-codex") {
				ctx.ui.notify("Active model is not openai-codex", "warning");
				return;
			}
			try {
				const key = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
				if (!key) {
					ctx.ui.notify("No OpenAI Codex credentials", "warning");
					return;
				}
				const baseUrl = ctx.model?.baseUrl;
				const ids = await fetchResetCreditIds(key, baseUrl);
				if (ids.length === 0) {
					ctx.ui.notify("No banked OpenAI resets available", "info");
					return;
				}
				const confirmed = await ctx.ui.confirm(
					"Redeem OpenAI reset?",
					`Consume 1 of ${ids.length} banked usage-limit resets? This resets your current 5h/weekly window.`,
				);
				if (!confirmed) return;
				const outcome = await redeemResetCredit(key, ids[0] ?? "", baseUrl);
				ctx.ui.notify(`OpenAI reset: ${outcome}`, outcome === "reset" ? "info" : "warning");
				await refreshQuota(ctx);
			} catch (error) {
				ctx.ui.notify(`OpenAI reset failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.on("session_start", (event, ctx) => registerChrome(pi, ctx, event.reason));

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
	pi.on("model_select", (_event, ctx) => {
		syncQuotaActivity(ctx);
		void refreshQuota(ctx);
		requestRender();
	});
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
		if (state.breathTimer) clearInterval(state.breathTimer);
		if (state.welcomeTimer) clearInterval(state.welcomeTimer);
		if (state.quotaTimer) clearInterval(state.quotaTimer);
		state = freshState();
		if (ctx.mode === "tui") {
			ctx.ui.setWorkingVisible(true);
			ctx.ui.setEditorComponent(undefined);
			ctx.ui.setHeader(undefined);
		}
		ctx.ui.setFooter(undefined);
	});
}
