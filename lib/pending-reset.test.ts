import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { shouldSyncDirectory, withPendingReset } from "./pending-reset.ts";

test("skips the directory fsync where the platform rejects it", () => {
	assert.equal(shouldSyncDirectory("win32"), false);
	assert.equal(shouldSyncDirectory("darwin"), true);
	assert.equal(shouldSyncDirectory("linux"), true);
});

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
		await store.sync();
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
		await assert.rejects(store.sync(), { code: "ENOENT" });
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
	// Recovery only after the owner is stopped. Keep the unknown request and its idempotency ID.
	await rm(`${path}.lock`, { recursive: true, force: true });
	await withPendingReset(path, async (store) => {
		assert.deepEqual(await store.read(), pending);
	});
});

test("old, dead-owner, and ownerless locks all fail closed without deleting pending", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-reset-stale-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "pending.json");
	const lock = `${path}.lock`;
	const pending = { accountId: "a", creditId: "c", requestId: "r" };
	const past = new Date(Date.now() - 10 * 60 * 1000);
	await withPendingReset(path, async (store) => {
		await store.save(pending);
	});
	const corpse = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
	const deadPid = corpse.pid ?? 0;
	await once(corpse, "exit");

	// Locks never expire automatically. Reclaiming one lets two contenders each read the old owner,
	// so the loser can unlink the winner's live lock and run a second callback alongside it.
	for (const owner of [undefined, `${deadPid}\n`, `${process.pid}\n`]) {
		await mkdir(lock, { mode: 0o700 });
		if (owner !== undefined) await writeFile(join(lock, "owner"), owner);
		await utimes(lock, past, past);
		await assert.rejects(
			withPendingReset(path, async () => assert.fail("an existing lock was reclaimed")),
			/locked/,
		);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), pending);
		await rm(lock, { recursive: true, force: true });
	}
});

test("simultaneous contenders never both enter the callback", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-reset-race-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "pending.json");
	const pending = { accountId: "a", creditId: "c", requestId: "r" };
	await withPendingReset(path, async (store) => {
		await store.save(pending);
	});
	const moduleUrl = JSON.stringify(new URL("./pending-reset.ts", import.meta.url).href);
	const script = `
		import { withPendingReset } from ${moduleUrl};
		process.on("message", async (message) => {
			if (message !== "go") return;
			try {
				await withPendingReset(${JSON.stringify(path)}, async (store) => {
					await store.read();
					process.send("entered");
					await new Promise((resolve) => process.once("message", resolve));
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				process.send(message.includes("locked") ? "blocked" : "error:" + message);
			}
			process.exit(0);
		});
		process.send("ready");
	`;
	const children = Array.from({ length: 4 }, () =>
		spawn(process.execPath, ["--input-type=module", "-e", script], {
			stdio: ["ignore", "ignore", "inherit", "ipc"],
		}),
	);
	t.after(() => {
		for (const child of children) child.kill("SIGKILL");
	});
	// Register exit promises before anything can exit: a blocked child exits as soon as it reports.
	const exits = children.map((child) => once(child, "exit"));
	const waitMessage = (child: (typeof children)[number]): Promise<string> =>
		new Promise((resolve) => child.once("message", (message) => resolve(String(message))));
	await Promise.all(children.map(waitMessage));
	for (const child of children) child.send("go");
	const outcomes = await Promise.all(children.map(waitMessage));
	for (const outcome of outcomes)
		assert.ok(outcome === "entered" || outcome === "blocked", `unexpected child outcome: ${outcome}`);
	assert.equal(outcomes.filter((outcome) => outcome === "entered").length, 1);
	assert.equal(outcomes.filter((outcome) => outcome === "blocked").length, children.length - 1);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), pending);
	children[outcomes.indexOf("entered")]?.send("release");
	await Promise.all(exits);
});
