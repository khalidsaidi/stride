// rule 17.5
// The bundled command works by absolute path outside the checkout. Imported build tools must not run their
// command-line entry points, and the standard library must be available without the repository's files.
import { buildSync } from "esbuild";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function test() {
  const dir = mkdtempSync(join(tmpdir(), "stride-bundled-"));
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const std = readFileSync(new URL("../../lib/std.stride", import.meta.url), "utf8");
  const bundle = join(dir, "stride.cjs");
  const problems = [];
  try {
    buildSync({
      entryPoints: [cli], bundle: true, platform: "node", target: "node22", format: "cjs", outfile: bundle,
      banner: { js: "const import_meta_url = require('url').pathToFileURL(__filename).href;" },
      define: { "import.meta.url": "import_meta_url", STRIDE_STD: JSON.stringify(std), STRIDE_BUNDLED: "true" }, external: ["esbuild"],
    });
    writeFileSync(join(dir, "fault.test.stride"), 'expect fail("expected") faults "F013"\n');
    for (const [args, expected] of [
      [["version"], "bytecode version 9"],
      [["eval", 'upper("hello")'], "HELLO"],
      [["test", "fault.test.stride"], "1 expectation passed"],
      [["explain", "S318"], "S318"],
    ]) {
      // Node runs the bundle: under the installed stride, process.execPath is stride itself, not Node.
      const r = spawnSync("node", [bundle, ...args], { cwd: dir, encoding: "utf8", timeout: 20_000 });
      if (r.status !== 0 || !r.stdout.includes(expected)) problems.push(`${args.join(" ")}: expected exit 0 with ${expected}, got ${r.status}: ${r.stdout}${r.stderr}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
