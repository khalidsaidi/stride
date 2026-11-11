// rule 17.2 9.6
// `stride eval` (§17.2) takes one complete expression, over lines or with a comment after it if need be: a list of
// them, a named value, text that closes the expression and goes on, or a second argument is a usage mistake (exit 2).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const problems = [];
  for (const [expr, out, more = []] of [["1 + 2", "3"], ['upper("a")', "A"], ["1 +\n2", "3"], ["1 # a note", "1"], ["1, 2", null], ["1)\nprint(2", null], ["1) print(2", null], ["x: 1", null], ["1", null, ["2"]], ["1) + (2", null], ["1)(2", null]]) {
    const r = spawnSync("node", [cli, "eval", expr, ...more], { encoding: "utf8", timeout: 20_000 });
    if (out !== null && (r.status !== 0 || r.stdout.trim() !== out)) problems.push(`${JSON.stringify(expr)}: expected ${out}, got ${r.status} ${r.stdout}${r.stderr}`);
    if (out === null && (r.status !== 2 || r.stdout.trim() !== "")) problems.push(`${JSON.stringify(expr)}: expected a usage mistake and nothing run, got ${r.status} ${r.stdout}${r.stderr}`);
  }
  // A lexical mistake inside the expression is its own mistake, not a usage one (§2.6).
  // Mistakes in one expression are its own (§17.2), at the same nesting limit as in a program (§7.1).
  for (const [expr, code] of [['"\\q"', "S003"], ['"\\u{110000}"', "S021"], ["1 < 2 < 3", "S014"], ["let x = 1", "S010"], ["print(1)", "S370"], ['fail("x")', "S370"], ["upper(print(1))", "S366"], [`${"(".repeat(200)}1${")".repeat(200)}`, "S019"]]) {
    const r = spawnSync("node", [cli, "eval", expr], { encoding: "utf8", timeout: 20_000 });
    if (r.status !== 1 || !r.stderr.includes(`mistake ${code}`) || r.stdout !== "") problems.push(`${expr}: expected ${code}, got ${r.status} ${r.stdout}${r.stderr}`);
  }
  const deep = spawnSync("node", [cli, "eval", `${"(".repeat(199)}1${")".repeat(199)}`], { encoding: "utf8", timeout: 20_000 });
  if (deep.status !== 0 || deep.stdout.trim() !== "1") problems.push(`199 brackets, as a program allows: got ${deep.status} ${deep.stdout}${deep.stderr}`);
  return problems;
}
