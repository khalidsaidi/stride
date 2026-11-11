// The form's side of a program (docs/spec.md §10): what the compiler looks up in the form's header.
//
// It is a lookup, as a name is looked up among the declarations: a box a program names, written out, is one of
// the form's, and is written by the statement of its kind. Nothing is followed and nothing is proved: what a
// program does with its boxes as it runs is the run's business (a name worked out as it runs that the form lacks is
// F016, §11.2). Stride is no stricter than the form.
//
//   S501, S502   the header is for another PDF, or another form
//   S508         a box written out that the form does not have (with the nearest)
//   S509         a box written by the statement of another kind
//   S511         a button a radio group does not have
//   S514         a list box given words, written out, that are not one of its entries
//
// Gives the machine what it needs of the form: every box (its kind, and a check box's export value), every
// question the program asks, and, for the page, which boxes a question's answer goes into, where the program
// says so plainly (`fill "box" = answer`, `tick "box" when … answer …`).
import { KIND, didYouMean } from "./source.mjs";
import { textOf } from "../runtime/natives.mjs";
import * as V from "../runtime/values.mjs";

// What an expression is when it is written out: words, a number, a date; undefined when it is worked out as the
// program runs.
function written(x) {
  if (!x) return undefined;
  if (x.e === "const") return x.v;
  if (x.e === "concat") {
    const parts = x.parts.map(written);
    return parts.some((p) => p === undefined) ? undefined : parts.map((p) => (V.isEmpty(p) ? "" : textOf(p))).join("");
  }
  return undefined;
}
const wordsOf = (x) => {
  const v = written(x);
  return v === undefined ? undefined : V.isEmpty(v) ? "" : textOf(v);
};

// The locals an expression reads.
function* localsIn(x) {
  if (!x || typeof x !== "object") return;
  if (x.e === "local") yield x.l;
  for (const v of Object.values(x)) {
    if (Array.isArray(v)) for (const y of v) yield* localsIn(y);
    else if (v && typeof v === "object" && v.e) yield* localsIn(v);
  }
}

