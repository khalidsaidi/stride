// rule 14.0.7 17.9
// Every function of the standard library's tables (§14) has an example in lib/std.stride, every example is of a
// function the tables have, and each example does what it says in the machine and the intermediate form,
// what `stride eval` gives, what it prints, or the fault it stops with. `stride doc` shows them.
import { compile } from "../../src/compile.mjs";
import { load, run } from "../../runtime/vm.mjs";
import { LIBRARY } from "../../src/codes.mjs";
import { examples, setup, EXAMPLE_TODAY } from "../../src/library.mjs";

export function test() {
  const problems = [];
  const all = examples();
  const names = new Set(LIBRARY.flatMap((e) => e.names));
  for (const n of names) if (!all.some((x) => x.name === n)) problems.push(`${n} has no example`);
  for (const x of all) if (!names.has(x.name)) problems.push(`the example "${x.text}" is of ${x.name}, which §14 does not have`);
  const head = setup();
  for (const x of all) {
    // The setup's names are read after the example, which a let left unread would be a mistake (W007).
    const source = `${head}\n${x.verb === "gives" ? `print(${x.expr})` : x.expr}\nprint(count(warm) + count(cool) + count(people))\n`;
    {
      const out = compile(source, "example.stride", {});
      const mistakes = out.diagnostics.sorted().filter((d) => d.severity === "error");
      if (mistakes.length) {
        problems.push(`${x.text}: ${mistakes[0].line}:${mistakes[0].column} ${mistakes[0].code} ${mistakes[0].message}`);
        continue;
      }
      const runs = [["vm", run(load(out.bytecode), {}, { today: EXAMPLE_TODAY })]];
      for (const [engine, r] of runs) {
        const got = x.verb === "faults" ? r.fault?.code ?? "no fault" : r.fault ? `fault ${r.fault.code}` : r.prints[0];
        if (got !== x.want) problems.push(`${x.text}: ${engine} gives ${JSON.stringify(got)}`);
      }
    }
  }
  return problems;
}
