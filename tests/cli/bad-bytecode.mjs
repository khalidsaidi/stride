// rule 18.1
// A .sbc the loader refuses — another version, or cut short — is reported as the file's mistake (exit 1), never
// as a JavaScript stack trace.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "stride-sbc-"));
  const problems = [];
  try {
    const src = join(dir, "p.stride");
    writeFileSync(src, `form t\npdf ${"0".repeat(64)}\nprint("hi")\n`);
    writeFileSync(join(dir, "p.boxes.json"), JSON.stringify({ form: "t", pdf: "0".repeat(64), boxes: [] }));
    const c = spawnSync("node", [cli, "compile", src], { encoding: "utf8", timeout: 20_000 });
    if (c.status !== 0) return [`compiling the fixture failed: ${c.stdout}${c.stderr}`];
    const good = readFileSync(join(dir, "p.sbc"));
    const old = Buffer.from(good);
    old[4] = 2;
    for (const [name, bytes, words] of [["short", good.subarray(0, Math.floor(good.length / 2)), "ends too early"], ["old", old, "version 2"]]) {
      const f = join(dir, `${name}.sbc`);
      writeFileSync(f, bytes);
      for (const cmd of ["run", "asm"]) {
        const r = spawnSync("node", [cli, cmd, f], { encoding: "utf8", timeout: 20_000 });
        const out = r.stdout + r.stderr;
        if (r.status !== 1 || !out.includes(words) || /\n\s+at /.test(out)) problems.push(`${cmd} ${name}.sbc: expected exit 1 and "${words}", no stack trace; got ${r.status} ${out}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
