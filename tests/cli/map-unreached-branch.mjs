// rule 17.6.1
// `stride map` lists no question, and no write, in a branch of an `if` that no call reaches: a field asked only when
// the record a call gives has a box's name, when every call gives that field as null; one asked only when a flag
// is true, when every call gives it false. A call that reaches the branch lists it.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PDF = "0".repeat(64);
const SOURCE = `form m
pdf ${PDF}
record name_boxes {
  family: string
  middle: string
}
function ask_name(b: name_boxes, with_title: bool = true) {
  ask family: string "Family name"
  fill b.family = family
  if b.middle != null {
    ask middle: string "Middle name"
    fill b.middle = middle
  }
  if with_title {
    ask title: string "Title"
  }
}
ask_name(new name_boxes { family: "F1", middle: null }, with_title: false) as "one"
ask_name(new name_boxes { family: "F2", middle: "M2" }) as "two"
`;

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "stride-map-"));
  const problems = [];
  try {
    writeFileSync(join(dir, "m.stride"), SOURCE);
    writeFileSync(join(dir, "m.boxes.json"), JSON.stringify({ form: "m", pdf: PDF, boxes: ["F1", "F2", "M2"].map((field) => ({ field, kind: "text" })) }));
    const r = spawnSync("node", [cli, "map", "m.stride", "--json"], { cwd: dir, encoding: "utf8", timeout: 30_000 });
    let map;
    try {
      map = JSON.parse(r.stdout);
    } catch {
      return [`stride map --json gave no JSON: ${r.stdout.slice(0, 300)} ${r.stderr.slice(0, 300)}`];
    }
    const keys = map.questions.map((q) => q.key).join(", ");
    if (keys !== "one.family, two.family, two.middle, two.title") problems.push(`the questions listed: ${keys}`);
    if (map.someBoxNamedAtRun) problems.push("a write no call reaches is said to write a box named as the program runs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
