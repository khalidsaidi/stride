// Builds the `stride` command as one executable with Node inside (Node's single executable applications): the
// command line, compiler, virtual machine and standard library bundled into one script, with the guides, the
// workflow page and the VS Code extension built in, which is put into a copy of the node binary. Its build identity
// is the day it was built and a hash of every file that went into it, so two builds of the same sources say so.
// Output: dist/stride, and with --windows <node.exe>, dist/stride.exe. Install them with scripts/install.sh and
// scripts/install.ps1.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const at = (p) => root + p;

// 1. One script: the command line, the compiler, the virtual machine. The standard library is put in beside it.
mkdirSync(at("dist"), { recursive: true });
const std = readFileSync(at("lib/std.stride"), "utf8");
// The page `stride run` serves in the browser, built in: the executable has no node_modules to bundle it from.
const { bundle: pageBundle } = await import(at("src/serve.mjs"));
// The guides (`stride guide`) and the VS Code extension's files (`stride vscode`).
const guides = { guide: readFileSync(at("docs/guide.md"), "utf8"), "coming-from": readFileSync(at("docs/coming-from.md"), "utf8") };
const vscodeFiles = Object.fromEntries(["package.json", "extension.js", "language-configuration.json", "syntaxes/stride.tmLanguage.json"].map((f) => [f, readFileSync(at(`editors/vscode/${f}`), "utf8")]));
// The build: the day, and a hash of what goes into the executable: the bundle as built (every source, library and
// file it holds, the workflow page, the guides and the extension among them) and the version of node it is put into,
// the same for every platform's executable. The bundle is
// built with a stand-in for the build's name, which is put in after.
const STAND_IN = "stride-build-0000000000000000";
await build({
  entryPoints: [at("bin/stride.mjs")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: at("dist/stride.cjs"),
  logLevel: "warning",
  banner: { js: "const import_meta_url = require('url').pathToFileURL(__filename).href;" },
  define: { "import.meta.url": "import_meta_url", STRIDE_STD: JSON.stringify(std), STRIDE_BUNDLED: "true", STRIDE_PAGE: JSON.stringify(await pageBundle()), STRIDE_GUIDES: JSON.stringify(guides), STRIDE_VSCODE: JSON.stringify(vscodeFiles), STRIDE_BUILD: JSON.stringify(STAND_IN) },
  external: ["esbuild"],
});
const bundled = readFileSync(at("dist/stride.cjs"), "utf8");
const hash = createHash("sha256").update(bundled).update(process.version);
const buildId = `${new Date().toISOString().slice(0, 10)}.${hash.digest("hex").slice(0, 12)}`;
writeFileSync(at("dist/stride.cjs"), bundled.replaceAll(STAND_IN, buildId));
console.log("bundle: dist/stride.cjs");

// 2. The executable: the script as a blob, injected into a copy of node.
writeFileSync(at("dist/sea-config.json"), JSON.stringify({ main: at("dist/stride.cjs"), output: at("dist/stride.blob"), disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ["--experimental-sea-config", at("dist/sea-config.json")], { stdio: "inherit" });
// One executable for each node given: this one's for Linux, and with `--windows <node.exe>`, Windows' node of the same
// version (node-v<version>-win-x64.zip from nodejs.org), for Windows. The blob is the same for both.
const targets = [[process.execPath, "dist/stride"]];
const w = process.argv.indexOf("--windows");
if (w >= 0) {
  const exe = process.argv[w + 1];
  const version = exe ? execFileSync(exe, ["--version"], { encoding: "utf8" }).trim() : null;
  if (version !== process.version) throw new Error(`--windows takes Windows' node ${process.version}, and ${exe ?? "nothing"} is ${version ?? "not given"}`);
  targets.push([exe, "dist/stride.exe"]);
}
for (const [node, out] of targets) {
  copyFileSync(node, at(out));
  execFileSync(at("node_modules/.bin/postject"), [at(out), "NODE_SEA_BLOB", at("dist/stride.blob"), "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"], { stdio: "inherit" });
  console.log(`executable: ${out}, build ${buildId}`);
}
