import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
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
	buildEffectiveContext,
	type ContextChange,
	type ContextMessage,
	compareContext,
	type EffectiveContextSummary,
	latestRequestUsage,
	type RequestUsage,
	toolDeclaration,
} from "./lib/context-audit.ts";
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
import { parseQuotaEvent, parseQuotaHeaders, responseQuotaKey, unexpiredQuota } from "./lib/response-quota.ts";
import { completedTokenSpeed, estimateDeltaTokens, estimateTokenSpeed, type TokenSpeedSnapshot } from "./lib/speed.ts";
import { restoreDecision, STASH_SHORTCUT, STASH_SUBCOMMAND, stashDecision } from "./lib/stash.ts";
import { renderStatus } from "./lib/status.ts";
import {
	endAgentRun,
	endTurn,
	healthNotice,
	INITIAL_TIMING,
	isObservableOutput,
	observeOutput,
	settleAgentRun,
	startAgentRun,
	startRequest,
	startTurn,
	type TimingReport,
	type TimingState,
} from "./lib/timing.ts";
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
	/** Request-time billing identity captured before HTTP; the response matches it by model. */
	billingRequest: Readonly<{ model: string; subscription: boolean }> | undefined;
	chompTokens: number;
	rewind: Readonly<{ usedTokens: number; frame: number }> | undefined;
	rewindTimer: ReturnType<typeof setInterval> | undefined;
	laneActivity: LaneActivity;
	tokenSpeed: TokenSpeedSnapshot | null;
	speedStreamTokens: number;
	speedStreamStartedAt: number | undefined;
	speedTurnOutputTokens: number;
	speedTurnActiveMs: number;
	timing: TimingState;
	/** Pi's native working indicator kind, read through the public editor API. */
	phase: string | undefined;
	lastRequestUsage: RequestUsage | undefined;
	effective: EffectiveContextSummary | undefined;
	effectiveIssue: string | undefined;
	runContext: ContextSnapshot | undefined;
	runContextIssue: string | undefined;
	contextChange: ContextChange | undefined;
	/** In-memory draft; never written to disk or carried into another session. */
	stash: string | undefined;
	tui: RenderRequester | undefined;
	glyphs: GlyphSet;
	prompt: PromptState;
	quota: QuotaUsage | undefined;
	quotaAccountId: string | undefined;
	quotaLastAttemptAt: number | undefined;
	quotaSource: string | undefined;
	quotaUpdatedAt: number | undefined;
	quotaIssue: string | undefined;
	quotaRequestKey: string | undefined;
	/**
	 * Identity captured at the latest turn_start. Its presence means a turn started even when `key` is
	 * undefined (a virtual/unsupported selection): that captured identity must fail closed, not fall
	 * through to the newly selected model.
	 */
	turnQuota: Readonly<{ key: string | undefined }> | undefined;
	quotaOwnerKey: string | undefined;
	getExtensionStatuses: (() => ReadonlyMap<string, string>) | undefined;
	/** One hint per session when a custom endpoint cannot host official quota queries. */
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
	billingRequest: undefined,
	chompTokens: 0,
	rewind: undefined,
	rewindTimer: undefined,
	laneActivity: "idle",
	tokenSpeed: null,
	speedStreamTokens: 0,
	speedStreamStartedAt: undefined,
	speedTurnOutputTokens: 0,
	speedTurnActiveMs: 0,
	timing: INITIAL_TIMING,
	phase: undefined,
	lastRequestUsage: undefined,
	effective: undefined,
	effectiveIssue: undefined,
	runContext: undefined,
	runContextIssue: undefined,
	contextChange: undefined,
	stash: undefined,
	tui: undefined,
	glyphs: NERD_GLYPHS,
	prompt: INITIAL_PROMPT_STATE,
	quota: undefined,
	quotaAccountId: undefined,
	quotaLastAttemptAt: undefined,
	quotaSource: undefined,
	quotaUpdatedAt: undefined,
	quotaIssue: undefined,
	quotaRequestKey: undefined,
	turnQuota: undefined,
	quotaOwnerKey: undefined,
	getExtensionStatuses: undefined,
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
	// Never fall back to `getEntries()`: a response on another branch must stay unavailable here.
	const branch = typeof ctx.sessionManager.getBranch === "function" ? ctx.sessionManager.getBranch() : undefined;
	patch({
		usage: accumulateSessionUsage(entries, { provisionalSubscriptionId: provisionalId }),
		lastRequestUsage: branch ? latestRequestUsage(branch) : undefined,
		usageLeafId: leafId,
		usageProvisional: state.subscriptionTurn,
	});
};

