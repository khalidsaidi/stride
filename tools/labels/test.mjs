// The cases that set the guess's numbers (beside.mjs, paragraphs.mjs): the label printed above a box comes before
// the next line's label printed under it; words printed across a box's edge are found; a caption under a box that
// has nothing above it is still its label; and words printed sideways in a margin are not read.
//
//   node tools/labels/test.mjs
import { beside } from "./beside.mjs";
import { paragraphs } from "./paragraphs.mjs";
import { tinyPdf } from "../../tests/fixtures/tiny-pdf.mjs";

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

// Words printed sideways are not read: only the words that run across the page are paragraphs.
for (const name of ["DOMMatrix", "ImageData", "Path2D"]) globalThis[name] ??= class {};
const [log, warn] = [console.log, console.warn];
console.log = console.warn = () => {};
globalThis.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
[console.log, console.warn] = [log, warn];
const read = await paragraphs(await pdfjs.getDocument({ data: new Uint8Array(tinyPdf({ margin: "See page 3" })), verbosity: 0 }).promise);
same("the paragraphs of a page with sideways words", read.map((p) => p.en).sort().join(" | "), "Full name | I agree to the terms");

for (const p of problems) console.log(p);
console.log(problems.length ? `${problems.length} failed` : "the guess's cases pass");
process.exit(problems.length ? 1 : 0);
