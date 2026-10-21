/** Cross-process reset transaction. All record access stays inside the exclusive lock. */
import { mkdir, open, readFile, rmdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { type PendingReset, parsePendingReset } from "./openai.ts";

const errorCode = (error: unknown): string | undefined =>
	typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;

type PendingResetStore = Readonly<{
	read: () => Promise<PendingReset | undefined>;
	save: (pending: PendingReset) => Promise<void>;
	sync: () => Promise<void>;
	clear: () => Promise<void>;
}>;

/** Directory fsync is POSIX-only; Windows rejects it and the record file is already synced. */
export const shouldSyncDirectory = (platform: string = process.platform): boolean => platform !== "win32";

/** fsync the parent directory so a newly created record's filename survives power loss. */
const syncDir = async (path: string): Promise<void> => {
	if (!shouldSyncDirectory()) return;
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
		// Fail closed on every existing lock, old or ownerless included. Any automatic reclamation races
		// two contenders that both read the old owner: the loser can delete the winner's live lock and
		// run its callback alongside it. Only the documented manual recovery is safe.
		throw locked();
	}
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
		// Best-effort cleanup: lock removal must never mask the reset outcome.
		await rmdir(lock).catch(() => undefined);
	}
};
