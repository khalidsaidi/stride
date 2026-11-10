// rule 8.7 8.4.1 3.1
// Words answers at and past 100,000 code points (§8.7): at the limit kept whole, past it empty and unreadable
// "too long", with the default not coming back; an emoji is one code point though two UTF-16 units. Both engines.
import { compile } from "../../src/compile.mjs";
import { interpretProgram } from "../../src/interpret.mjs";
import { load, run } from "../../runtime/vm.mjs";

export function test() {
  const source = `form t\npdf ${"0".repeat(64)}\nask w: long-text "W" default "d"\nprint(length(w))\n`;
  const out = compile(source, "long.stride", { header: { form: "t", pdf: "0".repeat(64), boxes: [] }, optimise: false });
  if (!out.bytecode) return out.diagnostics.sorted().map((d) => d.format());
  const problems = [];
  const cases = [
    ["x".repeat(100_000), "100000", null],
    ["x".repeat(100_001), "0", "too long"],
    ["😀".repeat(100_000), "100000", null],
    ["😀".repeat(100_001), "0", "too long"],
  ];
  for (const [answer, printed, why] of cases) {
    const engines = { vm: run(load(out.bytecode), { w: answer }), ir: interpretProgram(out.program, { w: answer }) };
    for (const [name, r] of Object.entries(engines)) {
      const label = `${name}, ${[...answer].length} code points of ${answer[0] === "x" ? "x" : "emoji"}`;
      if (r.fault) problems.push(`${label}: fault ${r.fault.code}`);
      if (r.prints[0] !== printed) problems.push(`${label}: printed ${JSON.stringify(r.prints[0])}, expected ${JSON.stringify(printed)}`);
      if ((r.steps[0]?.unreadable ?? null) !== why) problems.push(`${label}: unreadable ${JSON.stringify(r.steps[0]?.unreadable)}, expected ${JSON.stringify(why)}`);
    }
  }
  return problems;
}
