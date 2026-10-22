import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { keyText, parseSessionEntries, VERSION } from "@earendil-works/pi-coding-agent";
import { isAppleTerminalSession } from "@earendil-works/pi-tui";
import { runOpenAiCodexReset } from "./commands/openai-codex-reset.ts";
import type { ModelInfo } from "./lib/border.ts";
import {
	ASCII_GLYPHS,
	activityAfterContext,
	activityForAssistantEvent,
	type GlyphSet,
	type LaneActivity,
	NERD_GLYPHS,
	type QuotaUsage,
} from "./lib/chrome.ts";
import { configPath, nextAsciiFallback, readConfig } from "./lib/config.ts";
import {
	accumulateSessionUsage,
	type ContextSnapshot,
	hasParentMarkersCheck,
	hasRecoverableBilling,
	latestAssistantResponse,
	PARENT_MARKERS_CHECKED_ENTRY,
	recoverableSubscriptionMarkers,
	type SessionUsage,
	SUBSCRIPTION_TURN_ENTRY,
} from "./lib/context.ts";
import {
	COMPACT_HINT_DEFS,
	EXPANDED_HINT_DEFS,
	type HeaderStyles,
	type Hint,
	headerMark,
	renderWelcome,
} from "./lib/header.ts";
import {
	fetchOpenAiUsage,
	officialCodexBaseUrl,
	openAiAccountId,
	QUOTA_ENDPOINT_MESSAGE,
	shouldRefreshQuota,
} from "./lib/openai.ts";
import { INITIAL_PROMPT_STATE, type PromptState, promptStateAfterTurn, promptStateFromEntries } from "./lib/prompt.ts";
import { completedTokenSpeed, estimateDeltaTokens, estimateTokenSpeed, type TokenSpeedSnapshot } from "./lib/speed.ts";
import { registerFramedEditor } from "./ui/framed-editor.ts";

/** Streamed tokens per mouth frame: chomp speed follows throughput. */
const PACMAN_TOKENS_PER_FRAME = 3;
const REWIND_FRAMES = 6;
const REWIND_FRAME_MS = 70;

type RenderRequester = Readonly<{ requestRender: () => void }>;

type ChromeState = Readonly<{
	context: ContextSnapshot;
	usage: SessionUsage;
	usageLeafId: string | null | undefined;
	usageProvisional: boolean | undefined;
	/** Entry ids present when a captured subscription request started; later assistant entries are that request. */
	provisionalBaseIds: ReadonlySet<string> | undefined;
	routed: NonNullable<ModelInfo>["routed"];
	subscriptionTurn: boolean;
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
	prompt: PromptState;
	quota: QuotaUsage | undefined;
	quotaAccountId: string | undefined;
	quotaLastAttemptAt: number | undefined;
	/** One hint per session when a custom endpoint keeps Codex quota permanently unavailable. */
	quotaEndpointWarned: boolean;
}>;

const freshState = (): ChromeState => ({
	context: { usedTokens: null, contextWindow: 0 },
	usage: { cost: 0, cacheHitRate: undefined, cacheHitRateAvg: undefined },
	usageLeafId: undefined,
	usageProvisional: undefined,
	provisionalBaseIds: undefined,
	routed: undefined,
	subscriptionTurn: false,
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
	prompt: INITIAL_PROMPT_STATE,
	quota: undefined,
	quotaAccountId: undefined,
	quotaLastAttemptAt: undefined,
	quotaEndpointWarned: false,
});

let state = freshState();
let quotaLookupId = 0;
/** In-memory forks keep no parent file, so the endpoint's marker is carried in memory across the fork. */
let pendingForkSubscriptionIds: readonly string[] | undefined;

const patch = (next: Partial<ChromeState>): void => {
	state = { ...state, ...next };
};