/** A stale/unobserved summary is explicitly unavailable until the next context observation. */
const markEffectiveUnknown = (issue: string): void => {
	patch({ effective: undefined, effectiveIssue: issue });
};

/**
 * Last effective context observed at the `context_with_system` hook. Only the bounded numeric
 * summary is kept; messages, prompts, and tool payloads are never stored. Later handlers or the
 * provider can still transform the transcript after this observation.
 */
const observeEffectiveContext = (messages: readonly { role: string }[]): void => {
	try {
		patch({
			effective: buildEffectiveContext({
				messages: messages as readonly ContextMessage[],
				systemPrompt: getCurrentSystemPrompt(messages),
				// Replayed transcript declarations, not getActiveTools: hidden/conditional tools that
				// never reach the provider must not inflate the Tools estimate.
				tools: getCurrentTools(messages).map(toolDeclaration),
				now: Date.now(),
			}),
			effectiveIssue: undefined,
		});
	} catch {
		markEffectiveUnknown("effective context observation failed");
	}
};

const timingReport = (): TimingReport => ({
	lastTtftMs: state.timing.lastTtftMs,
	requestPending: state.timing.request !== undefined && state.timing.request.ttftMs === undefined,
	runActive: state.timing.run !== undefined,
	lastRun: state.timing.lastRun,
	phase: state.phase,
});

const stashBlocks = (ctx: ExtensionContext, action: string): boolean => {
	if (state.stash === undefined) return false;
	ctx.ui.notify(
		`Draft stash still holds text; restore it first with ${STASH_SHORTCUT} or /context-bar ${STASH_SUBCOMMAND} (${action} cancelled)`,
		"warning",
	);
	return true;
};

/** Clear the stash only after the editor accepted the text, so a failed set can be retried. */
const restoreDraftText = (ctx: ExtensionContext, text: string): void => {
	try {
		ctx.ui.setEditorText(text);
	} catch {
		ctx.ui.notify("Draft restore failed; the stash is still held and can be retried", "warning");
		return;
	}
	patch({ stash: undefined });
	ctx.ui.notify("Stashed draft restored", "info");
};

const toggleStash = (ctx: ExtensionContext): void => {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Draft stash requires the interactive editor", "warning");
		return;
	}
	const decision = stashDecision(ctx.ui.getEditorText(), state.stash);
	if (decision.action === "stash") {
		try {
			ctx.ui.setEditorText("");
		} catch {
			ctx.ui.notify("Draft stash failed; editor text was not changed and nothing was stashed", "warning");
			return;
		}
		patch({ stash: decision.text });
		ctx.ui.notify(`Draft stashed (${STASH_SHORTCUT} or /context-bar ${STASH_SUBCOMMAND} restores)`, "info");
	} else if (decision.action === "restore") {
		restoreDraftText(ctx, decision.text);
	} else if (decision.action === "refuse") {
		ctx.ui.notify(
			"A draft is already stashed and the editor has text; empty the editor to restore it (nothing was overwritten)",
			"warning",
		);
	} else {
		ctx.ui.notify(`Nothing to stash or restore (${STASH_SHORTCUT} stashes non-empty editor text)`, "info");
	}
	requestRender();
};

