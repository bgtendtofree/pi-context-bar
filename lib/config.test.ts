import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { DEFAULT_CONFIG, readConfig } from "./config.ts";

const tempDirs: string[] = [];
const tempConfig = (content: string | undefined): string => {
	const dir = mkdtempSync(join(tmpdir(), "pi-context-bar-"));
	tempDirs.push(dir);
	const path = join(dir, "pi-context-bar.json");
	if (content !== undefined) writeFileSync(path, content);
	return path;
};

// Only remove temp dirs this test suite created.
after(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("readConfig", () => {
	test("missing file falls back to defaults", () => {
		assert.deepEqual(readConfig(tempConfig(undefined)), DEFAULT_CONFIG);
	});

	test("asciiFallback true is honored", () => {
		assert.deepEqual(readConfig(tempConfig('{ "asciiFallback": true }')), { asciiFallback: true });
	});

	test("explicit false stays on Nerd glyphs", () => {
		assert.deepEqual(readConfig(tempConfig('{ "asciiFallback": false }')), DEFAULT_CONFIG);
	});

	test("corrupt JSON and non-object payloads fall back silently", () => {
		assert.deepEqual(readConfig(tempConfig("{ not json")), DEFAULT_CONFIG);
		assert.deepEqual(readConfig(tempConfig("[1, 2]")), DEFAULT_CONFIG);
		assert.deepEqual(readConfig(tempConfig('"string"')), DEFAULT_CONFIG);
	});

	test("unknown keys and wrong types are ignored", () => {
		assert.deepEqual(readConfig(tempConfig('{ "asciiFallback": "yes", "other": 1 }')), DEFAULT_CONFIG);
	});
});
