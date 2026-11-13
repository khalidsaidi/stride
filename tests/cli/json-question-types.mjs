// rule 16.2
// `stride map --json` and `stride run --terminal --json` give each question's type and its options, each with its
// value and printed words, in order; a question with no options has `[]`.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PDF = "0".repeat(64);
const SOURCE = `form q
pdf ${PDF}
enum colour {
  "r" "Red"
  "g" "Green"
}
ask c: one_of colour "Colour"
ask n: string "Name"
fill "C" = c
fill "N" = n
`;

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "stride-types-"));
  const problems = [];
  try {
    writeFileSync(join(dir, "q.stride"), SOURCE);
    writeFileSync(join(dir, "q.boxes.json"), JSON.stringify({ form: "q", pdf: PDF, boxes: [{ field: "C", kind: "text" }, { field: "N", kind: "text" }] }));
    const want = [
      { key: "c", type: "one_of", options: [{ value: "r", printed: "Red" }, { value: "g", printed: "Green" }] },
      { key: "n", type: "string", options: [] },
    ];
    for (const args of [["map", "q.stride", "--json"], ["run", "q.stride", "--terminal", "--json", "c=r"]]) {
      const r = spawnSync("node", [cli, ...args], { cwd: dir, encoding: "utf8", timeout: 30_000 });
      let got;
      try {
        got = JSON.parse(r.stdout).questions.map((q) => ({ key: q.key, type: q.type, options: q.options }));
      } catch {
        problems.push(`stride ${args[0]} --json gave no questions: ${r.stdout.slice(0, 300)} ${r.stderr.slice(0, 300)}`);
        continue;
      }
      if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`stride ${args[0]} --json: ${JSON.stringify(got)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
