import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	type AssistantUsage,
	accumulateSessionUsage,
	allocateBarColumns,
	allocateProportionally,
	type ContextSnapshot,
	cacheHitRate,
	chooseLabel,
	emptyContextSegments,
	estimateContentTokens,
	estimateTextTokens,
	FREE_SEGMENT_TEXT,
	FREE_SEGMENT_TEXT_FULL,
	FREE_SEGMENT_TEXT_HOT,
	fitStyledText,
	formatModel,
	formatTokens,
	freeMetricOptions,
	freeTextColor,
	IMAGE_TOKEN_ESTIMATE,
	makeContextSnapshot,
	modelOptions,
	pickFirstFitting,
	pickModelAndBarWidth,
	plainWidth,
	renderChromeLine,
	renderFreeSegment,
	renderUsedSegment,
	type SessionUsage,
	scaleSegmentsToUsage,
	segmentSessionMessages,
	segmentTotal,
	stripAnsi,
	styleFreeMetrics,
	truncatePlainText,
	USED_SEGMENTS,
} from "./chrome.ts";

const usage = (partial: Partial<SessionUsage> = {}): SessionUsage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	cacheHitRate: undefined,
	...partial,
});

const snapshot = (partial: Partial<ContextSnapshot> = {}): ContextSnapshot => ({
	segments: emptyContextSegments(),
	usedTokens: 0,
	contextWindow: 200_000,
	usageIsEstimated: false,
	...partial,
});

const assistantUsage = (partial: Partial<AssistantUsage> = {}): AssistantUsage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: { total: 0 },
	...partial,
});

describe("formatTokens", () => {
	test("small integers stay plain", () => {
		assert.equal(formatTokens(0), "0");
		assert.equal(formatTokens(999), "999");
	});

	test("thousands use k", () => {
		assert.equal(formatTokens(1000), "1.0k");
		assert.equal(formatTokens(1500), "1.5k");
		assert.equal(formatTokens(9999), "10.0k");
		assert.equal(formatTokens(10_000), "10k");
		assert.equal(formatTokens(123_456), "123k");
	});

	test("millions use M", () => {
		assert.equal(formatTokens(1_000_000), "1.0M");
		assert.equal(formatTokens(2_500_000), "2.5M");
		assert.equal(formatTokens(10_000_000), "10M");
	});

	test("negatives clamp to zero", () => {
		assert.equal(formatTokens(-5), "0");
	});
});

describe("text helpers", () => {
	test("stripAnsi removes color codes", () => {
		assert.equal(stripAnsi("\x1b[38;2;1;2;3mhi\x1b[39m"), "hi");
	});

	test("plainWidth ignores ansi and counts unicode", () => {
		assert.equal(plainWidth("ab"), 2);
		assert.equal(plainWidth("\x1b[31mab\x1b[39m"), 2);
		assert.equal(plainWidth("你"), 1);
	});

	test("truncatePlainText", () => {
		assert.equal(truncatePlainText("hello", 10), "hello");
		assert.equal(truncatePlainText("hello", 0), "");
		assert.equal(truncatePlainText("hello", 1), "…");
		assert.equal(truncatePlainText("hello", 3), "he…");
	});

	test("fitStyledText strips when over width", () => {
		const styled = "\x1b[31mhello\x1b[39m";
		assert.equal(fitStyledText(styled, 10), styled);
		assert.equal(fitStyledText(styled, 3), "he…");
	});

	test("estimateTextTokens uses chars/4 ceil", () => {
		assert.equal(estimateTextTokens("abcd"), 1);
		assert.equal(estimateTextTokens("abcde"), 2);
		assert.equal(estimateTextTokens(""), 0);
	});

	test("estimateContentTokens counts images", () => {
		const content = [{ type: "text", text: "abcd" }, { type: "image" }];
		assert.equal(estimateContentTokens(content), 1 + IMAGE_TOKEN_ESTIMATE);
		assert.equal(estimateContentTokens("abcd"), 1);
	});

	test("chooseLabel picks longest fit", () => {
		assert.equal(chooseLabel(["system", "sys", "s"], 6), "system");
		assert.equal(chooseLabel(["system", "sys", "s"], 3), "sys");
		assert.equal(chooseLabel(["system", "sys", "s"], 1), "s");
		assert.equal(chooseLabel(["system", "sys", "s"], 0), "");
	});
});

