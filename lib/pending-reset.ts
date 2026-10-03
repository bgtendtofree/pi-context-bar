/** Cross-process reset transaction. All record access stays inside the exclusive lock. */
import { mkdir, open, readFile, rmdir, unlink } from "node:fs/promises";
import { type PendingReset, parsePendingReset } from "./openai.ts";

const errorCode = (error: unknown): string | undefined =>
	typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;

type PendingResetStore = Readonly<{
	read: () => Promise<PendingReset | undefined>;
	save: (pending: PendingReset) => Promise<void>;
	clear: () => Promise<void>;
}>;

/** Fail closed on abandoned locks: never guess whether another process can still POST. */
export const withPendingReset = async (
	path: string,
	run: (store: PendingResetStore) => Promise<void>,
): Promise<void> => {
	const lock = `${path}.lock`;
	try {
		await mkdir(lock, { mode: 0o700 });
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
		throw new Error(
			`Reset request locked: ${lock}. Retry after the other command finishes. If abandoned, stop all Pi processes sharing this agent directory before removing only the lock directory; keep the pending record.`,
		);
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
			},
			clear: async () => {
				try {
					await unlink(path);
				} catch (error) {
					if (errorCode(error) !== "ENOENT") throw error;
				}
			},
		});
	} finally {
		await rmdir(lock);
	}
};
