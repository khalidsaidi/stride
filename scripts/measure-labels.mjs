// How well `stride header` reads the words beside a box (src/beside.mjs, src/paragraphs.mjs), measured on real
// forms: for each box of each form, the label Stride reads against the label that box was given by hand.
//
//   node scripts/measure-labels.mjs            both sets of forms
//   node scripts/measure-labels.mjs --why      and, for the boxes read wrongly, where the right label stood
//   node scripts/measure-labels.mjs --forms    and each form's own score
//
// The forms and their labels come from a catalogue in BigQuery: a table of PDFs (sha256, form_id, flat, lang,
// original_pdf: a gs:// address, fields_named) and a table of their fields (sha256, field_name, on_value, item_label,
// box_label). By default FillStride's archive; STRIDE_LABELS_PDFS and STRIDE_LABELS_FIELDS name others. One fillable
// English form is taken from each issuer, and the issuers are dealt into two sets: change the rule looking at
// "tuned", and believe the number "judged" gives, which the rule was never fitted to.
//
// It signs in as whoever this computer is signed in to Google as: `gcloud auth print-access-token`, or a token in
// STRIDE_GOOGLE_TOKEN. Nothing is written to the catalogue. What it downloads is kept in a folder outside the
// repository (STRIDE_LABELS_DIR, else the system's temporary folder) and read from there the next time.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PDFS = process.env.STRIDE_LABELS_PDFS ?? "fillstride-app.archive_map.pdfs";
const FIELDS = process.env.STRIDE_LABELS_FIELDS ?? "fillstride-app.archive_map.pdf_fields";
const PROJECT = PDFS.split(".")[0];
const DIR = process.env.STRIDE_LABELS_DIR ?? join(tmpdir(), "stride-labels");
const flags = new Set(process.argv.slice(2));

// ----- Google, read-only

let token = process.env.STRIDE_GOOGLE_TOKEN ?? null;
function access() {
  if (token) return token;
  try {
    token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new Error("not signed in to Google: run gcloud auth login, or give a token in STRIDE_GOOGLE_TOKEN");
  }
  return token;
}
async function query(sql) {
  const r = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/queries`, { method: "POST", headers: { authorization: `Bearer ${access()}`, "content-type": "application/json" }, body: JSON.stringify({ query: sql, useLegacySql: false, maxResults: 10000, timeoutMs: 60000 }) });
  const j = await r.json();
  if (j.error) throw new Error(`BigQuery: ${j.error.message}`);
  const names = (j.schema?.fields ?? []).map((f) => f.name);
  return (j.rows ?? []).map((row) => Object.fromEntries(row.f.map((c, i) => [names[i], c.v])));
}
async function download(gs) {
  const m = gs.match(/^gs:\/\/([^/]+)\/(.+)$/);
  const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${m[1]}/o/${encodeURIComponent(m[2])}?alt=media`, { headers: { authorization: `Bearer ${access()}` } });
  if (!r.ok) throw new Error(`${gs}: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// ----- the forms: one from each issuer, dealt into the two sets; each form's boxes, paragraphs and hand-given labels

const fileOf = (form) => form.form_id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
async function forms() {
  const list = join(DIR, "forms.json");
  if (existsSync(list)) return JSON.parse(readFileSync(list, "utf8"));
  const rows = await query(`
    select sha256, form_id, original_pdf, split(form_id, '-')[offset(0)] issuer
    from \`${PDFS}\`
    where not flat and lang = 'en' and original_pdf is not null and fields_named between 10 and 400
    qualify row_number() over (partition by split(form_id, '-')[offset(0)] order by farm_fingerprint(sha256)) = 1
    order by issuer`);
  // 40 issuers spread evenly through the list are the tuned set; the rest are judged.
  const tuned = new Set(Array.from({ length: Math.min(40, rows.length) }, (_, i) => Math.floor((i * rows.length) / 40)));
  const out = rows.map((r, i) => ({ ...r, set: tuned.has(i) ? "tuned" : "judged" }));
  writeFileSync(list, JSON.stringify(out, null, 1));
  return out;
}

let reader = null;
async function geometry(bytes) {
  if (!reader) {
    for (const name of ["DOMMatrix", "ImageData", "Path2D"]) globalThis[name] ??= class {};
    const [log, warn] = [console.log, console.warn];
    console.log = console.warn = () => {};
    try {
      globalThis.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
      reader = { pdfjs: await import("pdfjs-dist/legacy/build/pdf.mjs"), ...(await import("../src/paragraphs.mjs")), ...(await import("../src/pdf-boxes.mjs")) };
    } finally {
      [console.log, console.warn] = [log, warn];
    }
  }
  const pdf = await reader.pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const paras = await reader.paragraphs(pdf);
  // The boxes without the labels read for them: those are read below, by the rule as it stands now.
  const boxes = (await reader.pageBoxes(bytes, { paragraphs: paras })).map(({ near, printed, ...b }) => b);
  return { boxes, paras };
}

