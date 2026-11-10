// rule 17.1
// A program's tests (<form>.tests/) take --today when a case gives no "today" of its own, and every case's own
// "today" is checked before any test runs: a bad one is a usage mistake (exit 2), never a crash.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "stride-today-"));
  const problems = [];
  try {
    const pdf = "0".repeat(64);
    writeFileSync(join(dir, "d.stride"), `form d\npdf ${pdf}\nfill "D" = "{today()}"\n`);
    writeFileSync(join(dir, "d.boxes.json"), JSON.stringify({ form: "d", pdf, boxes: [{ field: "D", kind: "text", page: 1, near: [] }] }));
    const cases = (list) => {
      rmSync(join(dir, "d.tests"), { recursive: true, force: true });
      mkdirSync(join(dir, "d.tests"));
      list.forEach(([name, body]) => writeFileSync(join(dir, "d.tests", `${name}.json`), JSON.stringify(body)));
    };
    const stride = (...args) => spawnSync("node", [cli, "test", join(dir, "d.stride"), ...args], { encoding: "utf8", timeout: 20_000 });

    cases([["given", { boxes: { D: "2001-02-03" } }], ["own", { today: "1999-12-31", boxes: { D: "1999-12-31" } }]]);
    const r = stride("--today", "2001-02-03");
    if (r.status !== 0) problems.push(`--today for cases without their own: expected both to pass, got ${r.status}: ${r.stdout}${r.stderr}`);

    for (const bad of ["2024-02-30", 42, "0000-01-01", "2024-2-3"]) {
      cases([["fine", { boxes: { D: "2001-02-03" }, today: "2001-02-03" }], ["bad", { today: bad, boxes: {} }]]);
      const b = stride();
      if (b.status !== 2 || !b.stderr.includes('"today"') || /TypeError|Cannot read/.test(b.stderr + b.stdout) || /ok\s/.test(b.stdout)) problems.push(`"today": ${JSON.stringify(bad)}: expected a usage mistake before any test runs (exit 2), got ${b.status}: ${b.stdout}${b.stderr}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
