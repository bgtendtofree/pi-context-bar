import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withPendingReset } from "./pending-reset.ts";

test("record access is exclusive, private, durable before POST, and fail-closed on corrupt data", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-reset-store-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "pending.json");
	const pending = { accountId: "a", creditId: "c", requestId: "r" };
	await withPendingReset(path, async (store) => {
		assert.equal(await store.read(), undefined);
		await store.clear();
		await store.save(pending);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await stat(`${path}.lock`)).mode & 0o777, 0o700);
		assert.deepEqual(await store.read(), pending);
		await assert.rejects(store.save(pending), { code: "EEXIST" });
		await assert.rejects(
			withPendingReset(path, async () => assert.fail("contender entered")),
			/locked/,
		);
	});
	for (const contents of ["{", "{}"]) {
		await writeFile(path, contents);
		await assert.rejects(
			withPendingReset(path, async (store) => {
				await store.read();
			}),
			/corrupt|invalid/,
		);
		assert.equal(await readFile(path, "utf8"), contents);
	}
	await withPendingReset(path, async (store) => {
		await store.clear();
	});
	await mkdir(path);
	await withPendingReset(path, async (store) => {
		await assert.rejects(store.read(), { code: "EISDIR" });
		await assert.rejects(store.clear());
	});
	await assert.rejects(
		withPendingReset(join(dir, "missing", "pending"), async () => {}),
		{ code: "ENOENT" },
	);
	await assert.rejects(
		withPendingReset(path, async () => {
			throw new Error("cancelled");
		}),
		/cancelled/,
	);
	await assert.rejects(stat(`${path}.lock`), { code: "ENOENT" });
});

test("another process cannot enter; killed owner leaves a blocking lock without deleting pending", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-reset-process-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "pending.json");
	const pending = { accountId: "a", creditId: "old", requestId: "stable" };
	await withPendingReset(path, async (store) => {
		await store.save(pending);
	});
	const child = spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
		import { withPendingReset } from ${JSON.stringify(new URL("./pending-reset.ts", import.meta.url).href)};
		await withPendingReset(${JSON.stringify(path)}, async (store) => {
			await store.read();
			process.send("locked");
			await new Promise(resolve => process.once("message", resolve));
		});
	`,
		],
		{ stdio: ["ignore", "ignore", "inherit", "ipc"] },
	);
	t.after(() => {
		child.kill("SIGKILL");
	});
	assert.deepEqual(await once(child, "message"), ["locked", undefined]);
	await assert.rejects(
		withPendingReset(path, async () => assert.fail("second process entered")),
		/locked/,
	);
	const exit = once(child, "exit");
	child.kill("SIGKILL");
	await exit;
	await assert.rejects(
		withPendingReset(path, async () => assert.fail("stale lock was stolen")),
		/locked/,
	);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), pending);
	// Recovery only after owner is stopped. Keep the unknown request and its idempotency ID.
	await rmdir(`${path}.lock`);
	await withPendingReset(path, async (store) => {
		assert.deepEqual(await store.read(), pending);
	});
});
