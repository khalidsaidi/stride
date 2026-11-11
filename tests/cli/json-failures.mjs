// rule 17.11
// --json when things go wrong: a command given properly that fails (exit 1) still gives one document, { ok: false,
// error } when it could not do its work, its usual document when it found mistakes or a fault; a usage mistake
// (exit 2) gives no document, its usage on stderr. What was asked for on stderr stays there: the trace, the prompts.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "stride-json-"));
  const problems = [];
  const stride = (args, input) => spawnSync("node", [cli, ...args, "--json"], { cwd: dir, encoding: "utf8", input, timeout: 60_000 });
  // One document on stdout, `test` true of it, and stderr as `err` says.
  const one = (what, args, status, test, err = (e) => e === "", input) => {
    const r = stride(args, input);
    let doc = null;
    try {
      doc = JSON.parse(r.stdout);
    } catch {}
    if (r.status !== status || !doc || r.stdout.trim().includes("\n") || !test(doc) || !err(r.stderr)) problems.push(`${what}: exit ${r.status}, stdout ${JSON.stringify(r.stdout.slice(0, 300))}, stderr ${JSON.stringify(r.stderr.slice(0, 300))}`);
  };
  try {
    writeFileSync(join(dir, "m.stride"), 'ask n: number "N"\nprint(10 / n)\n');
    writeFileSync(join(dir, "bad.json"), "{bad");
    writeFileSync(join(dir, "notes.stride"), 'print("no tests")\n');
    writeFileSync(join(dir, "mistake.stride"), 'print(missing)\n');
    const failed = (d) => d.ok === false && typeof d.error === "string" && Object.keys(d).length === 2;
    one("compile to a folder that is not there", ["compile", "m.stride", "-o", "absent/out.sbc"], 1, failed);
    one("compile with source mistakes keeps its result fields", ["compile", "mistake.stride"], 1,
      (d) => d.ok === false && d.diagnostics.some((x) => x.code === "S201") && d.output === null && d.bytes === 0 && d.questions === 0 && d.boxes === 0);
    one("map with source mistakes keeps its result fields", ["map", "mistake.stride"], 1,
      (d) => d.ok === false && d.diagnostics.some((x) => x.code === "S201") && [d.questions, d.writtenFromNoAnswer, d.notWritten].every((x) => Array.isArray(x) && x.length === 0));
    one("run with answers that are not JSON", ["run", "m.stride", "bad.json"], 1, (d) => failed(d) && d.error.startsWith("bad.json: not JSON"));
    one("test of a program with no tests", ["test", "notes.stride"], 1, failed);
    one("run that faults", ["run", "m.stride", "n=0"], 1, (d) => d.ok === false && d.fault.code === "F001" && !("error" in d));
    one("check of a good program", ["check", "m.stride"], 0, (d) => d.ok === true);
    // What was asked for on stderr: the trace, the prompts; the document still alone on stdout.
    one("run --trace", ["run", "m.stride", "n=2", "--trace"], 0, (d) => d.ok && d.prints[0] === "5", (e) => e.includes("m.stride:2"));
    one("run --prompt", ["run", "m.stride", "--prompt"], 0, (d) => d.ok && d.prints[0] === "5", (e) => e.includes("N"), "2\n");
    // A usage mistake: no document.
    for (const args of [["run", "nosuch.stride"], ["compile", "m.stride", "--nosuch"], ["run", "m.stride", "a.json", "b.json"]]) {
      const r = stride(args);
      if (r.status !== 2 || r.stdout !== "" || !r.stderr.includes("usage:")) problems.push(`${args.join(" ")} --json: exit ${r.status}, stdout ${JSON.stringify(r.stdout)}, stderr ${JSON.stringify(r.stderr.slice(0, 200))}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