const restoreStashedDraft = (ctx: ExtensionContext): void => {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Draft stash requires the interactive editor", "warning");
		return;
	}
	// A submitted slash command has already cleared the editor; verify anyway and never overwrite.
	const decision = restoreDecision(ctx.ui.getEditorText(), state.stash);
	if (decision.action === "restore") {
		restoreDraftText(ctx, decision.text);
	} else if (decision.action === "refuse") {
		ctx.ui.notify(`Editor already has text; not overwriting it (${STASH_SHORTCUT} stashes or restores)`, "warning");
	} else {
		ctx.ui.notify(`No stashed draft to restore (${STASH_SHORTCUT} stashes the editor)`, "info");
	}
	requestRender();
};

/** New OpenAI OAuth and virtual selections cannot redeem legacy ChatGPT resets. */
const isCodexModel = (ctx: ExtensionContext): boolean =>
	ctx.model?.provider === "openai-codex" && ctx.model.api !== "pi-virtual";

/** OpenAI Responses payloads name the routed physical model; other payloads may omit it. */
const payloadModelId = (payload: unknown): string | undefined =>
	typeof payload === "object" && payload !== null && "model" in payload && typeof payload.model === "string"
		? payload.model
		: undefined;

/** Capture the request's selected auth before HTTP; a later /login or model switch must not rewrite it. */
const captureRequestBilling = (payload: unknown, ctx: ExtensionContext): void => {
	// The payload names the physical model actually sent, even if the selection changed while auth/HTTP was pending.
	const modelId = payloadModelId(payload) ?? ctx.model?.id;
	const model = modelId ? ctx.modelRegistry.find("openai", modelId) : undefined;
	if (model?.provider !== "openai") {
		patch({ billingRequest: undefined });
		return;
	}
	patch({
		billingRequest: {
			model: model.id,
			subscription:
				ctx.modelRegistry.isUsingOAuth(model) &&
				ctx.modelRegistry.getProvider(model.provider)?.auth.oauth?.isSubscription === true,
		},
	});
};

/** Drop the shown quota and its retry anchor; used whenever the account or endpoint can no longer host it. */
const dropQuota = (accountId: string | undefined): void => {
	patch({
		quota: undefined,
		quotaAccountId: accountId,
		quotaLastAttemptAt: undefined,
		quotaSource: undefined,
		quotaUpdatedAt: undefined,
		quotaIssue: undefined,
		quotaOwnerKey: undefined,
	});
};

/** Warn once per session when the active Codex model does not use the official ChatGPT endpoint. */
const warnQuotaEndpointOnce = (ctx: ExtensionContext): void => {
	if (state.quotaEndpointWarned) return;
	patch({ quotaEndpointWarned: true });
	if (ctx.hasUI)
		ctx.ui.notify("Official Codex quota queries are off for this endpoint; waiting for provider response metadata");
};

const passiveQuota = (): boolean => state.quotaSource === "response headers" || state.quotaSource === "stream event";

const expireQuota = (ctx: ExtensionContext): void => {
	if (!passiveQuota() || !state.quota) return;
	if (state.quotaOwnerKey !== responseQuotaKey(ctx.model)) {
		dropQuota(undefined);
		patch({ quotaIssue: "model or endpoint changed; waiting for provider response metadata" });
		return;
	}
	const quota = unexpiredQuota(state.quota, Date.now());
	if (quota !== state.quota) patch({ quota, quotaIssue: "expired response quota windows were removed" });
};

const observeQuota = (quota: QuotaUsage | undefined, source: string): void => {
	if (!quota) return;
	quotaLookupId++;
	patch({
		quota,
		quotaSource: source,
		quotaUpdatedAt: Date.now(),
		quotaAccountId: undefined,
		quotaLastAttemptAt: undefined,
		quotaOwnerKey: state.quotaRequestKey,
		quotaIssue: quota.limits.length
			? "responding upstream quota, not a proxy-pool aggregate; reset credits are not reported"
			: "response reported no usable, unexpired Codex quota windows",
	});
	requestRender();
};

