// A fillable PDF's boxes, for the form's header (stride header, §17.6): what the PDF itself says of each box, and
// nothing worked out. Which printed words belong to a box is not in a PDF: whoever writes the program reads the
// form and says (§10.6).
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

// Boxes, one per PDF field: { field, kind: text|check|radio|choice, on, options, page, x1, y1, x2, y2, widgets, max,
// comb, multiline, readonly, tooltip }, positions in page points from the top left; `comb` marks a text box the PDF
// divides into `max` cells, a character to each.
// - A field is one box however many widgets it has (copies of the form, a field on two pages): `page` and x1…y2
//   are its first widget's, and `widgets` lists every widget's page and place (with its on value for a check box or
//   a radio button) when there is more than one.
// - `on`: a check box's on value, words, when its widgets share one; a list of them when its widgets have their own
//   (a check-box group used as a radio group); a radio group's buttons, a list.
// - A list box (a drop-down or a list to choose from; its kind is choice) carries its options; `tooltip` is the
//   description the PDF's maker gave the box, when there is one; a box the PDF marks read-only (a calculated total)
//   is `readonly`.
// The fields are found through the form's field tree (AcroForm), so a widget a page's annotations leave out is a
// box too; a widget on no page is not. Buttons and signatures are not boxes.
export async function pageBoxes(bytes) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const tops = [];
  const annotations = new Map(); // widget id -> { a, page }
  const order = []; // field names, in the order their first widget is met on the pages
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    tops[n] = page.view[3];
    for (const a of await page.getAnnotations()) {
      if (!a.fieldName || !a.rect) continue;
      annotations.set(a.id, { a, page: n });
      order.push(a.fieldName);
    }
  }
  const tree = (await pdf.getFieldObjects()) ?? {};
  // Each field's widgets: from the field tree, each with its page annotation when the page lists it; then the
  // widgets of page annotations the tree does not hold.
  const widgets = new Map(); // field -> [{ a, o, page }]
  const add = (name, w) => widgets.set(name, [...(widgets.get(name) ?? []), w]);
  const seen = new Set();
  for (const [name, objects] of Object.entries(tree)) {
    for (const o of objects) {
      if (!o.rect || typeof o.page !== "number" || o.page < 0 || o.page >= pdf.numPages) continue;
      const found = annotations.get(o.id);
      seen.add(o.id);
      add(name, { a: found?.a ?? null, o, page: found?.page ?? o.page + 1 });
    }
    if (!order.includes(name) && widgets.has(name)) order.push(name);
  }
  for (const [id, { a, page }] of annotations) if (!seen.has(id)) add(a.fieldName, { a, o: null, page });

  const kindOf = ({ a, o }) => {
    if (a) {
      if (a.pushButton || a.fieldType === "Sig") return null;
      return a.checkBox ? "check" : a.radioButton ? "radio" : a.fieldType === "Ch" ? "choice" : a.fieldType === "Tx" ? "text" : null;
    }
    return { text: "text", checkbox: "check", radiobutton: "radio", combobox: "choice", listbox: "choice" }[o?.type] ?? null;
  };
  const onOf = ({ a, o }, kind) => (kind === "check" ? a?.exportValue ?? o?.exportValues ?? "Yes" : kind === "radio" ? a?.buttonValue ?? o?.exportValues : undefined);
  const placeOf = ({ a, o, page }) => {
    const r = a?.rect ?? o.rect;
    const top = tops[page];
    const at = (v) => Math.round(v * 100) / 100;
    return { page, x1: at(r[0]), y1: at(top - r[3]), x2: at(r[2]), y2: at(top - r[1]) };
  };

  const boxes = [];
  for (const field of new Set(order)) {
    const all = (widgets.get(field) ?? []).filter((w) => kindOf(w));
    if (!all.length) continue;
    const kind = kindOf(all[0]);
    const mine = all.filter((w) => kindOf(w) === kind);
    const first = mine[0];
    const box = { field, kind };
    if (kind === "check" || kind === "radio") {
      const ons = [...new Set(mine.map((w) => onOf(w, kind)).filter((v) => typeof v === "string" && v !== "" && v !== "Off"))];
      box.on = kind === "check" && ons.length <= 1 ? ons[0] ?? "Yes" : ons;
    }
    if (kind === "choice") box.options = (first.a?.options ?? first.o?.items ?? []).map((x) => x.exportValue ?? x.displayValue);
    Object.assign(box, placeOf(first));
    const max = first.a?.maxLen || first.o?.charLimit;
    if (max) box.max = max;
    // A comb field: its max characters each in a cell of its own (a code, a number written digit by digit).
    if (kind === "text" && (first.a?.comb || first.o?.comb)) box.comb = true;
    if (first.a?.multiLine || first.o?.multiline) box.multiline = true;
    if (mine.some((w) => w.a?.readOnly || w.o?.editable === false)) box.readonly = true;
    const tip = mine.map((w) => w.a?.alternativeText?.trim()).find((t) => t);
    if (tip) box.tooltip = tip.replace(/\s+/g, " ").trim();
    if (mine.length > 1) box.widgets = mine.map((w) => ({ ...placeOf(w), ...(kind === "check" || kind === "radio" ? { on: onOf(w, kind) } : {}) }));
    boxes.push(box);
  }
  return boxes;
}
