// A fillable PDF as a workflow sees it, for its header (stride header, §17.6): every box the PDF has (its
// own field, by name) and the printed words beside it. The words come from the form's printed paragraphs
// (src/paragraphs.mjs), so a program is checked against the form the way a person reads it. `layer`,
// optional, gives layout blocks for the paragraphs (src/paragraphs.mjs).
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { paragraphs } from "./paragraphs.mjs";
import { beside } from "./beside.mjs";

// Boxes: { field, kind: text|check|radio|choice, on, options, page, x1, y1, x2, y2, max, multiline,
// tooltip, printed }, positions in page points from the top left. A check box or radio button is one box
// per export value (`on`); a choice list carries its options. Read-only boxes and buttons are not boxes.
export async function pageBoxes(bytes, layer) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const paras = layer?.paragraphs ?? (await paragraphs(pdf));
  const boxes = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const top = page.view[3];
    for (const a of await page.getAnnotations()) {
      if (!a.fieldName || a.readOnly || a.pushButton || !a.rect || a.fieldType === "Sig") continue;
      const kind = a.checkBox ? "check" : a.radioButton ? "radio" : a.fieldType === "Ch" ? "choice" : a.fieldType === "Tx" ? "text" : null;
      if (!kind) continue;
      const box = { field: a.fieldName, kind, page: n, x1: a.rect[0], y1: top - a.rect[3], x2: a.rect[2], y2: top - a.rect[1] };
      if (kind === "check") box.on = a.exportValue;
      if (kind === "radio") box.on = a.buttonValue;
      if (kind === "choice") box.options = (a.options ?? []).map((o) => o.exportValue ?? o.displayValue);
      if (a.maxLen) box.max = a.maxLen;
      if (a.multiLine) box.multiline = true;
      if (a.alternativeText?.trim()) box.tooltip = a.alternativeText.replace(/\s+/g, " ").trim();
      box.near = beside(box, paras.filter((p) => p.page === n)).map((p) => p.en);
      box.printed = box.near[0] ?? "";
      boxes.push(box);
    }
  }
  return boxes;
}
