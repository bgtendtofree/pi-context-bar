import assert from "node:assert/strict";
import { test } from "node:test";
import { splitEditorRender } from "./rounded-editor.ts";

test("keeps autocomplete outside editor shell", () => {
	assert.deepEqual(splitEditorRender(["────", "prompt", "────", "command 1", "command 2"]), {
		editor: ["────", "prompt", "────"],
		autocomplete: ["command 1", "command 2"],
	});
	assert.deepEqual(splitEditorRender(["prompt"]), { editor: ["prompt"], autocomplete: [] });
});
