// rule 17.18 8.4.1
// stride run --terminal shows a default of null, no words or no options as no default (—), and any other default
// after its value, "(default)".
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "stride-default-"));
  const problems = [];
  try {
    const file = join(dir, "d.stride");
    writeFileSync(file, [
      "form t",
      "pdf 0000000000000000000000000000000000000000000000000000000000000000",
      'ask first: string "First"',
      'ask blank: string "Blank" default first ?? ""',
      'ask none: any_of "None" {',
      '  option "a" "A"',
      "} default []",
      'ask some: string "Some" default "x"',
      'fill "A" = "{blank}{none}{some}"',
      "",
    ].join("\n"));
    writeFileSync(join(dir, "d.boxes.json"), JSON.stringify({ form: "t", pdf: "0".repeat(64), boxes: [{ field: "A", kind: "text", page: 1, x1: 0, y1: 0, x2: 10, y2: 10 }] }));
    const r = spawnSync("node", [cli, "run", file, "--terminal", "--no-prompt", "--color=never"], { encoding: "utf8", timeout: 20_000 });
    const line = (key) => r.stdout.split("\n").find((l) => l.trim().startsWith(`${key} `)) ?? "";
    for (const key of ["blank", "none"]) if (!line(key).trim().endsWith("—") || line(key).includes("(default)")) problems.push(`${key}: expected no default (—), got ${JSON.stringify(line(key))}\n${r.stdout}${r.stderr}`);
    if (!line("some").includes('"x" (default)')) problems.push(`some: expected "x" (default), got ${JSON.stringify(line("some"))}\n${r.stdout}${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
