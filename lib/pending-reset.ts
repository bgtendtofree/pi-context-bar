/** Cross-process reset transaction. All record access stays inside the exclusive lock. */
import { mkdir, open, readFile, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type PendingReset, parsePendingReset } from "./openai.ts";

/** A lock older than this whose owner is gone is reclaimed; younger locks always fail closed. */
const STALE_LOCK_MS = 60_000;
const LOCK_OWNER_FILE = "owner";

const errorCode = (error: unknown): string | undefined =>
	typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;

/** EPERM means the pid exists but belongs to another user; only ESRCH proves it is gone. */
const isProcessAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) !== "ESRCH";
	}
};

/** Owner state: a missing file means an abandoned lock; an unreadable one proves nothing. */
type LockOwner = "missing" | "unreadable" | number;

const readLockOwner = async (lock: string): Promise<LockOwner> => {
	let contents: string;
	try {
		contents = await readFile(`${lock}/${LOCK_OWNER_FILE}`, "utf8");
	} catch (error) {
		return errorCode(error) === "ENOENT" ? "missing" : "unreadable";
	}
	const pid = Number.parseInt(contents.trim(), 10);
	return Number.isInteger(pid) && pid > 0 ? pid : "unreadable";
};

/**
 * Reclaim a lock whose owner is provably gone: it is past the grace window and its pid is dead (or it
 * was abandoned between mkdir and the owner write). A live, unreadable, or unknown owner fails closed,
 * and a recycled pid only costs a manual lock removal.
 */
const reclaimStaleLock = async (lock: string, now: number): Promise<boolean> => {
	const info = await stat(lock).catch(() => undefined);
	if (!info || now - info.mtimeMs < STALE_LOCK_MS) return false;
	const owner = await readLockOwner(lock);
	if (owner === "unreadable") return false;
	if (typeof owner === "number" && (owner === process.pid || isProcessAlive(owner))) return false;
	await unlink(`${lock}/${LOCK_OWNER_FILE}`).catch(() => undefined);
	return rmdir(lock).then(
		() => true,
		() => false,
	);
};

type PendingResetStore = Readonly<{
	read: () => Promise<PendingReset | undefined>;
	save: (pending: PendingReset) => Promise<void>;
	sync: () => Promise<void>;
	clear: () => Promise<void>;
}>;

/** fsync the parent directory so a newly created record's filename survives power loss. */
const syncDir = async (path: string): Promise<void> => {
	const parent = await open(dirname(path), "r");
	try {
		await parent.sync();
	} finally {
		await parent.close();
	}
};

/** Fail closed on abandoned locks: never guess whether another process can still POST. */
export const withPendingReset = async (
	path: string,
	run: (store: PendingResetStore) => Promise<void>,
): Promise<void> => {
	const lock = `${path}.lock`;
	const locked = (): Error =>
		new Error(
			`Reset request locked: ${lock}. Retry after the other command finishes. If abandoned, stop all Pi processes sharing this agent directory before removing only the lock directory; keep the pending record.`,
		);
	try {
		await mkdir(lock, { mode: 0o700 });
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
		if (!(await reclaimStaleLock(lock, Date.now()))) throw locked();
		try {
			await mkdir(lock, { mode: 0o700 });
		} catch (retryError) {
			if (errorCode(retryError) !== "EEXIST") throw retryError;
			throw locked();
		}
	}
	// The owner file is what makes a lock reclaimable, so a failed write releases the lock instead.
	await writeFile(`${lock}/${LOCK_OWNER_FILE}`, `${process.pid}\n`, { mode: 0o600 }).catch(async (error: unknown) => {
		await rmdir(lock).catch(() => undefined);
		throw error;
	});
	// ponytail: one lock per agent directory, including dialogs; per-account locks only if contention matters.
	try {
		await run({
			read: async () => {
				let contents: string;
				try {
					contents = await readFile(path, "utf8");
				} catch (error) {
					if (errorCode(error) === "ENOENT") return undefined;
					throw error;
				}
				let payload: unknown;
				try {
					payload = JSON.parse(contents) as unknown;
				} catch {
					throw new Error("Pending reset record is corrupt; verify reset status before using forget-pending");
				}
				const pending = parsePendingReset(payload);
				if (!pending)
					throw new Error("Pending reset record is invalid; verify reset status before using forget-pending");
				return pending;
			},
			save: async (pending) => {
				const file = await open(path, "wx", 0o600);
				try {
					await file.writeFile(JSON.stringify(pending), "utf8");
					await file.sync();
				} finally {
					await file.close();
				}
				// Record must be durable on disk, not just in cache, before any POST starts.
				await syncDir(path);
			},
			sync: async () => {
				const file = await open(path, "r");
				try {
					await file.sync();
				} finally {
					await file.close();
				}
				await syncDir(path);
			},
			clear: async () => {
				try {
					await unlink(path);
				} catch (error) {
					if (errorCode(error) !== "ENOENT") throw error;
					return;
				}
				// Same durability rule as save: a cleared record must not resurrect after a crash.
				await syncDir(path);
			},
		});
	} finally {
		// Best-effort cleanup: lock removal must never mask the reset outcome. The owner file has to
		// go first because rmdir refuses a non-empty directory.
		await unlink(`${lock}/${LOCK_OWNER_FILE}`).catch(() => undefined);
		await rmdir(lock).catch(() => undefined);
	}
};