const refreshSnapshot = (ctx: ExtensionContext): void => {
	if (!ctx.hasUI) return;
	const usage = ctx.getContextUsage();
	const usedTokens = usage?.tokens ?? null;
	const response =
		ctx.model?.api === "pi-virtual" ? latestAssistantResponse(ctx.sessionManager.getBranch()) : undefined;
	// A new unknown reading must cancel any running rewind; its old numeric snapshot must not override it.
	if (usedTokens === null && state.rewind) {
		if (state.rewindTimer) clearInterval(state.rewindTimer);
		patch({ rewind: undefined, rewindTimer: undefined });
	}
	patch({
		context: { usedTokens, contextWindow: usage?.contextWindow ?? 0 },
		routed: response ? { id: response.model, thinkingLevel: response.thinkingLevel } : undefined,
	});
};

const refreshSessionUsage = (ctx: ExtensionContext): void => {
	// ponytail: usage only changes when a new entry becomes the leaf, so the leaf id memoizes the scan.
	// A true delta fold is unsafe: a later subscription marker rebinds an already-counted response.
	const leafId = ctx.sessionManager.getLeafId();
	// The scan decision only changes with the leaf or the subscription-turn boundary; message_start can flip
	// the turn without a new entry, so include it in the memo without reading entries on every render.
	if (state.usageLeafId === leafId && state.usageProvisional === state.subscriptionTurn) return;
	const entries = ctx.sessionManager.getEntries();
	// A subscription turn persists its response after `message_start`; only an assistant entry created
	// after that captured boundary may be provisionally on-plan, never an earlier paid response.
	const provisionalId =
		state.subscriptionTurn && state.provisionalBaseIds
			? entries.findLast(
					(entry) =>
						entry.type === "message" && entry.message.role === "assistant" && !state.provisionalBaseIds?.has(entry.id),
				)?.id
			: undefined;
	patch({
		usage: accumulateSessionUsage(entries, { provisionalSubscriptionId: provisionalId }),
		usageLeafId: leafId,
		usageProvisional: state.subscriptionTurn,
	});
};

/** New OpenAI OAuth and virtual selections cannot redeem legacy ChatGPT resets. */
const isCodexModel = (ctx: ExtensionContext): boolean =>
	ctx.model?.provider === "openai-codex" && ctx.model.api !== "pi-virtual";

/** Drop the shown quota and its retry anchor; used whenever the account or endpoint can no longer host it. */
const dropQuota = (accountId: string | undefined): void => {
	patch({ quota: undefined, quotaAccountId: accountId, quotaLastAttemptAt: undefined });
};

/** Warn once per session when the active Codex model does not use the official ChatGPT endpoint. */
const warnQuotaEndpointOnce = (ctx: ExtensionContext): void => {
	if (state.quotaEndpointWarned) return;
	patch({ quotaEndpointWarned: true });
	if (ctx.hasUI)
		ctx.ui.notify("OpenAI Codex quota is off: the active model does not use the official ChatGPT endpoint");
};

/** Refresh OpenAI quota on activity, at most once per throttle; failures keep the last snapshot. */
const refreshQuota = async (ctx: ExtensionContext, force = false): Promise<void> => {
	// Quota is chrome; headless and RPC sessions must not spend an authenticated request on it.
	if (ctx.mode !== "tui") return;
	if (!isCodexModel(ctx)) {
		quotaLookupId++;
		dropQuota(undefined);
		return;
	}
	// Validate the active endpoint before the throttle: switching to a custom/proxy endpoint must clear
	// a previously shown official quota instead of letting a failed poll keep it alive.
	if (officialCodexBaseUrl(ctx.model?.baseUrl) === undefined) {
		quotaLookupId++;
		dropQuota(undefined);
		warnQuotaEndpointOnce(ctx);
		requestRender();
		return;
	}
	const lookupId = ++quotaLookupId;
	try {
		const key = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
		if (lookupId !== quotaLookupId || !isCodexModel(ctx) || officialCodexBaseUrl(ctx.model?.baseUrl) === undefined)
			return;
		const accountId = key ? openAiAccountId(key) : undefined;
		if (accountId !== state.quotaAccountId) {
			dropQuota(accountId);
			requestRender();
		}
		if (!key || !accountId) return;
		const now = performance.now();
		if (!shouldRefreshQuota(state.quotaLastAttemptAt, now, force)) return;
		patch({ quotaLastAttemptAt: now });
		const quota = await fetchOpenAiUsage(key, ctx.model?.baseUrl);
		// Recheck the endpoint on the delayed reply: a switch to a proxy must discard an in-flight official
		// result instead of attaching it to the unsupported model. A concurrent throttled same-endpoint
		// lookup must not drop a valid result, so only the account and attempt anchor gate it, not lookupId.
		if (
			!isCodexModel(ctx) ||
			officialCodexBaseUrl(ctx.model?.baseUrl) === undefined ||
			state.quotaAccountId !== accountId ||
			state.quotaLastAttemptAt !== now
		)
			return;
		patch({ quota });
		requestRender();
	} catch (error) {
		// A custom endpoint can never host Codex quota, so say so once instead of polling forever in silence.
		if (error instanceof Error && error.message === QUOTA_ENDPOINT_MESSAGE) warnQuotaEndpointOnce(ctx);
		// ponytail: quota is advisory chrome; a failed poll must never break the editor
	}
};

