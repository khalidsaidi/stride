// rule 4.3 4.5
// A test file beside its library, in lib/, uses the libraries of that lib/ (§4.3): `stride test` runs it.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const file = fileURLToPath(new URL("../lib/c-beside.test.stride", import.meta.url));
  const r = spawnSync("node", [cli, "test", file], { encoding: "utf8", timeout: 20_000 });
  const problems = [];
  if (r.status !== 0) problems.push(`stride test failed: ${r.stdout}${r.stderr}`);
  if (!/1 expectations? passed/.test(r.stdout)) problems.push(`expected its one expectation to pass: ${r.stdout}`);
  return problems;
}