describe("segmentSessionMessages", () => {
	test("buckets roles", () => {
		const segments = segmentSessionMessages(
			[
				{ role: "user", content: "abcd" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "abcd" },
						{ type: "thinking", thinking: "abcd" },
						{ type: "toolCall", name: "read", arguments: {} },
					],
				},
				{ role: "toolResult", content: "abcd" },
				{ role: "other" },
				null,
			],
			"abcd",
		);

		assert.equal(segments.system, 1);
		assert.equal(segments.prompt, 1);
		assert.ok(segments.assistant > 0);
		assert.equal(segments.thinking, 1);
		assert.equal(segments.tools, 1);
		assert.equal(
			segmentTotal(segments),
			segments.system + segments.prompt + segments.assistant + segments.thinking + segments.tools,
		);
	});
});

describe("allocateProportionally", () => {
	test("sums to columns", () => {
		const cols = allocateProportionally([1, 1, 1], 10);
		assert.equal(
			cols.reduce((a, b) => a + b, 0),
			10,
		);
		assert.equal(cols.length, 3);
	});

	test("zero total or columns", () => {
		assert.deepEqual(allocateProportionally([1, 2], 0), [0, 0]);
		assert.deepEqual(allocateProportionally([0, 0], 5), [0, 0]);
	});

	test("largest remainder fairness", () => {
		const cols = allocateProportionally([1, 1, 1], 5);
		assert.equal(
			cols.reduce((a, b) => a + b, 0),
			5,
		);
		assert.equal(
			cols.every((c) => c >= 1),
			true,
		);
	});
});

describe("allocateBarColumns", () => {
	test("gives min 1 col to nonzero used segments", () => {
		const values = [10, 0, 10, 0, 0, 100];
		const cols = allocateBarColumns(values, 10);
		assert.equal(
			cols.reduce((a, b) => a + b, 0),
			10,
		);
		assert.ok((cols[0] ?? 0) >= 1);
		assert.ok((cols[2] ?? 0) >= 1);
		assert.equal(cols[1], 0);
	});

	test("falls back when width tiny", () => {
		const values = [1, 1, 1, 1, 1, 1];
		const cols = allocateBarColumns(values, 3);
		assert.equal(
			cols.reduce((a, b) => a + b, 0),
			3,
		);
	});
});

describe("scaleSegmentsToUsage", () => {
	test("scales to measured total", () => {
		const raw = { ...emptyContextSegments(), system: 10, prompt: 30 };
		const scaled = scaleSegmentsToUsage(raw, 100);
		assert.equal(segmentTotal(scaled), 100);
		assert.ok(scaled.prompt > scaled.system);
	});

	test("noop when empty", () => {
		const empty = emptyContextSegments();
		assert.deepEqual(scaleSegmentsToUsage(empty, 100), empty);
		assert.deepEqual(scaleSegmentsToUsage({ ...empty, prompt: 5 }, 0), { ...empty, prompt: 5 });
	});
});

describe("makeContextSnapshot", () => {
	test("uses measured tokens when present", () => {
		const snap = makeContextSnapshot([{ role: "user", content: "abcdabcd" }], "abcd", 1000, 200_000);
		assert.equal(snap.usedTokens, 1000);
		assert.equal(snap.usageIsEstimated, false);
		assert.equal(snap.contextWindow, 200_000);
		assert.equal(segmentTotal(snap.segments), 1000);
	});

	test("falls back to estimate", () => {
		const snap = makeContextSnapshot([{ role: "user", content: "abcd" }], "abcd", undefined, 0);
		assert.equal(snap.usageIsEstimated, true);
		assert.equal(snap.usedTokens, segmentTotal(snap.segments));
	});
});

