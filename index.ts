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

const updateUi = (
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	messages: readonly unknown[] = sessionMessages(ctx),
): void => {
	if (!ctx.hasUI) return;

	latestContextSnapshot = snapshotFromContext(ctx, messages);

	// Empty footer kills default 2-line chrome. Provider count is only available here.
	let providerCount = 1;

	ctx.ui.setFooter((_tui, _theme, footerData) => {
		providerCount = footerData.getAvailableProviderCount();

		return {
			render: () => {
				providerCount = footerData.getAvailableProviderCount();
				return [];
			},
			invalidate: () => {},
		};
	});

	ctx.ui.setWidget(
		WIDGET_KEY,
		(tui, theme) => {
			activeTui = tui;

			return {
				render: (width: number) => {
					const usage = usageFromContext(ctx);
					const model = modelFromContext(ctx);
					const thinkingLevel = pi.getThinkingLevel();
					const line = renderChromeLine(
						latestContextSnapshot,
						usage,
						width,
						model,
						thinkingLevel,
						providerCount,
						(text) => theme.fg("dim", text),
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
	const refreshFromSession = (ctx: ExtensionContext): void => {
		updateUi(pi, ctx);
	};

	pi.on("session_start", (_event, ctx) => refreshFromSession(ctx));

	pi.on("context", (event, ctx) => {
		updateUi(pi, ctx, event.messages as readonly unknown[]);
	});

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode === "tui") startPacmanAnimation();
	});

	pi.on("agent_end", (_event, ctx) => {
		stopPacmanAnimation();
		activeTui?.requestRender();
		refreshFromSession(ctx);
	});
	pi.on("model_select", (_event, ctx) => refreshFromSession(ctx));
	pi.on("thinking_level_select", (_event, ctx) => refreshFromSession(ctx));
	pi.on("session_compact", (_event, ctx) => refreshFromSession(ctx));
	pi.on("session_tree", (_event, ctx) => refreshFromSession(ctx));

	pi.on("session_shutdown", (_event, ctx) => {
		stopPacmanAnimation();
		activeTui = undefined;
		ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
		ctx.ui.setFooter(undefined);
	});
}
