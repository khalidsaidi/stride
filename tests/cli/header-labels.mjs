// rule 17.6
// The words `stride header` reads beside a box (src/beside.mjs, src/paragraphs.mjs): the label printed above a box
// comes before the next line's label printed under it; words printed across a box's edge are found; a caption
// under a box that has nothing above it is still its label; and words printed sideways in a margin are not read.
// The rule's numbers are set against real forms; these are the cases that moved them.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beside } from "../../src/beside.mjs";
import { tinyPdf } from "../fixtures/tiny-pdf.mjs";

export function test() {
  const problems = [];
  const para = (en, x1, y1, x2, y2) => ({ en, x1, y1, x2, y2, page: 1 });
  const first = (box, paras) => beside(box, paras)[0]?.en ?? "(none)";
  const same = (what, got, want) => got === want || problems.push(`${what}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);

  // A form whose labels stand above their boxes, one line after the other (as the IRS W-9's do).
  const name = { kind: "text", x1: 60, y1: 118, x2: 576, y2: 132 };
  const lines = [para("1 Name of entity/individual", 60, 106, 300, 115), para("2 Business name, if different from above", 60, 134, 330, 143)];
  same("the label above a box, with the next line's label under it", first(name, lines), "1 Name of entity/individual");

  // A caption under a line with nothing printed above it (as under a signature).
  const signature = { kind: "text", x1: 100, y1: 300, x2: 400, y2: 316 };
  same("a caption under a box", first(signature, [para("Signature of applicant", 180, 318, 320, 327)]), "Signature of applicant");

  // A cell's label printed partly over the top of its box.
  const cell = { kind: "text", x1: 60, y1: 200, x2: 300, y2: 230 };
  same("words across a box's edge", first(cell, [para("Date of birth", 62, 196, 130, 205), para("Unrelated words far below", 60, 300, 200, 309)]), "Date of birth");

  // A tick box keeps the words on its right.
  const tick = { kind: "check", x1: 73, y1: 180, x2: 81, y2: 188 };
  same("a tick box's label", first(tick, [para("C corporation", 86, 180, 150, 188), para("3a Check the appropriate box", 60, 166, 400, 175)]), "C corporation");

  // Words printed sideways are not read: the header of a PDF with some has the words that run across the page.
  const dir = mkdtempSync(join(tmpdir(), "stride-header-labels-"));
  try {
    const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
    writeFileSync(join(dir, "form.pdf"), tinyPdf({ margin: "See page 3" }));
    const r = spawnSync("node", [cli, "header", "form.pdf", "-q"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
    if (r.status !== 0) problems.push(`stride header: exit ${r.status} ${r.stderr.slice(0, 200)}`);
    else {
      const header = JSON.parse(readFileSync(join(dir, "form.boxes.json"), "utf8"));
      const box = header.boxes.find((b) => b.field === "name");
      same("the label of a box with sideways words near it", box?.printed, "Full name");
      if (box?.near.some((w) => w.includes("See page"))) problems.push(`sideways words are among the words beside the box: ${JSON.stringify(box.near)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