describe("cacheHitRate / accumulateSessionUsage", () => {
	test("cacheHitRate formula", () => {
		assert.equal(cacheHitRate(assistantUsage({ input: 10, cacheRead: 90, cacheWrite: 0 })), 90);
		assert.equal(cacheHitRate(assistantUsage({ input: 0, cacheRead: 0, cacheWrite: 0 })), undefined);
		assert.equal(cacheHitRate(assistantUsage({ input: 5, cacheRead: 0, cacheWrite: 5 })), 0);
	});

	test("accumulates and keeps last-turn CH%", () => {
		const result = accumulateSessionUsage([
			{
				type: "message",
				message: {
					role: "user",
					usage: assistantUsage({ input: 999 }),
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					usage: assistantUsage({
						input: 10,
						output: 5,
						cacheRead: 90,
						cacheWrite: 0,
						cost: { total: 0.01 },
					}),
				},
			},
			{
				type: "message",
				message: {
					role: "assistant",
					usage: assistantUsage({
						input: 20,
						output: 5,
						cacheRead: 80,
						cacheWrite: 0,
						cost: { total: 0.02 },
					}),
				},
			},
			{ type: "other", message: { role: "assistant", usage: assistantUsage() } },
		]);

		assert.equal(result.input, 30);
		assert.equal(result.output, 10);
		assert.equal(result.cacheRead, 170);
		assert.ok(Math.abs(result.cost - 0.03) < 1e-10);
		// last assistant: 80 / (20+80+0) = 80%
		assert.equal(result.cacheHitRate, 80);
	});
});

describe("freeMetricOptions cascade", () => {
	const full = usage({
		input: 12_000,
		output: 3000,
		cacheRead: 180_000,
		cacheWrite: 2000,
		cost: 0.042,
		cacheHitRate: 92.3,
	});
	const snap = snapshot({ usedTokens: 90_000, contextWindow: 200_000 });

	test("widest is % · CH · $", () => {
		const options = freeMetricOptions(snap, full);
		assert.equal(options[0], "45.0% · CH92.3% · $0.042");
		assert.ok(!options[0].includes("↑"));
		assert.ok(!options[0].includes("90k/200k"));
		assert.ok(!options[0].includes("R"));
	});

	test("estimated prefix uses ~", () => {
		const options = freeMetricOptions(
			snapshot({ usedTokens: 10, contextWindow: 100, usageIsEstimated: true }),
			usage({ cacheHitRate: 50 }),
		);
		assert.equal(
			options.some((o) => o.startsWith("~")),
			true,
		);
	});

	test("pickFirstFitting respects width", () => {
		const options = freeMetricOptions(snap, full);
		const wide = pickFirstFitting(options, 200);
		const mid = pickFirstFitting(options, plainWidth(options[2] ?? ""));
		const tiny = pickFirstFitting(options, 4);
		assert.equal(wide, options[0]);
		assert.ok(plainWidth(mid) <= plainWidth(options[2] ?? ""));
		assert.ok(plainWidth(tiny) <= 4);
	});

	test("empty cost and no CH still yields percent", () => {
		const options = freeMetricOptions(snap, usage());
		assert.equal(
			options.some((o) => o.includes("%")),
			true,
		);
		assert.equal(
			options.every((o) => !o.includes("CH")),
			true,
		);
	});
});

describe("freeTextColor thresholds", () => {
	test("bands", () => {
		assert.equal(freeTextColor(0), FREE_SEGMENT_TEXT);
		assert.equal(freeTextColor(70), FREE_SEGMENT_TEXT);
		assert.equal(freeTextColor(70.1), FREE_SEGMENT_TEXT_HOT);
		assert.equal(freeTextColor(90), FREE_SEGMENT_TEXT_HOT);
		assert.equal(freeTextColor(90.1), FREE_SEGMENT_TEXT_FULL);
	});
});

