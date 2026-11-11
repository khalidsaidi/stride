// rule 17.8 19.1
// A program test runs in the machine and in the intermediate form and fails on any difference §19.1 names, even
// where the test's own expectations are met: here each engine is handed a different program on purpose, so they
// disagree on a fault's code, on a print, on a question and on a box, and every such run must fail.
import { compile } from "../../src/compile.mjs";
import { load } from "../../runtime/vm.mjs";
import { runTest } from "../../src/test.mjs";

const HEADER = { form: "t", pdf: "0".repeat(64), boxes: [{ field: "A", kind: "text", near: ["Name"], printed: "Name" }] };
const build = (body) => {
  const out = compile(`form t\npdf ${"0".repeat(64)}\n${body}`, "t.stride", { header: HEADER });
  if (!out.bytecode) throw new Error(out.diagnostics.sorted()[0]?.message);
  return out;
};

export function test() {
  const problems = [];
  const cases = [
    ["a fault's code", 'print(1 / 0)\n', 'fail("stop")\n', { fault: "F001" }],
    ["a print", 'print(1)\n', 'print(2)\n', { prints: ["1"] }],
    ["a question", 'ask name: text "Name"\nfill "A" = name\n', 'ask name: text "Name"\nask other: text "Name"\nfill "A" = either(name, other)\n', { answers: { name: "Ada" }, boxes: { A: "Ada" }, loose: true }],
    ["a box", 'ask name: text "Name"\nfill "A" = name\n', 'ask name: text "Name"\nfill "A" = upper(name)\n', { answers: { name: "Ada" }, boxes: { A: "Ada" } }],
  ];
  for (const [what, vmSource, irSource, t] of cases) {
    const vm = build(vmSource), ir = build(irSource);
    const same = runTest(load(vm.bytecode), t, { program: vm.program, boxes: vm.boxes }).problems;
    if (same.length) problems.push(`${what}: the same program in both engines fails: ${same.join("; ")}`);
    const differ = runTest(load(vm.bytecode), t, { program: ir.program, boxes: ir.boxes }).problems;
    if (!differ.some((x) => x.startsWith("compiler fault"))) problems.push(`${what}: engines that disagree pass: ${JSON.stringify(differ)}`);
  }
  return problems;
}
