// A fillable PDF's boxes, for the form's header (stride header, §17.6): what the PDF itself says of each box, and
// nothing worked out. Which printed words belong to a box is not in a PDF: whoever writes the program reads the
// form and says (§10.6).
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

// Boxes: { field, kind: text|check|radio|choice, on, options, page, x1, y1, x2, y2, max, multiline, tooltip },
// positions in page points from the top left. A check box or radio button is one box per export value (`on`); a
// choice list carries its options; `tooltip` is the description the PDF's maker gave the box, when there is one.
// Read-only boxes, buttons and signatures are not boxes.
export async function pageBoxes(bytes) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
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
      boxes.push(box);
    }
  }
  return boxes;
}
