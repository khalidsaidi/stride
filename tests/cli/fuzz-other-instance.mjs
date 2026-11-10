// rule 19.2
// A fault at the refused place in another call does not confirm an S413: the claim is f's call with n 0 and m 1,
// which no generated answer reaches (z would have to be 123457), while f(z, 2) faults there when z is 0.
import { compile } from "../../src/compile.mjs";
import { autoHeader } from "../../src/selftest.mjs";
import { checkRefusal } from "../../src/fuzz.mjs";

const SOURCE = `form t
pdf 0000000000000000000000000000000000000000000000000000000000000000
define f(n: number, m: number) {
  print(1 / n)
  print(m)
}
ask z: number "Z"
f(z, 2)
if z == 123457 {
  f(0, 1)
}
`;

export function test() {
  const header = autoHeader(SOURCE, "fuzz.stride");
  const out = compile(SOURCE, "fuzz.stride", { header });
  const mistakes = out.diagnostics.sorted().filter((d) => d.severity === "error");
  if (mistakes.length !== 1 || mistakes[0].code !== "S413") return [`expected one S413, got ${mistakes.map((m) => m.code).join(", ")}`];
  const problems = [];
  for (let seed = 1; seed <= 40; seed++) {
    const r = checkRefusal(SOURCE, mistakes, seed);
    if (r.wrong || r.exercised) problems.push(`seed ${seed}: ${JSON.stringify(r)}`);
  }
  return problems;
}
