/** Pure parsing and compact display options for local Git status. */

export type GitState = Readonly<{
	branch: string | null;
	detachedOid: string | null;
	ahead: number;
	behind: number;
	staged: number;
	unstaged: number;
	untracked: number;
}>;

export const parseGitStatus = (output: string): GitState | null => {
	let branch: string | null = null;
	let detachedOid: string | null = null;
	let ahead = 0;
	let behind = 0;
	let staged = 0;
	let unstaged = 0;
	let untracked = 0;
	let sawStatus = false;

	for (const line of output.split("\n")) {
		if (!line) continue;
		sawStatus = true;
		if (line.startsWith("# branch.head ")) {
			const head = line.slice("# branch.head ".length).trim();
			branch = head && head !== "(detached)" ? head : null;
			continue;
		}
		if (line.startsWith("# branch.oid ")) {
			const oid = line.slice("# branch.oid ".length).trim();
			detachedOid = oid && oid !== "(initial)" ? oid.slice(0, 7) : null;
			continue;
		}
		if (line.startsWith("# branch.ab ")) {
			const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
			if (match) {
				ahead = Number.parseInt(match[1] ?? "0", 10);
				behind = Number.parseInt(match[2] ?? "0", 10);
			}
			continue;
		}
		if (line.startsWith("? ")) {
			untracked++;
			continue;
		}
		if (line.startsWith("1 ") || line.startsWith("2 ")) {
			const status = line.slice(2, 4);
			if ((status[0] ?? ".") !== ".") staged++;
			if ((status[1] ?? ".") !== ".") unstaged++;
			continue;
		}
		if (line.startsWith("u ")) unstaged++;
	}

	return sawStatus ? { branch, detachedOid, ahead, behind, staged, unstaged, untracked } : null;
};

export type GitLabelTone = "dim" | "muted" | "success" | "warning" | "error";

export const gitLabelTone = (part: string, index: number): GitLabelTone => {
	if (index <= 1) return "dim";
	if (part.startsWith("+") || part.startsWith("↑")) return "success";
	if (part.startsWith("*") || part.startsWith("?") || part === "●") return "warning";
	if (part.startsWith("↓")) return "error";
	return "muted";
};

export const gitLabelOptions = (git: GitState | null): readonly string[] => {
	if (!git) return [];
	const head = git.branch ?? (git.detachedOid ? `@${git.detachedOid}` : "");
	if (!head) return [];

	const changes = [
		git.staged > 0 ? `+${git.staged}` : "",
		git.unstaged > 0 ? `*${git.unstaged}` : "",
		git.untracked > 0 ? `?${git.untracked}` : "",
	].filter(Boolean);
	const sync = [git.ahead > 0 ? `↑${git.ahead}` : "", git.behind > 0 ? `↓${git.behind}` : ""].filter(Boolean);
	const branch = `⎇ ${head}`;
	const dirty = changes.length > 0 ? `${branch} ●` : branch;

	return [[branch, ...changes, ...sync].join(" "), [branch, ...changes].join(" "), dirty, branch].filter(Boolean);
};
