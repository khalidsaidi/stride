// rule 17.7 17.8
// `stride run --trace` on a source file follows it as written: each statement's line and text, the values it
// gives, each turn of a loop, each call with its arguments and what it gives back, and each call of the library,
// indented by depth. A program test may say what the
// run prints and the fault it stops with; a run that stops without the test saying so fails it.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "stride-trace-"));
  const stride = (...args) => spawnSync("node", [cli, ...args], { encoding: "utf8", timeout: 30_000, cwd: dir });
  const problems = [];
  try {
    writeFileSync(join(dir, "t.stride"), 'define double(n: number) -> number {\n  let d = n * 2\n  return d\n}\nvar total: number = 0\nfor i in 1..2 {\n  total = total + double(i)\n}\nprint(total)\n');
    const r = stride("run", "t.stride", "--trace");
    const traced = r.stderr + r.stdout;
    const want = ["t.stride:5  var total: number = 0", "      total = 0", "t.stride:7  total = total + double(i)", "  → double(n = 1)", "  t.stride:2  let d = n * 2", "        d = 2", "  ← double gives 2", "      total = 2", "6"];
    let at = 0;
    for (const line of traced.split("\n")) if (line === want[at]) at++;
    if (r.status !== 0 || at < want.length) problems.push(`--trace: expected, in order, ${JSON.stringify(want[at])}; got:\n${traced}`);
    // A let known before the form opens is still a statement of the trace, with its call; a loop on one line is
    // shown at each turn; a counter is shown in its turns, never at the value that ends the loop.
    writeFileSync(join(dir, "k.stride"), 'let value = upper("ada")\nprint(value)\nfor i in 1..3 { print(i) }\n');
    const k = stride("run", "k.stride", "--trace").stderr;
    const turns = k.split("\n").filter((l) => /^k\.stride:3 .*i = \d$/.test(l)).map((l) => l.slice(-1));
    if (!k.includes('k.stride:1  let value = upper("ada")\n    · upper("ada") gives "ADA"\n      value = "ADA"')) problems.push(`the known let is not traced:\n${k}`);
    if (turns.join(",") !== "1,2,3") problems.push(`the one-line loop's turns: ${turns.join(",")}:\n${k}`);
    if (/i = 4/.test(k)) problems.push(`the counter is shown past the loop:\n${k}`);
    // Turns of loops whose bodies are empty are shown too, each with its own values; a loop of no turns, none.
    writeFileSync(join(dir, "e.stride"), 'for i in 1..3 { }\nfor each i, x in [10, 20, 30] { }\nfor a in 1..2 {\n  for b in 1..0 { }\n}\nprint("done")\n');
    const e = stride("run", "e.stride", "--trace").stderr.split("\n");
    const of = (n) => e.filter((l) => l.startsWith(`e.stride:${n} `)).map((l) => l.replace(/^.*\}?\s{6}/, "").trim());
    const wantTurns = { 1: ["i = 1", "i = 2", "i = 3"], 2: ["i = 1, x = 10", "i = 2, x = 20", "i = 3, x = 30"], 3: ["a = 1", "a = 2"], 4: [] };
    for (const [n, w] of Object.entries(wantTurns)) if (JSON.stringify(of(n)) !== JSON.stringify(w)) problems.push(`empty loops, line ${n}: ${JSON.stringify(of(n))}, expected ${JSON.stringify(w)}`);
    writeFileSync(join(dir, "f.stride"), 'ask n: number "N"\nprint(10 / n)\n');
    mkdirSync(join(dir, "f.tests"));
    const cases = { "a-prints": { answers: { n: 2 }, prints: ["5"] }, "b-faults": { answers: { n: 0 }, fault: "F001" }, "c-wrong-print": { answers: { n: 2 }, prints: ["4"] }, "d-stops-unsaid": { answers: { n: 0 } }, "e-fault-not-met": { answers: { n: 1 }, fault: "F001" } };
    for (const [name, t] of Object.entries(cases)) writeFileSync(join(dir, "f.tests", `${name}.json`), JSON.stringify(t));
    const t = stride("test", "f.stride");
    for (const [name, ok] of [["a-prints", true], ["b-faults", true], ["c-wrong-print", false], ["d-stops-unsaid", false], ["e-fault-not-met", false]]) {
      const line = t.stdout.split("\n").find((l) => l.includes(name)) ?? "";
      if (line.startsWith("ok") !== ok) problems.push(`${name}: expected it to ${ok ? "pass" : "fail"}; ${line}`);
    }
    if (t.status !== 1 || !t.stdout.includes("3 of 5 tests failed")) problems.push(`stride test: exit ${t.status}, ${t.stdout.split("\n").at(-2)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
