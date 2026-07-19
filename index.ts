import { buildSessionContext, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	accumulateSessionUsage,
	type ContextSnapshot,
	emptyContextSegments,
	type ModelInfo,
	makeContextSnapshot,
	renderChromeLine,
	type SessionUsageEntry,
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
let animationFrame = 0;
let animationTimer: ReturnType<typeof setInterval> | undefined;
let activeTui: RenderRequester | undefined;
// ctx captured at widget registration. Its getters stay live for the whole session
// and only go stale after session_shutdown, which clears this reference.
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

	return {
		id: model.id,
		provider: model.provider,
		reasoning: Boolean(model.reasoning),
	};
};

/** Recompute the context snapshot. Cheap to call on data-change events; no UI re-registration. */
const refreshSnapshot = (ctx: ExtensionContext, messages?: readonly unknown[]): void => {
	if (!ctx.hasUI) return;
	latestContextSnapshot = snapshotFromContext(ctx, messages ?? sessionMessages(ctx));
};

const requestRender = (): void => {
	activeTui?.requestRender();
};

/**
 * Register footer + widget once per session. The footer only exists to capture the
 * provider count as a render side effect; the widget reads model/thinking/usage live
 * from ctx, so neither needs re-binding on per-turn events.
 */
const registerChrome = (pi: ExtensionAPI, ctx: ExtensionContext): void => {
	if (!ctx.hasUI) return;
	boundCtx = ctx;
	refreshSnapshot(ctx);

	let providerCount = 1;

	// Empty footer kills the default 2-line chrome; its render updates providerCount.
	ctx.ui.setFooter((_tui, _theme, footerData) => ({
		render: () => {
			providerCount = footerData.getAvailableProviderCount();
			return [];
		},
		invalidate: () => {},
	}));

	ctx.ui.setWidget(
		WIDGET_KEY,
		(tui, theme) => {
			activeTui = tui;
			const dim = (text: string) => theme.fg("dim", text);

			return {
				render: (width: number) => {
					if (!boundCtx) return [];
					const usage = usageFromContext(boundCtx);
					const model = modelFromContext(boundCtx);
					const thinkingLevel = pi.getThinkingLevel();
					const line = renderChromeLine(
						latestContextSnapshot,
						usage,
						width,
						model,
						thinkingLevel,
						providerCount,
						dim,
						animationFrame,
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
		refreshSnapshot(ctx, event.messages as readonly unknown[]);
		requestRender();
	});

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode === "tui") startPacmanAnimation();
	});

	pi.on("agent_end", (_event, ctx) => {
		stopPacmanAnimation();
		// agent_end.messages contains only messages produced by this agent loop.
		// Rebuild from session history so segment colors keep the full context mix.
		refreshSnapshot(ctx);
		requestRender();
	});

	// Model + thinking level are read live in render; snapshot segments are unaffected.
	pi.on("model_select", () => requestRender());
	pi.on("thinking_level_select", () => requestRender());

	pi.on("session_compact", (_event, ctx) => {
		refreshSnapshot(ctx);
		requestRender();
	});
	pi.on("session_tree", (_event, ctx) => {
		refreshSnapshot(ctx);
		requestRender();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopPacmanAnimation();
		activeTui = undefined;
		boundCtx = undefined;
		ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
		ctx.ui.setFooter(undefined);
	});
}
