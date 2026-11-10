// rule 18.2
// Exercise the actual CLI: repeated stores, a callee's locals, an item changed in place, and ordinary output.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { compile } from "../../src/compile.mjs";

export function test() {
  const source = `form t
pdf ${"0".repeat(64)}
define twice(n: number) -> number {
  var doubled = n
  doubled *= 2
  return doubled
}
var counter = 1
counter = 2
let result = twice(counter)
var xs: list of number most 2 = [1]
xs[1] = counter
print(result)
print(xs[1])
`;
  const out = compile(source, "cli-trace.stride", { header: { form: "t", pdf: "0".repeat(64), boxes: [] }, optimise: false });
  if (!out.bytecode) return out.diagnostics.sorted().map((d) => d.format());
  const dir = mkdtempSync(join(tmpdir(), "stride-trace-"));
  try {
    const path = join(dir, "trace.sbc");
    writeFileSync(path, out.bytecode);
    const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
    const invoke = (args) => spawnSync("node", [cli, "run", path, "--terminal", ...args], { encoding: "utf8", timeout: 10_000, maxBuffer: 1_000_000 });
    const traced = invoke(["--trace"]), plain = invoke([]);
    const problems = [];
    for (const [name, result] of [["traced", traced], ["plain", plain]]) {
      if (result.error || result.status !== 0) problems.push(`${name} CLI run failed: ${result.error?.message ?? result.stderr}`);
      if (!result.stdout.includes("print: 4") || !result.stdout.includes("print: 2")) problems.push(`${name} CLI run lost the program's output`);
    }
    for (const [fn, op, change] of [["main", "STORE", "counter = 1"], ["main", "STORE", "counter = 2"], ["twice", "STORE", "doubled = 2"], ["twice", "STORE", "doubled = 4"], ["main", "STORE", "result = 4"], ["main", "SET_ITEM", "xs = \\[1\\]"]]) {
      if (!new RegExp(`^\\s+${fn}\\s+\\d+\\s+${op}\\b[^\\n]*${change}(?:,|$)`, "m").test(traced.stderr)) problems.push(`trace does not attribute ${change} to ${fn}'s ${op}`);
    }
    if (/^\s+main\s+\d+\s+STORE\b/m.test(plain.stdout + plain.stderr)) problems.push("instructions were printed without --trace");
    return problems;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
