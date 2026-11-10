// Suggests, for each box of a fillable PDF, the printed words that likely stand beside it: a guess from where the
// words and the boxes are on the page (beside.mjs), for whoever writes the form's header to check against the form.
//
//   node tools/labels/suggest.mjs form.pdf                          each box and the words guessed for it
//   node tools/labels/suggest.mjs form.pdf --into form.boxes.json   and put them, as "near", on the header's boxes
//                                                                   that have none yet
//
// Stride does not guess (README.md): it checks a program against the words a header lists, whoever listed them.
import { readFileSync, writeFileSync } from "node:fs";

const [pdfPath, flag, headerPath] = process.argv.slice(2);
if (!pdfPath || (flag && (flag !== "--into" || !headerPath))) {
  console.error("usage: node tools/labels/suggest.mjs <form.pdf> [--into <form.boxes.json>]");
  process.exit(2);
}
for (const name of ["DOMMatrix", "ImageData", "Path2D"]) globalThis[name] ??= class {};
const [log, warn] = [console.log, console.warn];
console.log = console.warn = () => {};
globalThis.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
[console.log, console.warn] = [log, warn];
const { paragraphs } = await import("./paragraphs.mjs");
const { beside } = await import("./beside.mjs");
const { pageBoxes } = await import("../../src/pdf-boxes.mjs");

const bytes = readFileSync(pdfPath);
const paras = await paragraphs(await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise);
const guessed = new Map();
for (const box of await pageBoxes(bytes)) guessed.set(`${box.field}\t${box.on ?? ""}`, beside(box, paras.filter((p) => p.page === box.page)).map((p) => p.en));

if (!headerPath) {
  for (const [key, near] of guessed) console.log(`${key.replace("\t", " ").trim()}\n${near.map((w) => `    ${w}`).join("\n") || "    (nothing found)"}`);
} else {
  const header = JSON.parse(readFileSync(headerPath, "utf8"));
  let added = 0;
  for (const box of header.boxes) {
    const near = guessed.get(`${box.field}\t${box.on ?? ""}`);
    if (box.near === undefined && near?.length) (box.near = near), added++;
  }
  writeFileSync(headerPath, `${JSON.stringify(header, null, 1)}\n`);
  console.error(`${headerPath}: guessed words put on ${added} of ${header.boxes.length} boxes; check them against the form`);
}
