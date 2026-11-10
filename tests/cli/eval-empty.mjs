// rule 17.2
// stride eval with nothing to evaluate (empty, only whitespace, only comments) is a usage mistake, exit 2; a
// malformed expression keeps its own mistake, exit 1.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const problems = [];
  for (const [input, status, words] of [["", 2, "usage"], ["   ", 2, "given none"], ["  # a comment", 2, "given none"], ["\n# a\n\t\n", 2, "given none"], ["1 +", 1, "S015"]]) {
    const r = spawnSync("node", [cli, "eval", input], { encoding: "utf8", timeout: 20_000 });
    const out = r.stdout + r.stderr;
    if (r.status !== status || !out.includes(words)) problems.push(`eval ${JSON.stringify(input)}: expected exit ${status} and "${words}", got ${r.status} ${out.slice(0, 200)}`);
  }
  return problems;
}
