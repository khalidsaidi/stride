// rule 17.2
// `stride eval` gives places in the expression from its own line 1, column 1, over several lines, for mistakes and
// faults alike; a place in a library keeps the library's file and line.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const stride = (...args) => spawnSync("node", [cli, "eval", ...args], { encoding: "utf8", timeout: 20_000, cwd });
  const problems = [];
  const m = stride("1 +\n  (2 / nosuch)");
  if (!/^eval:2:8: error S201/m.test(m.stderr) || !/^ {2}2 \| {3}\(2 \/ nosuch\)$/m.test(m.stderr)) problems.push(`a mistake on line 2 of the expression: ${m.stdout}${m.stderr}`);
  const n = stride("nope");
  if (!/^eval:1:1: error S201/m.test(n.stderr)) problems.push(`a mistake at the expression's start: ${n.stderr}`);
  const f = stride("1 +\n  loud([0][0])", "--import", "c-eval-fault"); // a list item is not known (§11.1): it faults when it runs
  if (!/at loud, lib\/c-eval-fault\.stride:3:\d+/.test(f.stderr) || !/called from main, eval:2:3/.test(f.stderr)) problems.push(`a fault in a library called from line 2: ${f.stdout}${f.stderr}`);
  return problems;
}
