import { execFileSync } from "node:child_process";
import { mkdtempDisposableSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// Guard: every runtime source file must ship in the tarball; a missing file breaks the installed extension silently.
const shipped = new Set(manifest.files);
const missing = ["lib", "ui"].flatMap((dir) =>
	readdirSync(join(root, dir))
		.filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !shipped.has(`${dir}/${file}`))
		.map((file) => `${dir}/${file}`),
);
if (missing.length > 0) {
	console.error(`package.json files is missing runtime sources: ${missing.join(", ")}`);
	process.exit(1);
}
using workspace = mkdtempDisposableSync(join(tmpdir(), "pi-package-smoke-"));
const cwd = workspace.path;

const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", cwd], {
	cwd: root,
	encoding: "utf8",
	stdio: ["ignore", "pipe", "inherit"],
});
const [{ filename }] = JSON.parse(packOutput);
// ponytail: bare --prefix install — npm creates the host manifest/node_modules and auto-installs peers
execFileSync("npm", ["install", "--no-audit", "--no-fund", "--omit=dev", join(cwd, filename)], {
	cwd,
	stdio: "inherit",
});

const installedPackage = join(cwd, "node_modules", ...manifest.name.split("/"));
const piBinary = join(cwd, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
execFileSync(piBinary, ["--offline", "--no-extensions", "-e", installedPackage, "--list-models"], {
	cwd,
	stdio: "inherit",
});
console.log(`Packed runtime smoke passed: ${manifest.name} on Node ${process.versions.node}`);
