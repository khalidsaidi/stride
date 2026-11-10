// rule 21.1 21.2 17.9
// `stride version` says the language's version, the one §21.1 states, and the bytecode's; a machine refuses
// bytecode of another version, naming both.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compile, LANGUAGE } from "../../src/compile.mjs";
import { load } from "../../runtime/vm.mjs";
import { VERSION } from "../../runtime/bytecode.mjs";
import { SPEC_PATH } from "../../src/gen-codes.mjs";

export function test() {
  const problems = [];
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const r = spawnSync("node", [cli, "version"], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.includes(`stride ${LANGUAGE}`) || !r.stdout.includes(`bytecode version ${VERSION}`)) problems.push(`stride version: ${r.stdout}`);
  const stated = readFileSync(SPEC_PATH, "utf8").match(/21\.1\. This specification is Stride (\d+\.\d+\.\d+)/)?.[1];
  if (stated !== LANGUAGE) problems.push(`§21.1 states ${stated}, and the tools say ${LANGUAGE}`);
  const out = compile('print("x")\n', "v.stride");
  const other = Uint8Array.from(out.bytecode);
  other[4] = VERSION + 1;
  try {
    load(other);
    problems.push("bytecode of another version loaded");
  } catch (e) {
    if (!e.message.includes(`version ${VERSION + 1}`) || !e.message.includes(`version ${VERSION}`)) problems.push(`refused with: ${e.message}`);
  }
  return problems;
}
