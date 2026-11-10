// rule 4.6 17.6 17.8 17.11
// Every example of docs/guide.md and docs/coming-from.md does what the guide says: a block followed by
// an `output` block gives exactly that on stdout from `stride run` (with the answers its info string gives), and
// on stderr exactly what a following `stderr` block says, or nothing; a `mistake=S…` block gives that mistake;
// a `form` block compiles against the guide's form (the fixture PDF, whose header `stride header` writes); any
// other block compiles.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tinyPdf } from "../fixtures/tiny-pdf.mjs";

const GUIDES = ["guide.md", "coming-from.md"].map((g) => fileURLToPath(new URL(`../../docs/${g}`, import.meta.url)));

// A guide's blocks: { info, code, output, stderr }; an output (stdout) or stderr block belongs to the stride block
// just before it.
export function blocks(text) {
  const out = [];
  const re = /```(\w*)([^\n]*)\n([\s\S]*?)```/g;
  for (let m; (m = re.exec(text)); ) {
    if (m[1] === "stride") out.push({ info: m[2].trim(), code: m[3], line: text.slice(0, m.index).split("\n").length });
    else if ((m[1] === "output" || m[1] === "stderr") && out.length) out.at(-1)[m[1]] = m[3];
  }
  return out;
}

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "stride-guide-"));
  const stride = (...args) => spawnSync("node", [cli, ...args], { encoding: "utf8", timeout: 30_000, cwd: dir });
  const problems = [];
  try {
    writeFileSync(join(dir, "consent.pdf"), tinyPdf());
    stride("header", "consent.pdf");
    for (const guide of GUIDES) {
    const all = blocks(readFileSync(guide, "utf8"));
    const name = guide.split("/").pop();
    if (all.length < 10) problems.push(`${name} has only ${all.length} stride examples`);
    for (const b of all) {
      const where = `${name}:${b.line}`;
      const answers = b.info.match(/answers=(\{.*\})/)?.[1];
      const mistake = b.info.match(/mistake=(S\d{3})/)?.[1];
      // `file=lib/x.stride` writes the block there, for the blocks after it; `then=test` runs `stride test` on it.
      const file = b.info.match(/file=(\S+)/)?.[1] ?? (b.info.includes("form") ? "consent.stride" : "guide.stride");
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), b.code);
      if (b.info.includes("then=test")) {
        const r = stride("test", file);
        if (r.status !== 0 || !r.stdout.includes("passed")) problems.push(`${where}: stride test ${file} exits ${r.status}: ${r.stdout.slice(0, 300)}`);
        continue;
      }
      if (b.info.includes("file=")) continue;
      if (b.info.includes("form")) {
        const sha = JSON.parse(readFileSync(join(dir, "consent.boxes.json"), "utf8")).pdf;
        if (!b.code.includes(`pdf ${sha}`)) problems.push(`${where}: the example's pdf line is not the fixture's, ${sha}`);
      }
      if (b.output !== undefined || b.stderr !== undefined) {
        // What it prints on stdout, exactly; on stderr, exactly what the stderr block says, or nothing.
        if (answers) writeFileSync(join(dir, "answers.json"), answers);
        const r = stride("run", file, ...(answers ? ["answers.json"] : []));
        if (r.stdout !== (b.output ?? "")) problems.push(`${where}: stride run gives on stdout\n${r.stdout}instead of\n${b.output ?? ""}`);
        if (r.stderr !== (b.stderr ?? "")) problems.push(`${where}: stride run gives on stderr\n${r.stderr}instead of\n${b.stderr ?? ""}`);
        if (r.status !== (b.stderr && /^fault /m.test(b.stderr) ? 1 : 0)) problems.push(`${where}: stride run exits ${r.status}`);
      } else {
        const r = stride("check", file);
        if (mistake ? !(r.status === 1 && r.stderr.includes(`mistake ${mistake}`)) : r.status !== 0) problems.push(`${where}: stride check exits ${r.status}${mistake ? `, expected ${mistake}` : ""}: ${r.stderr.slice(0, 300)}`);
      }
    }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