// `open`: the header lists no boxes on purpose (a test's, a script's): every box the program names is taken as one
// of the form's, of the kind its statement writes.
export function checkForm(program, header, diagnostics, { open = false } = {}) {
  const err = (code, node, message) =>
    code.startsWith("W") ? diagnostics.warn(KIND.PDF, node?.file ?? null, node?.span ?? null, message, [], code) : diagnostics.add(KIND.PDF, node?.file ?? null, node?.span ?? null, message, [], code);
  const once = new Set();
  const errOnce = (code, key, node, message) => !once.has(key) && (once.add(key), err(code, node, message));

  if (!open && header.pdf !== program.pdf) err("S501", program.pdfNode ?? null, `the program is written for the PDF ${program.pdf.slice(0, 12)}…, and the header is for ${header.pdf.slice(0, 12)}… (run stride header ${program.form}.pdf again, or fix the pdf line)`);
  if (!open && header.form && header.form !== program.form) err("S502", program.formNode ?? null, `the program is for the form ${program.form}, and the header for ${header.form}`);

  const prefix = program.prefix;
  const byField = new Map();
  for (const b of header.boxes) byField.set(b.field, [...(byField.get(b.field) ?? []), b]);
  const shortNames = [...byField.keys()].map((f) => (f.startsWith(prefix) ? f.slice(prefix.length) : f));

  const boxes = new Map(); // full name -> { kind: the statement that writes it, on: a check box's export value }
  for (const b of header.boxes) if (!boxes.has(b.field)) boxes.set(b.field, { kind: b.kind === "check" ? "tick" : b.kind === "radio" ? "pick" : "fill", on: b.kind === "check" ? b.on ?? "Yes" : null });
  const writtenOut = new Set(); // the boxes it writes, written out
  const questions = new Set();
  const keys = new Map(); // a question's key, written out -> { q, printed, node }
  const links = new Map(); // key \t box -> { key, box, direct }
  const maxOf = new Map();

  for (const fn of program.functions) {
    // Which questions each local holds an answer of: the ask's own local, and a let made from such locals.
    const from = new Map(); // local -> Set of ask statements
    const stmts = fn.blocks.flatMap((b) => b.stmts);
    for (const s of stmts) if (s.op === "ask") from.set(s.dst, new Set([s]));
    for (let changed = true; changed; ) {
      changed = false;
      for (const s of stmts) {
        if (s.op !== "set" || !s.value) continue;
        const mine = from.get(s.dst) ?? new Set();
        const before = mine.size;
        for (const l of localsIn(s.value)) for (const a of from.get(l) ?? []) mine.add(a);
        if (mine.size > before) (from.set(s.dst, mine), (changed = true));
      }
    }
    const asksIn = (x) => new Set([...localsIn(x)].flatMap((l) => [...(from.get(l) ?? [])]));

    for (const s of stmts) {
      if (s.op === "ask") {
        questions.add(s.q);
        const key = wordsOf(s.key);
        if (key !== undefined && !keys.has(key)) keys.set(key, { q: s.q, printed: wordsOf(s.printed) ?? "", node: s.node });
        continue;
      }
      if (!["fill", "tick", "pick"].includes(s.op)) continue;
      // The questions this write is made of, for the run to say which box an answer went into (codegen.mjs).
      const made = s.op === "fill" ? s.value : s.cond;
      const given = s.op === "fill" && made?.e === "local" && from.get(made.l)?.size === 1 && [...from.get(made.l)][0].dst === made.l;
      s.sources = [...asksIn(made)].map((a) => ({ q: a.q, direct: given }));
      const short = wordsOf(s.box);
      if (short === undefined) continue; // worked out as the program runs: the run looks it up
      const full = prefix + short;
      if (open) {
        // Taken as one of the form's, of this statement's kind.
        if (!boxes.has(full)) boxes.set(full, { kind: s.op, on: s.op === "tick" ? "Yes" : null });
      }
      const found = byField.get(full);
      if (!found && !open) {
        errOnce("S508", `nobox\t${full}\t${s.node?.span?.start}`, s.node?.box ?? s.node, program.script ? `a script has no form, so it has no box "${short}" to write; start the file with form and pdf lines to fill a form (§4.6)` : `the PDF has no box "${short}"${didYouMean(short, shortNames)}`);
        continue;
      }
      writtenOut.add(full);
      if (found) {
        const first = found[0];
        const kinds = { fill: ["text", "choice"], tick: ["check"], pick: ["radio"] };
        if (!kinds[s.op].includes(first.kind)) {
          const how = { text: "fill", choice: "fill", check: "tick", radio: "pick" }[first.kind];
          errOnce("S509", `kind\t${full}\t${s.node?.span?.start}`, s.node, `"${short}" is a ${first.kind === "check" ? "check box" : first.kind === "radio" ? "radio group" : `${first.kind} box`}; ${s.op} cannot write it (${how} does)`);
          continue;
        }
        if (s.op === "pick") {
          const button = wordsOf(s.button);
          if (button !== undefined && !found.some((b) => b.on === button)) {
            errOnce("S511", `button\t${full}\t${button}`, s.node?.button ?? s.node, `the radio group "${short}" has no button "${button}"; it has ${found.map((b) => `"${b.on}"`).join(", ")}`);
          }
        }
        if (s.op === "fill" && first.kind === "choice" && first.options) {
          const w = wordsOf(s.value);
          if (w !== undefined && w !== "" && !first.options.includes(w)) errOnce("S514", `choice\t${full}\t${w}`, s.node?.value ?? s.node, `the list box "${short}" has no entry "${w}"`);
        }
      }
      // Which questions' answers go into this box: as given (`fill "box" = answer`), or deciding what is written.
      const value = s.op === "fill" ? s.value : s.cond;
      const direct = s.op === "fill" && value?.e === "local" && from.get(value.l)?.size === 1 && [...from.get(value.l)][0].dst === value.l;
      for (const a of asksIn(value)) {
        const key = wordsOf(a.key);
        if (key === undefined) continue;
        const id = `${key}\t${full}`;
        const was = links.get(id);
        if (!was) links.set(id, { key, box: full, direct });
        else if (direct) was.direct = true;
        const max = found?.[0]?.max;
        if (direct && max) maxOf.set(key, Math.min(maxOf.get(key) ?? Infinity, max));
      }
    }
  }

  return { boxes, written: writtenOut, questions: [...questions], links: [...links.values()], maxOf, keys };
}
