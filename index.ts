import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyText, VERSION } from "@earendil-works/pi-coding-agent";
import type { ModelInfo } from "./lib/border.ts";
import { ASCII_GLYPHS, type GlyphSet, type LaneActivity, NERD_GLYPHS, type QuotaUsage } from "./lib/chrome.ts";
import { configPath, readConfig } from "./lib/config.ts";
import { accumulateSessionUsage, type ContextSnapshot, type SessionUsage } from "./lib/context.ts";
import { COMPACT_HINT_DEFS, EXPANDED_HINT_DEFS, type HeaderStyles, type Hint, renderWelcome } from "./lib/header.ts";
import { fetchKimiUsage } from "./lib/kimi.ts";
import { fetchOpenAiUsage, fetchResetCreditIds, redeemResetCredit } from "./lib/openai.ts";
import { fetchOpenRouterBalance } from "./lib/openrouter.ts";
import { completedTokenSpeed, estimateDeltaTokens, estimateTokenSpeed, type TokenSpeedSnapshot } from "./lib/speed.ts";
import { registerRoundedEditor } from "./ui/rounded-editor.ts";

/** Event-driven quota refresh throttle; turns end often, the provider API is not free. */
const QUOTA_THROTTLE_MS = 60 * 1000;

/** Streamed tokens per mouth frame: chomp speed follows throughput. */
const PACMAN_TOKENS_PER_FRAME = 3;
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
	glyphs: GlyphSet;
	quota: QuotaUsage | undefined;
	quotaLastAttemptAt: number;
}>;

const freshState = (): ChromeState => ({
	context: { usedTokens: 0, contextWindow: 0 },
	usage: { cost: 0, cacheHitRate: undefined, cacheHitRateAvg: undefined },
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
	glyphs: NERD_GLYPHS,
	quota: undefined,
	quotaLastAttemptAt: 0,
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
const quotaProvider = (ctx: ExtensionContext): "kimi-coding" | "openai-codex" | "openrouter" | undefined => {
	const provider = ctx.model?.provider;
	return provider === "kimi-coding" || provider === "openai-codex" || provider === "openrouter" ? provider : undefined;
};

/** Refresh on activity (turn_end, model_select) at most once per throttle; failures keep the last snapshot. */
const refreshQuota = async (ctx: ExtensionContext): Promise<void> => {
	const provider = quotaProvider(ctx);
	if (!provider) {
		if (state.quota) patch({ quota: undefined });
		return;
	}
	const now = performance.now();
	if (now - state.quotaLastAttemptAt < QUOTA_THROTTLE_MS) return;
	patch({ quotaLastAttemptAt: now });
	const baseUrl = ctx.model?.baseUrl;
	if (provider === "kimi-coding" && !baseUrl) return;
	try {
		const key = await ctx.modelRegistry.getApiKeyForProvider(provider);
		if (!key) return;
		patch({
			quota:
				provider === "openai-codex"
					? await fetchOpenAiUsage(key, baseUrl)
					: provider === "openrouter"
						? await fetchOpenRouterBalance(key, baseUrl ?? "https://openrouter.ai/api/v1")
						: await fetchKimiUsage(key, baseUrl ?? ""),
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

/** Ghost and chomp animation carry activity; the border itself stays static theme. */
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

/** Quiet welcome header after session start; expandable via the same keybinding as pi's built-in header. */
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

const registerChrome = (pi: ExtensionAPI, ctx: ExtensionContext): void => {
	if (!ctx.hasUI) return;
	refreshSnapshot(ctx);
	refreshSessionUsage(ctx);

	if (ctx.mode === "tui") {
		ctx.ui.setWorkingVisible(false);
		setWelcomeHeader(ctx);
	}
	void refreshQuota(ctx);
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
		}),
		glyphs: state.glyphs,
		onTui: (tui) => {
			patch({ tui });
		},
	});

	ctx.ui.setFooter(() => ({ render: () => [], invalidate: () => {}, dispose: () => {} }));
};

export default function zContext(pi: ExtensionAPI): void {
	patch({ glyphs: readConfig(configPath()).asciiFallback ? ASCII_GLYPHS : NERD_GLYPHS });

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
		void refreshQuota(ctx);
		requestRender();
	});

	pi.on("agent_end", (_event, ctx) => {
		changeLaneActivity("idle");
		refreshSnapshot(ctx);
		refreshSessionUsage(ctx);
		requestRender();
	});
	pi.on("model_select", (_event, ctx) => {
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
		state = freshState();
		if (ctx.mode === "tui") {
			ctx.ui.setWorkingVisible(true);
			ctx.ui.setEditorComponent(undefined);
			ctx.ui.setHeader(undefined);
		}
		ctx.ui.setFooter(undefined);
	});
}
