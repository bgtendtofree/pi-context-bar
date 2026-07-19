import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { gitLabelOptions, gitLabelTone, parseGitStatus, sameGitState } from "./git.ts";

describe("Git porcelain v2", () => {
	test("parses branch, sync, and worktree counts", () => {
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
		assert.deepEqual(gitLabelOptions(git), ["⎇ main +1 *1 ?1 ↑2 ↓1", "⎇ main +1 *1 ?1", "⎇ main ●", "⎇ main"]);
	});

	test("compares immutable snapshots", () => {
		const clean = parseGitStatus("# branch.oid abcdef123\n# branch.head main\n");
		const same = parseGitStatus("# branch.oid abcdef123\n# branch.head main\n");
		const dirty = parseGitStatus("# branch.oid abcdef123\n# branch.head main\n? new.ts\n");
		assert.equal(sameGitState(clean, clean), true);
		assert.equal(sameGitState(clean, same), true);
		assert.equal(sameGitState(clean, dirty), false);
		assert.equal(sameGitState(clean, null), false);
		assert.equal(sameGitState(null, null), true);
	});

	test("colors only dirty and sync markers", () => {
		assert.equal(gitLabelTone("⎇", 0), "dim");
		assert.equal(gitLabelTone("main", 1), "dim");
		assert.equal(gitLabelTone("+2", 2), "success");
		assert.equal(gitLabelTone("↑1", 2), "success");
		assert.equal(gitLabelTone("*3", 2), "warning");
		assert.equal(gitLabelTone("?4", 2), "warning");
		assert.equal(gitLabelTone("●", 2), "warning");
		assert.equal(gitLabelTone("↓1", 2), "error");
		assert.equal(gitLabelTone("other", 2), "muted");
	});

	test("supports clean and detached states", () => {
		const clean = parseGitStatus("# branch.oid abcdef123\n# branch.head main\n");
		assert.deepEqual(gitLabelOptions(clean), ["⎇ main"]);
		const detached = parseGitStatus("# branch.oid abcdef123\n# branch.head (detached)\n");
		assert.deepEqual(gitLabelOptions(detached), ["⎇ @abcdef1"]);
	});

	test("handles initial, unmerged, and malformed status", () => {
		const unusual = parseGitStatus(
			"# branch.oid (initial)\n# branch.head (detached)\n# branch.ab malformed\n2 .. rest\nu UU rest\nignored\n",
		);
		assert.equal(unusual?.unstaged, 1);
		assert.deepEqual(gitLabelOptions(unusual), []);
		assert.deepEqual(gitLabelOptions(null), []);
		assert.equal(parseGitStatus(""), null);
	});
});
