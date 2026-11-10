// rule 16.2.1 11.3.1
// S413 for one turn or one call stands at the operation; its note points at the loop for a turn and at the call for
// a call, saying the value it was worked out with.
import { compile } from "../../src/compile.mjs";
import { autoHeader } from "../../src/selftest.mjs";

const SOURCE = `form t
pdf 0000000000000000000000000000000000000000000000000000000000000000
define f(n: number) {
  print(1 / n)
}
f(1)
f(0)
for i in 0..2 {
  print(2 / i)
}
`;

export function test() {
  const header = autoHeader(Buffer.from(SOURCE), "notes.stride");
  const out = compile(Buffer.from(SOURCE), "notes.stride", { header });
  const found = out.diagnostics.sorted().filter((d) => d.code === "S413").map((d) => `${d.line}:${d.column} ${(d.notes ?? []).map((n) => `${n.span?.line}:${n.span?.col} ${n.message}`).join("; ")}`);
  const want = ["4:11 7:1 in the call when n is 0", "9:11 8:1 in the turn when i is 0"];
  return JSON.stringify(found) === JSON.stringify(want) ? [] : [`expected ${JSON.stringify(want)}, got ${JSON.stringify(found)}`];
}
