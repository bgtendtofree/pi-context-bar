import { execFileSync } from "node:child_process";
import { mkdtempDisposableSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const PI_VERSION = manifest.devDependencies["@earendil-works/pi-coding-agent"];
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
execFileSync(
	"npm",
	[
		"install",
		"--no-audit",
		"--no-fund",
		"--omit=dev",
		`@earendil-works/pi-coding-agent@${PI_VERSION}`,
		join(cwd, filename),
	],
	{
		cwd,
		stdio: "inherit",
	},
);

const installedPackage = join(cwd, "node_modules", ...manifest.name.split("/"));
// --list-models exits before Pi reports runtime extension errors.
const smoke = `
import assert from "node:assert/strict";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
const result = await discoverAndLoadExtensions([process.argv[1]], process.cwd(), "./agent");
assert.deepEqual(result.errors, []);
assert.equal(result.extensions.length, ${manifest.pi.extensions.length});
`;
execFileSync(process.execPath, ["--input-type=module", "-e", smoke, installedPackage], {
	cwd,
	stdio: "inherit",
});
console.log(`Packed runtime smoke passed: ${manifest.name} with Pi ${PI_VERSION} on Node ${process.versions.node}`);
