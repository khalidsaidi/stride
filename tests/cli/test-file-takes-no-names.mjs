// rule 17.4
// `stride test` on a .test.stride file: a name after it is a usage mistake (exit 2), nothing run; options such as
// --today stay allowed.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const file = fileURLToPath(new URL("../c17-test-file-plain.test.stride", import.meta.url));
  const stride = (...args) => spawnSync("node", [cli, "test", file, ...args], { encoding: "utf8", timeout: 20_000 });
  const problems = [];
  const named = stride("first");
  if (named.status !== 2 || named.stdout.trim() !== "" || !/no names/.test(named.stderr)) problems.push(`a name after a test file: expected exit 2 and nothing run, got ${named.status} ${named.stdout}${named.stderr}`);
  const today = stride("--today", "2001-02-03");
  if (today.status !== 0 || !/^ok/m.test(today.stdout)) problems.push(`--today after a test file: expected it to run, got ${today.status} ${today.stdout}${today.stderr}`);
  return problems;
}
