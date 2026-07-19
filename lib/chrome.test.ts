import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	type AssistantUsage,
	accumulateSessionUsage,
	allocateProportionally,
	type ContextSnapshot,
	cacheHitRate,
	dominantSegments,
	editorModelOptions,
	emptyContextSegments,
	estimateContentTokens,
	estimateTextTokens,
	FREE_SEGMENT_TEXT,
	FREE_SEGMENT_TEXT_FULL,
	FREE_SEGMENT_TEXT_HOT,
	fitStyledText,
	foreground,
	formatCost,
	formatTokens,
	freeMetricOptions,
	freeTextColor,
	GHOST_GLYPH,
	gitLabelOptions,
	IMAGE_TOKEN_ESTIMATE,
	LANE_ACTIVITY_TEXT,
	makeContextSnapshot,
	PACMAN_FRAMES,
	PACMAN_GLYPH,
	PACMAN_LANE_MAX_WIDTH,
	PELLET_GLYPH,
	parseGitStatus,
	pickEditorBorderLabels,
	pickFirstFitting,
	plainWidth,
	renderChromeLine,
	renderLabeledBorder,
	renderPacmanLane,
	type SessionUsage,
	scaleSegmentsToUsage,
	segmentMixText,
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

	test("trailing no-usage assistant turn does not wipe CH%", () => {
		const result = accumulateSessionUsage([
			{
				type: "message",
				message: {
					role: "assistant",
					usage: assistantUsage({ input: 10, cacheRead: 90, cacheWrite: 0 }),
				},
			},
			// Trailing assistant turn with zero prompt tokens (error/partial) must not blank CH%.
			{
				type: "message",
				message: { role: "assistant", usage: assistantUsage() },
			},
		]);

		assert.equal(result.cacheHitRate, 90);
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
	const snap = snapshot({
		segments: { system: 3200, prompt: 75, assistant: 11_000, thinking: 701, tools: 43_000 },
		usedTokens: 57_976,
		contextWindow: 372_000,
	});

	test("widest is right-grouped usage, dominant mix, CH, and cost", () => {
		const options = freeMetricOptions(snap, full);
		assert.equal(options[0], "15.6%   ≈ X74 A19 S6   CH92%  $0.042");
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

describe("segment analytics and metric styling", () => {
	const dominantSnapshot = snapshot({
		segments: { system: 3200, prompt: 75, assistant: 11_000, thinking: 701, tools: 43_000 },
		usedTokens: 57_976,
	});

	test("dominant mix shows top three rounded shares", () => {
		assert.equal(segmentMixText(snapshot()), "");
		assert.deepEqual(dominantSegments(dominantSnapshot, 0), []);
		assert.equal(segmentMixText(dominantSnapshot), "≈ X74 A19 S6");
		assert.deepEqual(
			dominantSegments(dominantSnapshot).map(({ label, percent }) => [label, percent]),
			[
				["X", 74],
				["A", 19],
				["S", 6],
			],
		);
	});

	test("cost precision stays quiet", () => {
		assert.equal(formatCost(0), "");
		assert.equal(formatCost(0.042), "$0.042");
		assert.equal(formatCost(1.61), "$1.61");
	});

	test("styleFreeMetrics accents visible segment labels, CH, and usage", () => {
		const plain = "15.7%   ≈ X74 A19 S6   CH98%  $1.61";
		const styled = styleFreeMetrics(plain, 15.7);
		assert.ok(styled.includes("CH98%"));
		assert.ok(styled.includes("$1.61"));
		for (const label of ["X", "A", "S"]) {
			const segment = USED_SEGMENTS.find((candidate) => candidate.label === label);
			assert.ok(segment && styled.includes(foreground(segment.color, label)));
		}
		assert.equal(stripAnsi(styled), plain);
		assert.equal(stripAnsi(styleFreeMetrics("≈ Z9   note", 10)), "≈    note");
		assert.equal(styleFreeMetrics("", 10), "");
	});
});

describe("Pac-Man lane", () => {
	test("moves left to right while eaten pellets become empty space", () => {
		const segments = { ...emptyContextSegments(), system: 100 };
		const empty = stripAnsi(renderPacmanLane(snapshot({ segments, usedTokens: 0, contextWindow: 100 }), 18));
		const half = stripAnsi(renderPacmanLane(snapshot({ segments, usedTokens: 50, contextWindow: 100 }), 18));
		const full = stripAnsi(renderPacmanLane(snapshot({ segments, usedTokens: 100, contextWindow: 100 }), 18));

		assert.equal(plainWidth(empty), 18);
		assert.equal(plainWidth(half), 18);
		assert.equal(plainWidth(full), 18);
		assert.equal(empty.split(PELLET_GLYPH).length - 1, 8);
		assert.equal(half.split(PELLET_GLYPH).length - 1, 4);
		assert.equal(half.indexOf(PACMAN_GLYPH), 8);
		assert.equal(empty.startsWith(PACMAN_GLYPH), true);
		assert.equal(full.trimEnd().endsWith(PACMAN_GLYPH), true);
		assert.equal(full.includes(PELLET_GLYPH), false);
	});

	test("alternates mouth frames without resurrecting a pellet", () => {
		const open = stripAnsi(renderPacmanLane(snapshot(), 10, 0));
		const closed = stripAnsi(renderPacmanLane(snapshot(), 10, 1));

		assert.ok(open.includes(PACMAN_FRAMES[0]));
		assert.ok(closed.includes(PACMAN_FRAMES[1]));
		assert.equal(open.split(PELLET_GLYPH).length - 1, 4);
		assert.equal(closed.split(PELLET_GLYPH).length - 1, 4);
		assert.equal(plainWidth(open), plainWidth(closed));
	});

	test("shows a phase-colored ghost only while the agent runs", () => {
		const activeSnapshot = snapshot({
			segments: { ...emptyContextSegments(), assistant: 100 },
			usedTokens: 100,
			contextWindow: 100,
		});
		const idle = renderPacmanLane(activeSnapshot, 18, 0, "idle");
		assert.equal(stripAnsi(idle).includes(GHOST_GLYPH), false);

		const activities = [
			["working", LANE_ACTIVITY_TEXT.working],
			["thinking", LANE_ACTIVITY_TEXT.thinking],
			["assistant", LANE_ACTIVITY_TEXT.assistant],
			["tools", LANE_ACTIVITY_TEXT.tools],
		] as const;

		for (const [activity, color] of activities) {
			const lane = renderPacmanLane(activeSnapshot, 18, 0, activity);
			assert.ok(lane.includes(foreground(color, `${GHOST_GLYPH} `)));
			assert.equal(plainWidth(lane), 18);
			assert.equal(stripAnsi(lane).split(PELLET_GLYPH).length - 1, 0);
		}
	});

	test("moves the ghost between two chase distances without changing width", () => {
		const activeSnapshot = snapshot({ usedTokens: 100, contextWindow: 100 });
		const close = stripAnsi(renderPacmanLane(activeSnapshot, 18, 0, "working"));
		const far = stripAnsi(renderPacmanLane(activeSnapshot, 18, 2, "working"));

		assert.ok(close.indexOf(GHOST_GLYPH) > far.indexOf(GHOST_GLYPH));
		assert.equal(plainWidth(close), 18);
		assert.equal(plainWidth(far), 18);
	});

	test("omits the ghost when consumed trail is too short", () => {
		const lane = stripAnsi(renderPacmanLane(snapshot({ usedTokens: 25, contextWindow: 100 }), 10, 0, "tools"));
		assert.equal(lane.includes(GHOST_GLYPH), false);
		assert.equal(plainWidth(lane), 10);
	});

	test("handles tiny widths and missing segment estimates", () => {
		assert.equal(renderPacmanLane(snapshot(), 0), "");
		assert.equal(stripAnsi(renderPacmanLane(snapshot(), 1)), PACMAN_GLYPH);

		const fallback = stripAnsi(renderPacmanLane(snapshot({ usedTokens: 100, contextWindow: 100 }), 10));
		assert.equal(plainWidth(fallback), 10);
		assert.equal(fallback.trimEnd().endsWith(PACMAN_GLYPH), true);

		const unknown = stripAnsi(renderPacmanLane(snapshot({ usedTokens: 0, contextWindow: 0 }), 10));
		assert.equal(unknown.startsWith(PACMAN_GLYPH), true);
		assert.equal(unknown.split(PELLET_GLYPH).length - 1, 4);

		const overfull = stripAnsi(renderPacmanLane(snapshot({ usedTokens: 200, contextWindow: 100 }), 10));
		assert.equal(overfull.trimEnd().endsWith(PACMAN_GLYPH), true);
		const negative = stripAnsi(renderPacmanLane(snapshot({ usedTokens: -10, contextWindow: 100 }), 10));
		assert.equal(negative.startsWith(PACMAN_GLYPH), true);
		assert.equal(negative.split(PELLET_GLYPH).length - 1, 4);
	});
});

describe("editor border metadata", () => {
	test("model options keep model before thinking", () => {
		assert.deepEqual(editorModelOptions(null, "high"), ["no-model", "?"]);
		const model = { id: "anthropic/claude-opus", provider: "anthropic", reasoning: true };
		const options = editorModelOptions(model, "high");
		assert.equal(options[0], "anthropic/claude-opus · high");
		assert.ok(options.includes("claude-opus · high"));
		assert.ok(options.includes("claude-opus"));
		assert.deepEqual(editorModelOptions({ id: "gpt-4o", provider: "openai", reasoning: false }, "high"), ["gpt-4o"]);
		assert.ok(
			editorModelOptions({ id: "provider/a-very-long-model-name", provider: "p", reasoning: false }, "off").some(
				(option) => option.endsWith("…"),
			),
		);
	});

	test("parses porcelain v2 Git status", () => {
		const git = parseGitStatus(
			[
				"# branch.oid 4c9909b45af61b3e5fcd75b8196555911bd327dd",
				"# branch.head main",
				"# branch.ab +2 -1",
				"1 M. N... 100644 100644 100644 abc abc staged.ts",
				"1 .M N... 100644 100644 100644 abc abc changed.ts",
				"? new.ts",
			].join("\n"),
		);
		assert.deepEqual(git, {
			branch: "main",
			detachedOid: "4c9909b",
			ahead: 2,
			behind: 1,
			staged: 1,
			unstaged: 1,
			untracked: 1,
		});
		assert.equal(gitLabelOptions(git)[0], "⎇ main +1 *1 ?1 ↑2 ↓1");
	});

	test("supports clean, detached, initial, and unusual Git states", () => {
		const clean = parseGitStatus("# branch.oid abcdef123\n# branch.head main\n");
		assert.deepEqual(gitLabelOptions(clean), ["⎇ main"]);
		const detached = parseGitStatus("# branch.oid abcdef123\n# branch.head (detached)\n");
		assert.deepEqual(gitLabelOptions(detached), ["⎇ @abcdef1"]);
		const unusual = parseGitStatus(
			"# branch.oid (initial)\n# branch.head (detached)\n# branch.ab malformed\n2 .. rest\nu UU rest\nignored\n",
		);
		assert.equal(unusual?.unstaged, 1);
		assert.deepEqual(gitLabelOptions(unusual), []);
		assert.deepEqual(gitLabelOptions(null), []);
		assert.equal(parseGitStatus(""), null);
	});

	test("picks fitting labels and renders exact-width rounded border", () => {
		const picked = pickEditorBorderLabels(["gpt-5.6-sol · medium", "gpt-5.6-sol"], ["⎇ main ?1", "⎇ main"], 48);
		assert.deepEqual(picked, { modelLabel: "gpt-5.6-sol · medium", gitLabel: "⎇ main ?1" });
		const border = renderLabeledBorder(48, "╰", "╯", picked.modelLabel, picked.gitLabel, (text) => text);
		assert.equal(plainWidth(border), 48);
		assert.ok(border.startsWith("╰─ gpt-5.6-sol · medium "));
		assert.ok(border.endsWith(" ⎇ main ?1 ──╯"));
		assert.equal(
			renderLabeledBorder(1, "╰", "╯", "", "", (text) => text),
			"─",
		);
		assert.equal(
			renderLabeledBorder(0, "╰", "╯", "", "", (text) => text),
			"",
		);
		assert.equal(plainWidth(renderLabeledBorder(12, "╰", "╯", "", "", (text) => text)), 12);
		assert.deepEqual(pickEditorBorderLabels(["model"], ["⎇ branch"], 14), {
			modelLabel: "model",
			gitLabel: "",
		});
		assert.deepEqual(pickEditorBorderLabels(["long-model"], ["⎇ branch"], 5), {
			modelLabel: "",
			gitLabel: "",
		});
	});
});

describe("renderChromeLine", () => {
	const dim = (text: string) => text;

	test("no context window shows right-aligned fallback", () => {
		assert.equal(renderChromeLine(snapshot(), usage(), 0, dim), "");
		assert.equal(renderChromeLine(snapshot(), usage(), 1, dim), "·");
		const line = renderChromeLine(snapshot({ contextWindow: 0 }), usage(), 40, dim);
		assert.ok(line.includes("ctx unavailable"));
		assert.equal(plainWidth(line), 40);
		assert.equal(line.startsWith(" "), true);
		assert.equal(line.endsWith(" "), true);
	});

	test("normal line keeps lane left and dominant metrics right", () => {
		const segments = { system: 3200, prompt: 75, assistant: 11_000, thinking: 701, tools: 43_000 };
		const line = renderChromeLine(
			snapshot({ segments, usedTokens: 57_976, contextWindow: 372_000 }),
			usage({ cacheHitRate: 97.9, cost: 1.61, input: 100, cacheRead: 900 }),
			100,
			dim,
			0,
			"assistant",
		);
		const plain = stripAnsi(line);
		assert.ok(plain.includes("15.6%   ≈ X74 A19 S6   CH98%  $1.61"));
		assert.ok(!plain.includes("mix~"));
		assert.equal(plainWidth(plain), 100);
		assert.equal(plain.startsWith(" "), true);
		assert.equal(plain.endsWith("$1.61 "), true);
		assert.ok(plain.includes(PACMAN_GLYPH));
		assert.ok(plain.includes(GHOST_GLYPH));
		assert.equal(line.includes("\x1b[48;"), false);
	});

	test("caps lane on ultra-wide terminals and keeps metrics at inner right edge", () => {
		const line = renderChromeLine(snapshot(), usage({ cacheHitRate: 90 }), 240, dim);
		const plain = stripAnsi(line);

		assert.equal(plainWidth(plain), 240);
		assert.equal(plain.split(PELLET_GLYPH).length - 1, PACMAN_LANE_MAX_WIDTH / 2 - 1);
		assert.ok((plain.indexOf("0.0%") ?? 0) > PACMAN_LANE_MAX_WIDTH);
		assert.equal(plain.endsWith("CH90% "), true);
	});

	test("USED_SEGMENTS keys stable", () => {
		assert.deepEqual(
			USED_SEGMENTS.map((segment) => segment.key),
			["system", "prompt", "assistant", "thinking", "tools"],
		);
	});
});
