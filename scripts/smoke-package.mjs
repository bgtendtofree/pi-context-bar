import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const workspace = mkdtempSync(join(tmpdir(), "pi-package-smoke-"));

try {
	const packOutput = run("npm", ["pack", "--json", "--pack-destination", workspace], root, true);
	const [{ filename }] = JSON.parse(packOutput);
	// ponytail: bare --prefix install — npm creates the host manifest/node_modules and auto-installs peers
	run("npm", ["install", "--no-audit", "--no-fund", "--omit=dev", join(workspace, filename)], workspace);

	const installedPackage = join(workspace, "node_modules", ...manifest.name.split("/"));
	const piBinary = join(workspace, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
	run(piBinary, ["--offline", "--no-extensions", "-e", installedPackage, "--list-models"], workspace);
	console.log(`Packed runtime smoke passed: ${manifest.name} on Node ${process.versions.node}`);
} finally {
	rmSync(workspace, { recursive: true, force: true });
}

function run(command, args, cwd, capture = false) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? "unknown"}`);
	return result.stdout ?? "";
}
