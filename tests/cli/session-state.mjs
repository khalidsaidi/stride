// rule 17.14
// A session keeps what was done: a library changed after a `let` used it leaves the let's value as it was, until
// :reload; an entry that faults keeps nothing, its answers included, so trying again asks again; :undo forgets the
// answers of what it forgets; a session in a project's folder finds the project's libraries.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// A person at the session, in a child: types a line, waits for what it gives, sometimes edits a file between.
const CHILD = `
const { spawn } = await import("node:child_process");
const { writeFileSync } = await import("node:fs");
const [cli, dir, steps] = [process.argv[1], process.argv[2], JSON.parse(process.argv[3])];
const repl = spawn("node", [cli, "repl"], { cwd: dir });
let out = "", errs = "";
repl.stdout.on("data", (c) => (out += c));
repl.stderr.on("data", (c) => (errs += c));
const settle = () => new Promise((ok) => { let last = -1; const t = setInterval(() => { const n = out.length + errs.length; if (n === last) { clearInterval(t); ok(); } last = n; }, 150); });
const seen = [];
for (const s of steps) {
  if (s.write) writeFileSync(dir + "/" + s.write, s.text);
  else repl.stdin.write(s.line + "\\n");
  await settle();
  seen.push({ step: s.line ?? "write " + s.write, out, errs });
  out = ""; errs = "";
}
repl.stdin.end();
await new Promise((ok) => repl.on("close", ok));
console.log(JSON.stringify(seen));
`;

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const top = mkdtempSync(join(tmpdir(), "stride-session-"));
  const problems = [];
  try {
    writeFileSync(join(top, "stride.json"), JSON.stringify({ stride: "1.0" }));
    mkdirSync(join(top, "lib"));
    mkdirSync(join(top, "nested"));
    writeFileSync(join(top, "lib", "g.stride"), "export define get() -> number {\n  return 1\n}\n");
    const steps = [
      { line: 'use "g"' },
      { line: "let x = get()" },
      { line: "x" }, // 1
      { write: "../lib/g.stride", text: "export define get() -> number {\n  return 2\n}\n" },
      { line: "x" }, // still 1: the let ran once
      { line: "get()" }, // 1: the library as the session first read it
      { line: ":reload" },
      { line: "get()" }, // 2
      { line: "define probe() -> number {\n  ask who: text \"Who\"\n  return 1 / (length(who) - 3)\n}" },
      { line: "let bad = probe()" },
      { line: "Ada" }, // faults: not kept, nor its answer
      { line: ":answers" }, // {}
      { line: "let good = probe()" },
      { line: "Grace" }, // kept, with its answer
      { line: ":answers" },
      { line: ":undo" },
      { line: ":answers" }, // {} again
    ];
    const r = spawnSync("node", ["--input-type=module", "-e", CHILD, cli, join(top, "nested"), JSON.stringify(steps)], { encoding: "utf8", timeout: 60_000 });
    let seen;
    try {
      seen = JSON.parse(r.stdout);
    } catch {
      return [`the session did not finish: ${r.stderr.slice(0, 500)}`];
    }
    const at = (i) => seen[i];
    const expect = (i, what, ok) => ok(at(i)) || problems.push(`${what}: after ${JSON.stringify(at(i).step)}, stdout ${JSON.stringify(at(i).out)}, stderr ${JSON.stringify(at(i).errs)}`);
    expect(0, "the project's library found from a folder under it", (s) => !s.errs.includes("mistake"));
    expect(2, "x", (s) => s.out === "1\n");
    expect(4, "x after the library changed: the let ran once", (s) => s.out === "1\n");
    expect(5, "the library as the session first read it", (s) => s.out === "1\n");
    expect(7, "after :reload, the library as it is now", (s) => s.out === "2\n");
    expect(10, "the entry that faulted", (s) => s.errs.includes("fault F001") && s.errs.includes("not kept"));
    expect(11, "a failed entry keeps no answer", (s) => s.out === "{}\n");
    expect(12, "trying again asks again", (s) => s.errs.includes("Who"));
    expect(14, "a kept entry keeps its answer", (s) => s.out === '{"probe.who":"Grace"}\n');
    expect(16, ":undo forgets its answers", (s) => s.out === "{}\n");
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
  return problems;
}