describe("style + render segments", () => {
	test("styleFreeMetrics accents only CH", () => {
		const styled = styleFreeMetrics("45.2% · CH92% · $0.04", 45);
		assert.ok(styled.includes("CH92%"));
		assert.ok(styled.includes("$0.04"));
		assert.equal(stripAnsi(styled), "45.2% · CH92% · $0.04");
	});

	test("renderUsedSegment width and labels", () => {
		assert.equal(renderUsedSegment(["sys", "s"], "#3D4F5F", 0), "");
		const wide = renderUsedSegment(["sys", "s"], "#3D4F5F", 5);
		assert.equal(stripAnsi(wide).length, 5);
		assert.ok(stripAnsi(wide).includes("sys"));
		// Narrow segments stay unlabeled color blocks.
		const thin = renderUsedSegment(["sys", "s"], "#3D4F5F", 1);
		assert.equal(stripAnsi(thin), " ");
		const mid = renderUsedSegment(["sys", "s"], "#3D4F5F", 3);
		assert.equal(stripAnsi(mid), "   ");
	});

	test("renderFreeSegment left-aligns metrics without fill bar", () => {
		assert.equal(renderFreeSegment(0, ["x"], 10), "");
		const empty = renderFreeSegment(8, ["way-too-long-to-fit-here"], 10);
		assert.equal(stripAnsi(empty), "        ");
		const filled = renderFreeSegment(20, ["45% · CH92", "45%", ""], 45);
		const plain = stripAnsi(filled);
		assert.ok(plain.includes("45% · CH92"));
		assert.equal(plain.length, 20);
		assert.equal(plain.trimStart().startsWith("45%"), true);
	});
});

describe("model options", () => {
	test("no model", () => {
		assert.equal(formatModel(null, "high", 1), "no-model");
		assert.deepEqual(modelOptions(null, "high", 1), ["no-model", "?"]);
	});

	test("with reasoning and multi provider", () => {
		const model = { id: "anthropic/claude-opus", provider: "anthropic", reasoning: true };
		assert.ok(formatModel(model, "high", 2).includes("(anthropic)"));
		assert.ok(formatModel(model, "high", 2).includes("· high"));
		const options = modelOptions(model, "high", 2);
		assert.ok(options[0]?.includes("anthropic"));
		assert.ok(options.includes("claude-opus"));
		assert.equal(options.at(-1), "·");
	});

	test("short id without slash", () => {
		const model = { id: "gpt-4o", provider: "openai", reasoning: false };
		const options = modelOptions(model, "off", 1);
		assert.equal(options[0], "gpt-4o");
		assert.ok(!options.includes("(openai) gpt-4o"));
	});

	test("pickModelAndBarWidth reserves bar", () => {
		const { modelText, barWidth } = pickModelAndBarWidth(["very-long-model-name", "m", "·"], 20);
		assert.ok(modelText.length > 0);
		assert.ok(barWidth + plainWidth(modelText) <= 20);
		assert.ok(barWidth >= 6);
	});

	test("pickModelAndBarWidth drops model when too narrow", () => {
		const { modelText, barWidth } = pickModelAndBarWidth(["abcdefghijklmnop"], 8);
		assert.equal(modelText, "");
		assert.equal(barWidth, 8);
	});
});

describe("renderChromeLine", () => {
	const dim = (text: string) => text;

	test("no context window shows fallback", () => {
		const line = renderChromeLine(
			snapshot({ contextWindow: 0 }),
			usage(),
			40,
			{ id: "opus", provider: "anthropic", reasoning: false },
			"off",
			1,
			dim,
		);
		assert.ok(line.includes("ctx unavailable"));
		assert.ok(line.includes("opus"));
	});

	test("normal line includes free metrics and model", () => {
		const segments = {
			...emptyContextSegments(),
			system: 100,
			prompt: 200,
			assistant: 300,
			tools: 100,
		};
		const line = renderChromeLine(
			snapshot({
				segments,
				usedTokens: 700,
				contextWindow: 2000,
			}),
			usage({ cacheHitRate: 92.3, cost: 0.042, input: 100, cacheRead: 900 }),
			100,
			{ id: "opus", provider: "anthropic", reasoning: true },
			"high",
			1,
			dim,
		);
		const plain = stripAnsi(line);
		assert.match(plain, /CH/);
		assert.ok(plain.includes("opus"));
		assert.ok(!plain.includes("↑"));
		assert.doesNotMatch(plain, /\bR\d/);
		assert.ok(plainWidth(plain) <= 100);
	});

	test("USED_SEGMENTS keys stable", () => {
		assert.deepEqual(
			USED_SEGMENTS.map((segment) => segment.key),
			["system", "prompt", "assistant", "thinking", "tools"],
		);
	});
});
