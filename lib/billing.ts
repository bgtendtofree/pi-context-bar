/** Billing-marker recovery for forks: read the parent session safely and re-append markers. */

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import {
	hasParentMarkersCheck,
	hasRecoverableBilling,
	PARENT_MARKERS_CHECKED_ENTRY,
	recoverableSubscriptionMarkers,
	SUBSCRIPTION_TURN_ENTRY,
} from "./context.ts";

/** Guard the untrusted parent path: a FIFO read would hang and a huge file would stall startup. */
const MAX_PARENT_SESSION_BYTES = 64 * 1024 * 1024;

/** Read a parent session through one descriptor: nonblocking open, fstat the descriptor, bounded read. */
const readParentSessionEntries = (path: string): readonly SessionEntry[] | undefined => {
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
		const info = fstatSync(fd);
		if (!info.isFile() || info.size > MAX_PARENT_SESSION_BYTES) return undefined;
		const buffer = Buffer.allocUnsafe(info.size);
		let offset = 0;
		while (offset < buffer.length) {
			const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
			if (read <= 0) break;
			offset += read;
		}
		return parseSessionEntries(buffer.subarray(0, offset).toString("utf8")).filter(
			(entry): entry is SessionEntry => entry.type !== "session",
		);
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
};

/** Re-append billing markers retained as ancestors when a fork copies a response into a new session. */
export const recoverForkSubscriptionMarkers = (pi: ExtensionAPI, ctx: ExtensionContext): void => {
	const parent = ctx.sessionManager.getHeader?.()?.parentSession;
	if (!parent) return;
	const entries = ctx.sessionManager.getEntries();
	// The sentinel names its parent, so a sentinel copied through another fork cannot skip this one.
	if (hasParentMarkersCheck(entries, parent)) return;
	// A marker only re-classifies a billed, non-plan response, so skip the parent read when none is present.
	if (hasRecoverableBilling(entries)) {
		const parentEntries = readParentSessionEntries(parent);
		// Leave the sentinel unwritten on a failed read so the next start can retry it.
		if (!parentEntries) return;
		for (const messageEntryId of recoverableSubscriptionMarkers(entries, parentEntries))
			pi.appendEntry(SUBSCRIPTION_TURN_ENTRY, { messageEntryId });
	}
	pi.appendEntry(PARENT_MARKERS_CHECKED_ENTRY, { parentSession: parent });
};
