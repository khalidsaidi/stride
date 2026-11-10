// The printed words beside a form's box, from the form's paragraphs (src/paragraphs.mjs): what a
// person reads as the box's label, for the header a program is checked against (src/pdf-boxes.mjs). Boxes
// and paragraphs in page points from the top left.

// The printed words a person may read as the box's label, nearest first (at most six): on its row to
// either side (a check box's label more often to its right, any other box's to its left), printed inside
// it or across its edge, or just above it. `printed` is the nearest; a question's printed words may be any
// of them.
//
// The numbers here were set by measuring, not by taste: against the label each box was given by hand on 91
// issuers' real forms (7,931 boxes), tuned on 40 of them and judged on the other 51. Change one only with
// that measure in hand.
// Words printed right under a box, narrower than it and centred within it: its caption.
export const caption = (box, p) => p.y1 >= box.y2 - 2 && p.x2 - p.x1 < box.x2 - box.x1 && (p.x1 + p.x2) / 2 > box.x1 && (p.x1 + p.x2) / 2 < box.x2;

export function beside(box, paras) {
  const h = Math.max(6, box.y2 - box.y1);
  const rows = (p) => Math.min(p.y2, box.y2) - Math.max(p.y1, box.y1) > 0.3 * Math.min(h, p.y2 - p.y1);
  const cols = (p) => Math.min(p.x2, box.x2) - Math.max(p.x1, box.x1) > 0;
  const tick = box.kind === "check" || box.kind === "radio";
  const found = [];
  // A paragraph much wider than the box is more often a sentence about the section than the box's label.
  const wide = (p) => (p.x2 - p.x1 > 2.5 * (box.x2 - box.x1) && p.x2 - p.x1 > 150 ? 20 : 0);
  for (const p of paras) {
    if (rows(p) && p.x1 >= box.x2 - 2) found.push([p.x1 - box.x2 + (tick ? 0 : 40), p]);
    else if (rows(p) && p.x2 <= box.x1 + 2) found.push([box.x1 - p.x2 + (tick ? 5 : 0), p]);
    else if (cols(p) && p.y1 >= box.y1 - 1 && p.y2 <= box.y2 + 1) found.push([0, p]);
    else if (cols(p) && p.y2 <= box.y1 + 2 && box.y1 - p.y2 < 3 * h) found.push([box.y1 - p.y2 + 10, p]);
    // A caption printed under the box, within its width (as under a signature line). The words above a box
    // are its label far more often than those under it, which on most forms are the next line's: a caption
    // comes after them.
    else if (cols(p) && p.y1 >= box.y2 - 2 && p.y1 - box.y2 < 1.5 * h) found.push([p.y1 - box.y2 + (caption(box, p) ? 25 : 45), p]);
    // A heading above and to the left, as over a row of boxes: "Taxpayer identification number(s)".
    else if (p.y2 <= box.y1 + 2 && box.y1 - p.y2 < 3 * h && p.x2 <= box.x1 && box.x1 - p.x2 < 60) found.push([box.y1 - p.y2 + box.x1 - p.x2 + 20, p]);
    // Words that run across the box's edge, partly over it: a cell's own label is often printed so.
    else if (cols(p) && Math.min(p.y2, box.y2) - Math.max(p.y1, box.y1) > 0) found.push([3, p]);
  }
  for (const f of found) f[0] += wide(f[1]);
  const near = found.filter(([d]) => d < 400).sort((a, b) => a[0] - b[0]).slice(0, 6).map(([, p]) => p);
  // A table cell: its column's heading too, the nearest words straight above it and the lines stacked on
  // them (a heading printed over several lines).
  const above = paras.filter((p) => cols(p) && p.y2 <= box.y1 + 2 && box.y1 - p.y2 < 200).sort((a, b) => b.y2 - a.y2);
  const head = above.filter((p, i) => i === 0 || above[0].y1 - p.y2 < 30);
  return [...near, ...head.filter((t) => !near.includes(t))];
}

// A table cell's column heading: the narrow words straight above the box, with the lines stacked tight on
// them, top first. None for a box with a wide paragraph or nothing above it.
export function heading(box, paras) {
  const cols = (p) => Math.min(p.x2, box.x2) - Math.max(p.x1, box.x1) > 0;
  const w = box.x2 - box.x1;
  // A column's heading is about as wide as its column: not much wider, not a small label.
  const narrow = (p) => p.x2 - p.x1 <= 1.2 * w && p.x2 - p.x1 >= 0.4 * w;
  const above = paras.filter((p) => cols(p) && p.y2 <= box.y1 + 2 && box.y1 - p.y2 < 200).sort((a, b) => b.y2 - a.y2);
  const out = [];
  for (const p of above) {
    if (!narrow(p) || (out.length && out.at(-1).y1 - p.y2 > 3)) break;
    out.push(p);
  }
  return out.reverse();
}