const currentModel = (ctx: ExtensionContext): ModelInfo => {
	const model = ctx.model;
	if (!model) return null;
	return {
		id: model.id,
		reasoning: Boolean(model.reasoning),
		routed: state.routed,
	};
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
		subscriptionTurn: false,
		provisionalBaseIds: undefined,
	});
};

/** Slide Pac-Man back from pre-compact usage to reclaimed usage, then self-clear. */
const startRewind = (fromUsedTokens: number, toUsedTokens: number): void => {
	if (state.rewindTimer) clearInterval(state.rewindTimer);
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
});

/** Keybinding id, derived from `keyText` so a typo in the hint tables fails the build instead of rendering raw. */
type KeybindingId = Parameters<typeof keyText>[0];

const resolveHints = (
	defs: ReadonlyArray<Readonly<{ id?: KeybindingId; action: string; rawKey?: string }>>,
): readonly Hint[] =>
	defs.map(({ id, action, rawKey }) => ({
		key: rawKey ?? (id ? keyText(id) : ""),
		action,
	}));

/** Quiet welcome header after session start; expandable via the same keybinding as pi's built-in header. */
const setWelcomeHeader = (ctx: ExtensionContext): void => {
	const mark = headerMark(state.glyphs.ascii, isAppleTerminalSession());
	ctx.ui.setHeader(() => {
		let expanded = false;
		return {
			render: (width: number) => [
				...renderWelcome(
					VERSION,
					resolveHints(COMPACT_HINT_DEFS),
					resolveHints(EXPANDED_HINT_DEFS),
					expanded,
					mark,
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

/** Guard the untrusted parent path: a FIFO read would hang and a huge file would stall startup. */
const MAX_PARENT_SESSION_BYTES = 64 * 1024 * 1024;

/** Read a parent session through one descriptor: nonblocking open, fstat the descriptor, bounded read. */
const readParentSessionEntries = (path: string): readonly SessionEntry[] | undefined => {
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
		const info = fstatSync(fd);
		if (!info.isFile() || info.size > MAX_PARENT_SESSION_BYTES) return undefined;
		const buffer = Buffer.allocUnsafe(info.size);
		let offset = 0;
		while (offset < buffer.length) {
			const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
			if (read <= 0) break;
			offset += read;
		}
		return parseSessionEntries(buffer.subarray(0, offset).toString("utf8")).filter(
			(entry): entry is SessionEntry => entry.type !== "session",
		);
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
};

/** Re-append billing markers retained as ancestors when a fork copies a response into a new session. */
const recoverForkSubscriptionMarkers = (pi: ExtensionAPI, ctx: ExtensionContext): void => {
	const parent = ctx.sessionManager.getHeader?.()?.parentSession;
	if (!parent) return;
	const entries = ctx.sessionManager.getEntries();
	// The sentinel names its parent, so a sentinel copied through another fork cannot skip this one.
	if (hasParentMarkersCheck(entries, parent)) return;
	// A marker only re-classifies a billed, non-plan response, so skip the parent read when none is present.
	if (hasRecoverableBilling(entries)) {
		const parentEntries = readParentSessionEntries(parent);
		// Leave the sentinel unwritten on a failed read so the next start can retry it.
		if (!parentEntries) return;
		for (const messageEntryId of recoverableSubscriptionMarkers(entries, parentEntries))
			pi.appendEntry(SUBSCRIPTION_TURN_ENTRY, { messageEntryId });
	}
	pi.appendEntry(PARENT_MARKERS_CHECKED_ENTRY, { parentSession: parent });
};

/** Glyph set from user config; re-applied per session because shutdown resets state to Nerd defaults. */
const configGlyphs = (): GlyphSet => (readConfig(configPath()).asciiFallback ? ASCII_GLYPHS : NERD_GLYPHS);

/** Pi hides its own startup header on `quietStartup: true`; the replacement header obeys the same setting. */
const startupHeaderSuppressed = (pi: ExtensionAPI): boolean => {
	try {
		return pi.getSettings().quietStartup === true;
	} catch {
		return false;
	}
};

const registerChrome = (pi: ExtensionAPI, ctx: ExtensionContext): void => {
	if (!ctx.hasUI) return;
	patch({ glyphs: configGlyphs() });
	// Derive the prompt from the resumed branch so an errored leaf starts with the failure glyph.
	patch({ prompt: promptStateFromEntries(ctx.sessionManager.getBranch()) });
	refreshSnapshot(ctx);
	refreshSessionUsage(ctx);

	if (ctx.mode === "tui") {
		ctx.ui.setWorkingVisible(false);
		if (!startupHeaderSuppressed(pi)) setWelcomeHeader(ctx);
	}
	void refreshQuota(ctx);
	ctx.ui.setFooter(() => ({ render: () => [], invalidate: () => {}, dispose: () => {} }));
	registerFramedEditor(ctx, {
		getModel: () => currentModel(ctx),
		getThinkingLevel: () => pi.getThinkingLevel(),
		getHealth: () => {
			// Pi appends background usage entries (e.g. cache warming) while idle and only triggers a render; no
			// extension lifecycle hook fires. The leaf-id memo keeps this cheap and rescans only on a new leaf.
			// During a captured subscription turn, treat the provisional unmarked response as on-plan.
			refreshSessionUsage(ctx);
			return {
				snapshot:
					state.context.usedTokens !== null && state.rewind
						? { ...state.context, usedTokens: state.rewind.usedTokens }
						: state.context,
				usage: state.usage,
				quota: state.quota,
				speed: state.tokenSpeed,
				frame: Math.floor(state.chompTokens / PACMAN_TOKENS_PER_FRAME) + (state.rewind?.frame ?? 0),
				activity: state.laneActivity,
				prompt: state.prompt,
			};
		},
		getGlyphs: () => state.glyphs,
		onUnrecognizedLayout: () => {
			// The empty footer and hidden working row belong to the framed editor; restore Pi's chrome when it is not there.
			ctx.ui.setFooter(undefined);
			ctx.ui.setWorkingVisible(true);
			ctx.ui.notify("pi-context-bar: unrecognized Pi editor layout — using Pi's own editor", "warning");
		},
		onTui: (tui) => {
			patch({ tui });
		},
	});
};

export default function zContext(pi: ExtensionAPI): void {
	patch({ glyphs: configGlyphs() });

	pi.registerCommand("context-bar", {
		description: "Switch the ASCII glyph fallback used by the editor chrome",
		handler: async (args, ctx) => {
			const ascii = nextAsciiFallback(args, state.glyphs.ascii);
			if (ascii === undefined) {
				ctx.ui.notify("Usage: /context-bar ascii-fallback [on|off|toggle]", "warning");
				return;
			}
			// Runtime only: the config file is read again at the next session start, so a toggle never rewrites
			// a user file and never has to preserve keys this extension does not own.
			patch({ glyphs: ascii ? ASCII_GLYPHS : NERD_GLYPHS });
			if (ctx.mode === "tui" && !startupHeaderSuppressed(pi)) setWelcomeHeader(ctx);
			requestRender();
			ctx.ui.notify(`ASCII glyphs ${ascii ? "on" : "off"}`, "info");
		},
	});

	pi.registerCommand("openai-codex-reset", {
		description: "Redeem a banked OpenAI Codex (ChatGPT plan) usage-limit reset",
		handler: (args, ctx) =>
			runOpenAiCodexReset(args, ctx, {
				isCodexModel,
				refreshQuota: (active) => refreshQuota(active, true),
			}),
	});

	pi.on("session_before_fork", (event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const target =
			event.position === "at" ? event.entryId : (ctx.sessionManager.getEntry?.(event.entryId)?.parentId ?? null);
		if (!target) {
			pendingForkSubscriptionIds = undefined;
			return;
		}
		// The new branch is the ancestor chain of the endpoint; markers on it survive, trailing ones do not.
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		const branch: SessionEntry[] = [];
		let currentId: string | null = target;
		while (currentId) {
			const entry = byId.get(currentId);
			if (!entry) break;
			branch.unshift(entry);
			currentId = entry.parentId;
		}
		pendingForkSubscriptionIds = recoverableSubscriptionMarkers(branch, entries);
	});

	pi.on("session_start", (event, ctx) => {
		const carried = event.reason === "fork" ? pendingForkSubscriptionIds : undefined;
		pendingForkSubscriptionIds = undefined;
		for (const messageEntryId of carried ?? []) pi.appendEntry(SUBSCRIPTION_TURN_ENTRY, { messageEntryId });
		recoverForkSubscriptionMarkers(pi, ctx);
		registerChrome(pi, ctx);
	});

	pi.on("context", (_event, ctx) => {
		changeLaneActivity(activityAfterContext(state.laneActivity));
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

	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const model =
			event.message.provider === "openai"
				? ctx.modelRegistry.find(event.message.provider, event.message.model)
				: undefined;
		const subscriptionTurn = Boolean(
			model &&
				ctx.modelRegistry.isUsingOAuth(model) &&
				ctx.modelRegistry.getProvider(model.provider)?.auth.oauth?.isSubscription,
		);
		patch({
			speedStreamTokens: 0,
			speedStreamStartedAt: undefined,
			subscriptionTurn,
			// Boundary: only an assistant entry created after this point belongs to the captured request.
			provisionalBaseIds: subscriptionTurn
				? new Set(ctx.sessionManager.getEntries().map((entry) => entry.id))
				: undefined,
		});
	});

	pi.on("message_update", (event) => {
		const type = event.assistantMessageEvent.type;
		const next = activityForAssistantEvent(type);
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
	pi.on("turn_end", (event, ctx) => {
		if (state.subscriptionTurn && event.message.role === "assistant") {
			pi.appendEntry(SUBSCRIPTION_TURN_ENTRY, { messageEntryId: event.messageEntryId });
		}
		if (event.message.role === "assistant") {
			patch({ prompt: promptStateAfterTurn(state.prompt, event.message.stopReason) });
		}
		patch({
			tokenSpeed: completedTokenSpeed(state.speedTurnOutputTokens, state.speedTurnActiveMs) ?? state.tokenSpeed,
			subscriptionTurn: false,
			provisionalBaseIds: undefined,
		});
		refreshSnapshot(ctx);
		refreshSessionUsage(ctx);
		void refreshQuota(ctx);
		requestRender();
	});

	pi.on("agent_end", (_event, ctx) => {
		refreshSnapshot(ctx);
		refreshSessionUsage(ctx);
		requestRender();
	});
	pi.on("agent_settled", () => {
		changeLaneActivity("idle");
		requestRender();
	});
	pi.on("model_select", (_event, ctx) => {
		refreshSnapshot(ctx);
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
			before.usedTokens !== null &&
			state.context.usedTokens !== null &&
			state.context.usedTokens < before.usedTokens
		) {
			startRewind(before.usedTokens, state.context.usedTokens);
		}
		requestRender();
	});
	pi.on("session_tree", (_event, ctx) => {
		patch({ prompt: promptStateFromEntries(ctx.sessionManager.getBranch()) });
		refreshSnapshot(ctx);
		refreshSessionUsage(ctx);
		requestRender();
	});
	pi.on("session_shutdown", (event, ctx) => {
		quotaLookupId++;
		// Pi emits session_shutdown for a fork before session_start carries the ids forward, so keep them.
		if (event.reason !== "fork") pendingForkSubscriptionIds = undefined;
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