/** Refresh OpenAI quota on activity, at most once per throttle; failures keep the last snapshot. */
const refreshQuota = async (ctx: ExtensionContext, force = false): Promise<void> => {
	// Quota is chrome; headless and RPC sessions must not spend an authenticated request on it.
	if (ctx.mode !== "tui") return;
	expireQuota(ctx);
	if (!force && passiveQuota() && state.quota?.limits.length) return;
	if (!isCodexModel(ctx)) {
		quotaLookupId++;
		dropQuota(undefined);
		patch({
			quotaIssue: responseQuotaKey(ctx.model)
				? "waiting for provider response metadata"
				: "model API does not expose Codex quota",
		});
		return;
	}
	// Validate the active endpoint before the throttle: switching to a custom/proxy endpoint must clear
	// a previously shown official quota instead of letting a failed poll keep it alive.
	if (officialCodexBaseUrl(ctx.model?.baseUrl) === undefined) {
		quotaLookupId++;
		dropQuota(undefined);
		patch({ quotaIssue: "no official queries for custom endpoints; waiting for provider response metadata" });
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
		if (!key || !accountId) {
			patch({ quotaIssue: "no legacy Codex credentials or account ID" });
			return;
		}
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
		patch({
			quota,
			quotaSource: "official query",
			quotaUpdatedAt: Date.now(),
			quotaIssue: "official ChatGPT account quota",
		});
		requestRender();
	} catch (error) {
		if (lookupId !== quotaLookupId) return;
		patch({ quotaIssue: "official quota query failed; keeping the last good snapshot" });
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
		billingRequest: undefined,
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
	markEffectiveUnknown("waiting for the next context observation");

	if (ctx.mode === "tui") {
		ctx.ui.setWorkingVisible(false);
		if (!startupHeaderSuppressed(pi)) setWelcomeHeader(ctx);
	}
	void refreshQuota(ctx);
	ctx.ui.setFooter((_tui, _theme, footerData) => {
		const getExtensionStatuses = () => footerData.getExtensionStatuses();
		patch({ getExtensionStatuses });
		return {
			render: () => [],
			invalidate: () => {},
			dispose: () => {
				if (state.getExtensionStatuses === getExtensionStatuses) patch({ getExtensionStatuses: undefined });
			},
		};
	});
	registerFramedEditor(ctx, {
		getModel: () => currentModel(ctx),
		getThinkingLevel: () => pi.getThinkingLevel(),
		getHealth: () => {
			expireQuota(ctx);
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
				notice: healthNotice({
					phase: state.phase,
					waiting: state.timing.waiting,
					stashed: state.stash !== undefined,
					hasSpeed: state.tokenSpeed !== null,
					outputActive: state.timing.request?.ttftMs !== undefined,
				}),
			};
		},
		getGlyphs: () => state.glyphs,
		onWorkingStatus: (kind) => {
			// Mirror Pi's native retry/compaction/summary phase; never infer one from errors.
			if (state.phase === kind) return;
			patch({ phase: kind });
			requestRender();
		},
		onStash: () => toggleStash(ctx),
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
		description: "Inspect chrome/status diagnostics, restore a stashed draft, or switch ASCII glyphs",
		handler: async (args, ctx) => {
			if (args.trim() === STASH_SUBCOMMAND) {
				restoreStashedDraft(ctx);
				return;
			}
			if (args.trim() === "status") {
				expireQuota(ctx);
				refreshSnapshot(ctx);
				refreshSessionUsage(ctx);
				ctx.ui.notify(
					renderStatus({
						mode: ctx.mode,
						model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "",
						ascii: state.glyphs.ascii,
						config: configPath(),
						context: state.context,
						usage: state.usage,
						speed: state.tokenSpeed,
						timing: timingReport(),
						requestUsage: state.lastRequestUsage,
						contextChange: state.contextChange,
						effective: state.effective,
						effectiveIssue: state.effectiveIssue,
						stash: state.stash !== undefined,
						quota: state.quota,
						quotaSource: state.quotaSource,
						quotaUpdatedAt: state.quotaUpdatedAt,
						quotaIssue: state.quotaIssue,
						statuses: state.getExtensionStatuses?.(),
					}),
					"info",
				);
				return;
			}
			const ascii = nextAsciiFallback(args, state.glyphs.ascii);
			if (ascii === undefined) {
				ctx.ui.notify(`Usage: /context-bar status | ${STASH_SUBCOMMAND} | ascii-fallback [on|off|toggle]`, "warning");
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

	pi.on("session_before_switch", (event, ctx) =>
		stashBlocks(ctx, event.reason === "new" ? "new session" : "session switch") ? { cancel: true } : undefined,
	);

	pi.on("session_before_tree", (_event, ctx) => (stashBlocks(ctx, "tree navigation") ? { cancel: true } : undefined));

	pi.on("session_before_fork", (event, ctx) => {
		if (stashBlocks(ctx, "fork")) {
			pendingForkSubscriptionIds = undefined;
			return { cancel: true };
		}
		const entries = ctx.sessionManager.getEntries();
		const target =
			event.position === "at" ? event.entryId : (ctx.sessionManager.getEntry?.(event.entryId)?.parentId ?? null);
		if (!target) {
			pendingForkSubscriptionIds = undefined;
			return;
		}
		// The new branch is the ancestor chain of the endpoint; markers on it survive, trailing ones do not.
		pendingForkSubscriptionIds = recoverableSubscriptionMarkers(ctx.sessionManager.getBranch(target), entries);
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

	pi.on("context_with_system", (event) => {
		// Observation point for the effective request; numeric summary only, no message retention.
		observeEffectiveContext(event.messages);
	});

	pi.on("before_provider_request", (event, ctx) => {
		captureRequestBilling(event.payload, ctx);
		patch({ timing: startRequest(state.timing, performance.now()) });
		if (ctx.mode !== "tui") return;
		// A proxy may rotate credentials between requests; never merge windows from different responses.
		if (passiveQuota()) dropQuota(undefined);
		const selectedKey = responseQuotaKey(ctx.model);
		const requestModel = payloadModelId(event.payload);
		// The turn captured its selection before auth, when this request started. A switch during that
		// wait must not re-home the response headers onto the newly selected model; the payload names
		// the physical model for Responses APIs, while background requests use the captured turn key.
		const identityMatches =
			(requestModel === undefined || requestModel === ctx.model?.id) &&
			(state.turnQuota === undefined || state.turnQuota.key === selectedKey);
		patch({ quotaRequestKey: identityMatches ? selectedKey : undefined });
	});
	pi.on("after_provider_response", (event, ctx) => {
		if (
			ctx.mode === "tui" &&
			state.quotaRequestKey !== undefined &&
			state.quotaRequestKey === responseQuotaKey(ctx.model) &&
			event.status >= 200 &&
			event.status < 300
		)
			observeQuota(parseQuotaHeaders(event.headers, Date.now()), "response headers");
	});
	pi.on("provider_stream_event", (event, ctx) => {
		if (
			ctx.mode === "tui" &&
			state.quotaRequestKey !== undefined &&
			state.quotaRequestKey === responseQuotaKey(ctx.model) &&
			event.provider === ctx.model?.provider &&
			event.api === ctx.model.api &&
			event.model === ctx.model.id
		)
			observeQuota(parseQuotaEvent(event.data, Date.now()), "stream event");
	});

	pi.on("agent_start", (_event, ctx) => {
		refreshSnapshot(ctx);
		// A retried `agent_start` keeps the original run start; only `agent_settled` ends the run.
		// A fresh run clears the previous settled delta instead of presenting it as this run's.
		if (state.timing.run === undefined)
			patch({ runContext: state.context, runContextIssue: undefined, contextChange: undefined });
		patch({ timing: startAgentRun(state.timing, performance.now()) });
		changeLaneActivity("working");
		requestRender();
	});

	pi.on("turn_start", (_event, ctx) => {
		resetTurnSpeed();
		patch({ timing: startTurn(state.timing, performance.now()) });
		// Capture the request's selection before auth; a later select must not claim its response quota.
		// A virtual/unsupported selection is captured too, with `key` undefined, so it cannot fall through.
		patch({ turnQuota: { key: responseQuotaKey(ctx.model) } });
		requestRender();
	});

	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const billing = state.billingRequest;
		const subscriptionTurn = Boolean(
			event.message.provider === "openai" && billing?.subscription && billing.model === event.message.model,
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

		const now = performance.now();
		// Start events and empty deltas are not output; only observable content records TTFT.
		const timing = observeOutput(state.timing, now, isObservableOutput(event.assistantMessageEvent));
		if (timing !== state.timing) {
			patch({ timing });
			requestRender();
		}

		const delta =
			type === "text_delta" || type === "thinking_delta" || type === "toolcall_delta"
				? event.assistantMessageEvent.delta
				: undefined;
		if (!delta) return;
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
		if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
			const timing = endTurn(state.timing);
			if (timing !== state.timing) patch({ timing });
		}
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
			timing: endTurn(state.timing),
			quotaRequestKey: undefined,
			subscriptionTurn: false,
			billingRequest: undefined,
			provisionalBaseIds: undefined,
		});
		refreshSnapshot(ctx);
		refreshSessionUsage(ctx);
		void refreshQuota(ctx);
		requestRender();
	});

	pi.on("agent_end", (_event, ctx) => {
		patch({ timing: endAgentRun(state.timing) });
		refreshSnapshot(ctx);
		refreshSessionUsage(ctx);
		requestRender();
	});
	pi.on("agent_settled", (event, ctx) => {
		refreshSnapshot(ctx);
		const change = compareContext(state.runContext, state.context, state.runContextIssue);
		patch({
			timing: settleAgentRun(state.timing, performance.now(), event.aborted),
			contextChange: change,
			runContext: undefined,
			runContextIssue: undefined,
		});
		refreshSessionUsage(ctx);
		changeLaneActivity("idle");
		requestRender();
	});
	pi.on("model_select", (_event, ctx) => {
		// A run that spans a model switch has no comparable before/after context reading.
		patch({ quotaRequestKey: undefined, contextChange: { unavailable: "model changed" } });
		if (state.timing.run) patch({ runContextIssue: "model changed during the run" });
		if (passiveQuota()) dropQuota(undefined);
		markEffectiveUnknown("model changed; waiting for the next observation");
		refreshSnapshot(ctx);
		void refreshQuota(ctx);
		requestRender();
	});
	pi.on("thinking_level_select", requestRender);
	pi.on("session_compact", (_event, ctx) => {
		const before = state.context;
		patch({ contextChange: { unavailable: "compaction changed the context" } });
		if (state.timing.run) patch({ runContextIssue: "compaction changed the context during the run" });
		markEffectiveUnknown("compaction changed the context; waiting for the next observation");
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
		patch({
			prompt: promptStateFromEntries(ctx.sessionManager.getBranch()),
			contextChange: { unavailable: "branch changed" },
		});
		if (state.timing.run) patch({ runContextIssue: "branch changed during the run" });
		markEffectiveUnknown("branch changed; waiting for the next observation");
		refreshSnapshot(ctx);
		refreshSessionUsage(ctx);
		requestRender();
	});
	pi.on("session_shutdown", (event, ctx) => {
		quotaLookupId++;
		// Shutdown cannot be cancelled. Restore a held draft into an empty editor first (reload keeps
		// editor text); with a non-empty editor the SDK leaves no non-disk place to preserve it.
		if (state.stash !== undefined && ctx.mode === "tui") {
			try {
				if (ctx.ui.getEditorText().length === 0) {
					ctx.ui.setEditorText(state.stash);
				} else {
					// Reload/quit cannot be cancelled, so this in-memory draft cannot be preserved.
					ctx.ui.notify(
						`Stash lost during ${event.reason} shutdown: the editor already has text; restore the draft before reloading or quitting (${STASH_SHORTCUT} or /context-bar ${STASH_SUBCOMMAND})`,
						"warning",
					);
				}
			} catch {
				// A forced shutdown can take the editor before this handler runs; no disk workaround.
				try {
					ctx.ui.notify(`Stash could not be restored during ${event.reason} shutdown`, "warning");
				} catch {
					// The UI is already gone.
				}
			}
		}
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
