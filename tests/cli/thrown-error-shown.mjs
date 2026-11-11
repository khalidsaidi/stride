// rule 7.19 13.4 16.3
// An error a program throws and nothing catches stops the run and is shown as any fault is, with the code the
// program gave it; the finally blocks on its way run first.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "stride-thrown-"));
  const file = join(dir, "thrown.stride");
  writeFileSync(file, `function open(name: string) -> string {
  try {
    throw error("no file called {name}", code: "NOFILE")
  } finally {
    print("closed")
  }
}
print(open("a"))
`);
  const problems = [];
  const r = spawnSync("node", [cli, "run", file], { encoding: "utf8", timeout: 20_000 });
  const want = "fault NOFILE: no file called a\n  at open, thrown.stride:3:5\n  called from main, thrown.stride:8:7";
  if (r.status !== 1 || !r.stderr.includes(want) || r.stdout.trim() !== "closed") problems.push(`run: expected exit 1, "closed" and ${JSON.stringify(want)}, got ${r.status} ${JSON.stringify(r.stdout)} ${JSON.stringify(r.stderr)}`);
  const j = spawnSync("node", [cli, "run", "--json", file], { encoding: "utf8", timeout: 20_000 });
  let fault = null;
  try {
    fault = JSON.parse(j.stdout).fault;
  } catch {}
  if (fault?.code !== "NOFILE" || fault?.message !== "no file called a" || fault?.line !== 3) problems.push(`run --json: expected the fault NOFILE at line 3, got ${j.stdout.slice(0, 300)}`);
  return problems;
}
