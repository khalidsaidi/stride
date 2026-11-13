// rule 17.19
// `stride runtime` writes the machine for a host's page as one ES module with no imports. A page's own code
// loads a compiled workflow with it, runs it on answers, sees each question the run reaches with its key, type,
// printed words, options and default, and gets each box's value by its full name; nothing is reached outside.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { widgetsPdf } from "../fixtures/widgets-pdf.mjs";
import { VERSION } from "../../runtime/bytecode.mjs";

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "stride-runtime-"));
  const stride = (...args) => spawnSync("node", [cli, ...args], { encoding: "utf8", timeout: 60_000, cwd: dir });
  const problems = [];
  try {
    writeFileSync(join(dir, "form-w.pdf"), widgetsPdf());
    for (const args of [["header", "form-w.pdf"], ["runtime", "-o", "machine.mjs"]]) {
      const r = stride(...args);
      if (r.status !== 0) problems.push(`stride ${args.join(" ")}: exit ${r.status}: ${r.stderr}`);
    }
    const header = JSON.parse(readFileSync(join(dir, "form-w.boxes.json"), "utf8"));
    writeFileSync(
      join(dir, "form-w.stride"),
      `form form-w\npdf ${header.pdf}\nask who: string "Name" default "Ada"\nask sex: one_of "Sex" {\n  option "f" "Female"\n  option "m" "Male"\n}\nfill "name" = who\npick "sex" "Male" when sex == "m"\nif sex == "m" {\n  ask month: string "Month"\n  fill "month" = month\n}\n`,
    );
    const c = stride("compile", "form-w.stride");
    if (c.status !== 0) problems.push(`stride compile: exit ${c.status}: ${c.stderr}`);
    const module = readFileSync(join(dir, "machine.mjs"), "utf8");
    if (!module.startsWith("// Stride ") || !/runs bytecode version \d+/.test(module.split("\n")[0])) problems.push(`the module's first line: ${module.split("\n")[0]}`);
    if (/^\s*import\b|\bimport\(|\brequire\(/m.test(module)) problems.push("the module imports something");
    // The host's page, here a script run by node with nothing but the module and the bytes of the program.
    writeFileSync(
      join(dir, "host.mjs"),
      `import { load, run, boxValues, VERSION } from "./machine.mjs";
import { readFileSync } from "node:fs";
const p = load(readFileSync("form-w.sbc"));
const shown = (r) => r.steps.map((s) => ({ key: s.key, type: s.question.type, printed: s.printed, options: s.question.options.map((o) => [o.value, o.printed]), default: s.default ?? null }));
const before = run(p, {});
const after = run(p, { who: "Bo", sex: "m", month: "05" });
console.log(JSON.stringify({ version: VERSION, before: shown(before), after: shown(after).map((s) => s.key), boxes: boxValues(p, after.writes), empty: boxValues(p, before.writes), fault: after.fault }));
`,
    );
    const r = spawnSync("node", ["host.mjs"], { cwd: dir, encoding: "utf8", timeout: 20_000 });
    if (r.status !== 0) problems.push(`the host's script: exit ${r.status}: ${r.stderr}`);
    else {
      const got = JSON.parse(r.stdout);
      const want = {
        version: VERSION,
        before: [{ key: "who", type: "string", printed: "Name", options: [], default: "Ada" }, { key: "sex", type: "one_of", printed: "Sex", options: [["f", "Female"], ["m", "Male"]], default: null }],
        after: ["who", "sex", "month"],
        boxes: { name: "Bo", sex: "Male", total: "", month: "05" },
        // Unanswered, a question holds its default; a box the run does not write is empty.
        empty: { name: "Ada", sex: "Off", total: "", month: "" },
        fault: null,
      };
      for (const k of Object.keys(want)) if (JSON.stringify(got[k]) !== JSON.stringify(want[k])) problems.push(`${k}: expected ${JSON.stringify(want[k])}, got ${JSON.stringify(got[k])}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
