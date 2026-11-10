// rule 17.2
// `stride eval`: two expressions side by side, or a complete one followed by text that does not even lex, are a
// usage mistake (exit 2); an expression starting with "-" is an
// expression, not an option; a mistake at the expression's end is placed in it, never on the lines put around it;
// a library --use cannot find is a usage mistake, not one placed in the expression.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const stride = (...args) => spawnSync("node", [cli, "eval", ...args], { encoding: "utf8", timeout: 20_000, cwd });
  const problems = [];
  for (const expr of ["1 2", "1\n2", "f(1) g(2)", "1 @", "1; 2", '1 "x']) {
    const r = stride(expr);
    if (r.status !== 2 || r.stdout.trim() !== "") problems.push(`${JSON.stringify(expr)}: expected a usage mistake, got ${r.status} ${r.stdout}${r.stderr}`);
  }
  const neg = stride("-abs(1)");
  if (neg.status !== 0 || neg.stdout.trim() !== "-1") problems.push(`-abs(1): expected -1, got ${neg.status} ${neg.stdout}${neg.stderr}`);
  for (const [expr, where] of [["(1", "eval:1:3:"], ["1 +\n(2", "eval:2:3:"], ["1 + @", "eval:1:5:"]]) {
    const r = stride(expr);
    if (r.status !== 1 || !r.stderr.startsWith(where)) problems.push(`${JSON.stringify(expr)}: expected a mistake at ${where}, got ${r.status} ${r.stdout}${r.stderr}`);
  }
  const lib = stride("1", "--use", "nope");
  if (lib.status !== 2 || !/--use nope/.test(lib.stderr) || lib.stdout.includes("eval:")) problems.push(`--use nope: expected a usage mistake, got ${lib.status} ${lib.stdout}${lib.stderr}`);
  return problems;
}
