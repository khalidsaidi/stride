// A form's printed paragraphs, each with its place on its page, for the words beside its boxes
// (beside.mjs). One rule: the PDF's own text lines, which never run across a gap, joined into
// paragraphs when they sit one under the other, overlapping, the same size, with no more than a line's
// height between them, never across a box people tick or type in, and inside one block when blocks are
// given. Blocks, when a caller has them, are layout blocks found for this PDF by other means. Positions are
// in page points from the top left.

// Pieces of text on the same baseline that touch are one line. A piece is { text, x, y, w, h } with y
// growing down; `gapLimit` is the widest gap between words of one line, in line heights.
export function joinLines(pieces, gapLimit = 0.8) {
  const out = [];
  for (const p of pieces) {
    const last = out.at(-1)?.at(-1);
    const gap = last ? p.x - (last.x + last.w) : 0;
    const same = last && Math.abs(p.y - last.y) < 0.35 * Math.max(p.h, last.h) && gap < gapLimit * p.h && gap > -0.5 * p.h;
    same ? out.at(-1).push(p) : out.push([p]);
  }
  return out.map((line) => ({ line, text: line.map((p) => p.text).join(" ").replace(/\s+/g, " ").trim() }));
}

// Lines: { page, x1, y1, x2, y2, text, group, edge, wall }; group is the block the line's middle is in, edge
// its right side (how wide a line of it can run), wall that side again when the block has borders.
// Blocks are { id, kind, page, x1, y1, x2, y2 }; a block with no
// kind (the paragraphs of an edition before) counts as bordered.
async function lines(pdf, blocks) {
  const out = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const [, , , top] = page.view;
    const all = (await page.getTextContent()).items.filter((i) => i.str?.trim());
    // Words printed sideways in a margin ("See instructions on page 3", up the page's edge) are not beside any
    // box: only the words that run the way most of the page's words run are read.
    const sideways = (i) => Math.abs(i.transform[1]) > Math.abs(i.transform[0]);
    const turned = all.filter(sideways).length > all.length / 2;
    const items = all.filter((i) => sideways(i) === turned);
    const pieces = items.map((i) => ({ text: i.str, x: i.transform[4], y: top - i.transform[5], w: i.width, h: i.height || Math.abs(i.transform[3]) }));
    // Without blocks, a wider gap between words on a line is taken as a new cell.
    for (const { line, text } of joinLines(pieces, blocks.length ? 0.8 : 0.4)) {
      const x1 = Math.min(...line.map((p) => p.x)), x2 = Math.max(...line.map((p) => p.x + p.w));
      const y2 = Math.max(...line.map((p) => p.y)), h = Math.max(...line.map((p) => p.h));
      const cx = (x1 + x2) / 2, cy = y2 - h / 2;
      // The smallest block holding the line's middle, if any.
      const block = blocks
        .filter((b) => b.page === n && cx >= b.x1 - 1 && cx <= b.x2 + 1 && cy >= b.y1 - 1 && cy <= b.y2 + 1)
        .sort((a, b) => (a.x2 - a.x1) * (a.y2 - a.y1) - (b.x2 - b.x1) * (b.y2 - b.y1))[0];
      // A table or its cell has printed borders a translation must stay inside; a plain block of text is
      // drawn tight round the English, so only what else is on the row limits it.
      const walled = block && (!block.kind || /cell|table/.test(block.kind));
      out.push({ page: n, x1, y1: y2 - h, x2, y2, text, group: block?.id ?? null, edge: block?.x2 ?? null, wall: walled ? block.x2 : null });
    }
  }
  return out;
}

async function fieldBoxes(pdf) {
  const out = new Map();
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const top = page.view[3];
    out.set(n, (await page.getAnnotations()).filter((a) => a.fieldName && a.rect).map((a) => ({ x1: a.rect[0], y1: top - a.rect[3], x2: a.rect[2], y2: top - a.rect[1] })));
  }
  return out;
}

function group(all, boxes) {
  const byGroup = new Map();
  for (const l of all) {
    const key = `${l.page}|${l.group ?? ""}`;
    byGroup.set(key, [...(byGroup.get(key) ?? []), l]);
  }
  const out = [];
  for (const g of byGroup.values()) {
    const open = [];
    for (const l of g.sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1)) {
      const h = l.y2 - l.y1;
      const afterBox = (boxes.get(l.page) ?? []).some((b) => b.x2 <= l.x1 + 2 && l.x1 - b.x2 < 3 * h && Math.min(b.y2, l.y2) - Math.max(b.y1, l.y1) > 0.3 * h);
      const p = afterBox ? null : open.find((p) => {
        const last = p.lines.at(-1);
        const size = Math.abs(h - (last.y2 - last.y1)) <= 0.2 * Math.max(h, last.y2 - last.y1);
        // A line only runs on from the one above when that one wrapped: this line's first word would not
        // have fitted after it. A short line above (a label, a list item, a paragraph's end) ends there.
        const word = (l.x2 - l.x1) * (l.text.split(" ")[0].length / l.text.length);
        const wrapped = last.x2 + 0.3 * h + word > (l.edge ?? Math.max(p.x2, l.x2)) - 0.5 * h;
        return size && wrapped && Math.min(l.x2, p.x2) - Math.max(l.x1, p.x1) > 0 && l.y1 - last.y2 < h && l.y1 >= last.y1 + 0.5 * h;
      });
      if (p) {
        p.lines.push(l);
        Object.assign(p, { x1: Math.min(p.x1, l.x1), x2: Math.max(p.x2, l.x2), y2: Math.max(p.y2, l.y2) });
      } else open.push({ page: l.page, x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, wall: l.wall, lines: [l] });
    }
    out.push(...open);
  }
  return out
    .map((p) => ({ page: p.page, x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, wall: p.wall, lines: p.lines.length, en: p.lines.map((l) => l.text).join(" ").replace(/\s+/g, " ").trim() }))
    .filter((p) => /\p{L}{2}/u.test(p.en))
    .sort((a, b) => a.page - b.page || a.y1 - b.y1 || a.x1 - b.x1);
}

// The paragraphs of an open PDF.js document, given blocks ({ id, page, x1, y1, x2, y2 }, possibly none).
// Each gets the room to its right a translation may use: up to the nearest box or other printed text on
// its rows, its table cell's edge, or the page's margin.
export async function paragraphs(pdf, blocks = []) {
  const boxes = await fieldBoxes(pdf);
  const paras = group(await lines(pdf, blocks), boxes);
  for (let n = 1; n <= pdf.numPages; n++) {
    const width = (await pdf.getPage(n)).view[2];
    const mine = paras.filter((p) => p.page === n);
    for (const p of mine) {
      const rows = (o) => Math.min(o.y2, p.y2) - Math.max(o.y1, p.y1) > 1;
      const right = [...boxes.get(n), ...mine.filter((o) => o !== p)].filter((o) => rows(o) && o.x1 >= p.x2 - 1).map((o) => o.x1);
      p.room = +Math.max(p.x2, Math.min(width - 18, p.wall ?? Infinity, ...right) - 3).toFixed(1);
    }
  }
  return paras.map(({ wall, ...p }) => p);
}