async function prepared(form) {
  const base = join(DIR, fileOf(form));
  if (!existsSync(`${base}.pdf`)) {
    const bytes = await download(form.original_pdf);
    if (createHash("sha256").update(bytes).digest("hex") !== form.sha256) throw new Error(`${form.form_id}: the PDF is not the one the catalogue names`);
    writeFileSync(`${base}.pdf`, bytes);
  }
  if (!existsSync(`${base}.labels.json`)) writeFileSync(`${base}.labels.json`, JSON.stringify(await query(`select field_name, on_value, item_label, box_label from \`${FIELDS}\` where sha256 = '${form.sha256}' and field_name is not null`)));
  // Read again each time: the paragraphs are part of what is measured.
  return { ...(await geometry(readFileSync(`${base}.pdf`))), labels: JSON.parse(readFileSync(`${base}.labels.json`, "utf8")) };
}

// ----- the measure

const norm = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const wordsOf = (s) => new Set(norm(s).split(" ").filter((w) => w.length > 1 || /\d/.test(w)));
// Two labels agree when one holds the other, a leading line number apart, or most of the shorter one's words are
// in the longer. Loose on purpose: a hand-given label is not always the printed words to the letter.
function agree(a, b) {
  const x = norm(a).replace(/^\d+[a-z]?\s+/, ""), y = norm(b).replace(/^\d+[a-z]?\s+/, "");
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const A = wordsOf(x), B = wordsOf(y);
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  if (small.size < 2) return false;
  let hit = 0;
  for (const w of small) if (big.has(w)) hit++;
  return hit / small.size >= 0.7;
}
// Where a paragraph stands from a box.
function where(box, p) {
  const h = Math.max(6, box.y2 - box.y1);
  const rows = Math.min(p.y2, box.y2) - Math.max(p.y1, box.y1) > 0.3 * Math.min(h, p.y2 - p.y1);
  const cols = Math.min(p.x2, box.x2) - Math.max(p.x1, box.x1) > 0;
  if (cols && p.y1 >= box.y1 - 1 && p.y2 <= box.y2 + 1) return "inside it";
  if (rows && p.x2 <= box.x1 + 2) return "on its left";
  if (rows && p.x1 >= box.x2 - 2) return "on its right";
  if (cols && p.y2 <= box.y1 + 2) return "above it";
  if (cols && p.y1 >= box.y2 - 2) return "below it";
  if (p.y2 <= box.y1 + 2) return "above and aside";
  if (p.y1 >= box.y2 - 2) return "below and aside";
  return "across its edge";
}

const { beside } = await import("../src/beside.mjs");
mkdirSync(DIR, { recursive: true });
const sets = { tuned: { forms: 0, boxes: 0, first: 0, among: 0, kinds: {}, why: {}, each: [] }, judged: { forms: 0, boxes: 0, first: 0, among: 0, kinds: {}, why: {}, each: [] } };
for (const form of await forms()) {
  let f;
  try {
    f = await prepared(form);
  } catch (e) {
    console.error(`left out: ${e.message}`);
    continue;
  }
  const truth = new Map();
  for (const r of f.labels) for (const k of [`${r.field_name}\t${r.on_value ?? ""}`, r.field_name]) if (!truth.has(k)) truth.set(k, r);
  const s = sets[form.set];
  const own = { form: form.form_id, boxes: 0, first: 0, among: 0 };
  for (const box of f.boxes) {
    const t = truth.get(`${box.field}\t${box.on ?? ""}`) ?? truth.get(box.field);
    const labels = t ? [t.box_label, t.item_label].filter((x) => norm(x).length > 1) : [];
    if (!labels.length) continue;
    const paras = f.paras.filter((p) => p.page === box.page);
    const near = beside(box, paras);
    const right = (p) => labels.some((l) => agree(p.en, l));
    const first = !!near[0] && right(near[0]), among = near.some(right);
    const kind = (s.kinds[box.kind] ??= { boxes: 0, first: 0, among: 0 });
    for (const c of [s, own, kind]) (c.boxes++, first && c.first++, among && c.among++);
    if (!first) {
      const nearest = paras.filter(right).map((p) => [Math.hypot(Math.max(0, p.x1 - box.x2, box.x1 - p.x2), Math.max(0, p.y1 - box.y2, box.y1 - p.y2)), p]).sort((a, b) => a[0] - b[0])[0];
      const why = `${box.kind === "check" || box.kind === "radio" ? "a tick box" : "a text box"}: the right label is ${nearest ? where(box, nearest[1]) : "not on the page as words"}; the one read is ${near[0] ? where(box, near[0]) : "none"}`;
      s.why[why] = (s.why[why] ?? 0) + 1;
    }
  }
  s.forms++;
  s.each.push(own);
}

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "-").padStart(6);
for (const [name, s] of Object.entries(sets)) {
  console.log(`${name}: ${s.forms} forms, ${s.boxes} boxes   right label first ${pct(s.first, s.boxes)}   right label among those read ${pct(s.among, s.boxes)}`);
  for (const [k, v] of Object.entries(s.kinds)) console.log(`  ${k.padEnd(8)} ${String(v.boxes).padStart(5)} ${pct(v.first, v.boxes)} ${pct(v.among, v.boxes)}`);
  if (flags.has("--forms")) for (const o of s.each.sort((a, b) => a.first / (a.boxes || 1) - b.first / (b.boxes || 1))) console.log(`  ${o.form.slice(0, 44).padEnd(46)} ${String(o.boxes).padStart(4)} ${pct(o.first, o.boxes)} ${pct(o.among, o.boxes)}`);
  if (flags.has("--why")) for (const [w, n] of Object.entries(s.why).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(n).padStart(4)}  ${w}`);
}
