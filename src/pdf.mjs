// Phase 8: check the program against its PDF, through the form's header (<form>.boxes.json, started by
// `stride header`): the PDF's sha256 and its boxes, each with its kind (text, check, radio, choice), its
// export value (`on`), the most characters it takes (`max`) and, when whoever made the header gave them, the words
// printed beside it (`near`). The header is input: the check takes what it says.
//
// The check is an abstract interpretation of the lowered program: it runs it the way the machine will, on every
// path at once, with every answer unknown. What does not depend on an answer (a loop's counter, a list's length
// in each turn, a function's arguments) is worked out exactly; a condition on an answer sends it down both
// branches. So it knows, at each statement, the box name and question key that statement uses, and what has been
// written and asked before it on that path; where two paths meet with the same known values they are taken
// together. A function is followed into from each call, with that call's values.
//
// On every path it proves: every box name names a box of the PDF, of the kind its statement writes (fill a text
// or choice box, tick a check box, pick a button a radio group has); no box is written twice and no question asked
// twice; and at the end, that every box is written or skipped somewhere and, for the boxes whose words the header
// lists, that a question's printed words are among those of a box its answer goes into, and an option's among those
// of the box it ticks or picks.
//
// It also gives the machine what the PDF says: each check box's export value; and to the page, for each question
// key, the boxes its answer goes into (and which take it as it is) and their most length.
import * as V from "../runtime/values.mjs";
import { KIND, didYouMean, plural } from "./source.mjs";
import * as IR from "./ir.mjs";
import { NATIVES, StrideRecord, textOf } from "../runtime/natives.mjs";
import { binary as op2, unary as op1 } from "../runtime/ops.mjs";
import { interpret } from "./interpret.mjs";
import { AnalysisLimit } from "./constant.mjs";

// A value not known before the form opens, with the answers it may hold (by key), and the one answer it is as it
// is, if it is one. What is known about it all the same: a list's most (`most`, so how many items it can hold),
// a number's largest value (`max`, a list's count): enough to tell that a for each over a list whose items depend
// on the answers ends by its most.
class Top {
  constructor(from = new Set(), direct = null, bounds = {}) {
    this.from = from;
    this.direct = direct;
    this.most = bounds.most;
    this.max = bounds.max;
    this.pred = null; // for a yes or no made of answers: what it says of them (a Pred, §10.4.1)
  }
}

let unique = 0;
// A structural signature kept short: each distinct one is given a number once, so nested calls never build long
// strings.
const interned = new Map();
// Each function its own number: two libraries may each have one of the same name.
const fnIds = new WeakMap();
const fnId = (fn) => {
  if (!fnIds.has(fn)) fnIds.set(fn, unique++);
  return fnIds.get(fn);
};
const intern = (key) => {
  let id = interned.get(key);
  if (id === undefined) interned.set(key, (id = `#${interned.size}`));
  return id;
};
const sigOf = (v) => (isTop(v) ? (v.sig ?? (v.direct ? `answer:${v.direct}` : (v.sig = `?${unique++}`))) : `=${JSON.stringify(v ?? null)}`);

// What a yes or no not known before the form opens says of the answers: { k: "lit", key, op, c } (the answer
// `key` compared with the known value c), { k: "not" | "and" | "or", a, b }, { k: "const", v }, or { k: "opaque",
// id } for one that says nothing the check can read (the same unknown value is the same atom wherever it stands).
const COMPARE = new Set(["<", "<=", ">", ">=", "==", "!="]);
const FLIP = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "==": "==", "!=": "!=" };
function predOf(v) {
  if (v === true || v === false) return { k: "const", v };
  if (!isTop(v)) return { k: "const", v: false }; // empty, in a condition, is no
  if (v.pred) return v.pred;
  if (v.direct) return { k: "lit", key: v.direct, op: "==", c: true }; // a yes-no answer itself
  return { k: "opaque", id: sigOf(v) };
}
// Whether a write stands inside an if or match: the branches that are taken to reach it, not ones closed before.
const encloses = (b, w) => !!b && !!w && (b.kind === "if" || b.kind === "match") && b.file === w.file && b.span && w.span && b.span.start <= w.span.start && w.span.end <= b.span.end;

// How an unknown was made, kept out of sight of signatures and printing (§10.3).
const withRecipe = (t, recipe) => Object.defineProperty(t, "recipe", { value: recipe, enumerable: false, writable: true });

// An unknown made of the same answers as v, but a fact of its own.
function fresh(v) {
  const t = new Top(v.from, null, { most: v.most, max: v.max });
  t.sig = `?${unique++}`;
  return t;
}
function withPred(t, pred) {
  t.pred = pred;
  return t;
}
// The most a list value can hold, known or not; undefined when nothing says.
const mostBound = (v) => (V.isSet(v) ? undefined : Array.isArray(v) ? V.mostOf(v) : isTop(v) ? v.most : undefined);
const isTop = (v) => v instanceof Top;
const top = (...values) => new Top(new Set(values.flatMap((v) => [...taints(v)])));
function taints(v) {
  if (isTop(v)) return v.from;
  if (Array.isArray(v)) return new Set(v.flatMap((x) => [...taints(x)]));
  if (v instanceof StrideRecord) return new Set(v.fields.flatMap((x) => [...taints(x)]));
  return new Set();
}
const known = (v) => !isTop(v) && !(Array.isArray(v) && v.some((x) => !known(x))) && !(v instanceof StrideRecord && v.fields.some((x) => !known(x)));

// Values copied when a path splits: lists and records are changed in place as the program runs.
const copy = (v) => V.copy(v);
const forkState = (st) => st.copy();

// A path's turn of the loops whose counters are given.
const turnOf = (st, counters) => counters.map((l) => shape(st.locals.get(l) ?? null)).join("|");

// A value's shape, for telling whether two paths may be taken together: the same known values, unknowns in the
// same places. Empty and unknown are one shape: an answer asked in a branch that one path took and the other did
// not is, for the check, an answer it does not know either way.
function shape(v) {
  if (isTop(v) || v === null || v === undefined) return "?";
  if (Array.isArray(v)) return `[${v.map(shape).join(",")}]`;
  if (v instanceof StrideRecord) return `{${v.fields.map(shape).join(",")}}`;
  return JSON.stringify(v ?? null);
}

// A value's signature: two values of one signature are the same to every check after them: the same known value
// of the same type, a list of the same most, the same unknown (the answers it is made of, how, what it says of
// them, what is known of its size). Not ==, which leaves a list's most out (§6.6).
const ids = new WeakMap();
const idOf = (o) => {
  if (!ids.has(o)) ids.set(o, unique++);
  return ids.get(o);
};
function sign(v) {
  if (v === null || v === undefined) return "_";
  // An unknown whose signature is interned (`#…`) is named by how it is made, from what: that is what it says and
  // how it is worked out again, wherever the object came from. Any other is its own object.
  if (isTop(v)) {
    const own = v.sig?.startsWith("#") ? "" : `~${v.pred ? idOf(v.pred) : ""}~${v.recipe ? idOf(v.recipe) : ""}`;
    return `?${sigOf(v)}~${v.most}~${v.max}${own}~${[...v.from].sort().join(",")}`;
  }
  if (V.isSet(v)) return `s${JSON.stringify(v.map((x) => V.words(x)))}`;
  if (Array.isArray(v)) return `l${V.mostOf(v)}[${v.map(sign).join(",")}]`;
  if (v instanceof StrideRecord) return `r${v.type}:${v.names?.join(",") ?? ""}{${v.fields.map(sign).join(",")}}`;
  if (V.isNumber(v)) return `n${V.words(v)}`;
  if (V.isDate(v)) return `d${V.words(v)}`;
  return `${typeof v}${JSON.stringify(v)}`;
}

// A condition's key, once per condition: two of one key say the same of the same answers. A formula's parts are
// keyed once each, so one shared by many is never written out again.
const formulaKeys = new WeakMap();
const formulaKey = (f) => {
  if (!formulaKeys.has(f)) {
    const k = f.k === "lit" ? `lit${JSON.stringify([f.key, f.op, Array.isArray(f.c) ? f.c.map(sign) : sign(f.c)])}` : f.k === "const" ? `c${f.v}` : f.k === "opaque" ? `o${f.id}` : `${f.k}(${formulaKey(f.a)}${f.b ? `,${formulaKey(f.b)}` : ""})`;
    formulaKeys.set(f, intern(k));
  }
  return formulaKeys.get(f);
};
const factKey = (f) => `${f.truth ? "+" : "-"}${formulaKey(f.f)}`;
// A write, ask, skip or pick on a path: its statement and the conditions it was done under.
const entryKeys = new WeakMap();
const entryKey = (e) => {
  if (!entryKeys.has(e)) entryKeys.set(e, intern(`${idOf(e.stmt ?? e.node ?? e)}\t${e.f ? factKey(e) : ""}\t${factsKey(e.facts ?? [])}`));
  return entryKeys.get(e);
};
// A path's conditions as one key, shared by the entries made on it.
const factsKeys = new WeakMap();
const factsKey = (fs) => {
  if (!factsKeys.has(fs)) factsKeys.set(fs, intern(fs.map(factKey).join("\n")));
  return factsKeys.get(fs);
};
// The keys of a list of entries, worked out once per list.
const entrySets = new WeakMap();
const entrySet = (list) => {
  if (!entrySets.has(list)) entrySets.set(list, new Set(list.map(entryKey)));
  return entrySets.get(list);
};

const copyLocals = (m) => new Map([...m].map(([k, v]) => [k, copy(v)]));

// A map from text that is never changed: `with` gives a new one sharing all it can with the old, so a path splits
// without copying what it has written and asked, however much that is. A hash array mapped trie: each inner node
// takes five bits of the key's hash, and keeps only the children it has; a leaf is { h, k, v }, keys of one hash
// share one node of leaves. A key's value is a list of entries (§10.4.0): a key already there gains the entries it
// did not have.
const hashOf = (k) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 0x01000193);
  return h >>> 0;
};
const bitOf = (h, depth) => 1 << ((h >>> (depth * 5)) & 31);
const below = (bits, b) => {
  let x = bits & (b - 1), n = 0;
  for (; x; x &= x - 1) n++;
  return n;
};
const leavesOf = (node) => node.leaves ?? [node];
const INNER = { bits: 0, kids: [] };

function put(node, depth, leaf) {
  if (!node) return leaf;
  if (node.kids) {
    const b = bitOf(leaf.h, depth), i = below(node.bits, b);
    if (!(node.bits & b)) return { bits: node.bits | b, kids: [...node.kids.slice(0, i), leaf, ...node.kids.slice(i)] };
    const kid = put(node.kids[i], depth + 1, leaf);
    if (kid === node.kids[i]) return node;
    const kids = node.kids.slice();
    kids[i] = kid;
    return { bits: node.bits, kids };
  }
  if (node.h === leaf.h) {
    let changed = false;
    const leaves = leavesOf(node).map((m) => {
      const l = leavesOf(leaf).find((x) => x.k === m.k);
      if (!l || l.v === m.v) return m;
      const have = entrySet(m.v);
      const added = l.v.filter((e) => !have.has(entryKey(e)));
      if (!added.length) return m;
      changed = true;
      return { h: m.h, k: m.k, v: [...m.v, ...added] };
    });
    const added = leavesOf(leaf).filter((l) => !leavesOf(node).some((m) => m.k === l.k));
    return added.length || changed ? { h: node.h, leaves: [...leaves, ...added] } : node;
  }
  // Two hashes in one place: an inner node holds both, they part at the first five bits that differ.
  return put(put(INNER, depth, node), depth, leaf);
}

// What a has, and what b has that a does not; the parts both share are not looked into.
function join(a, b, depth) {
  if (a === b || !b) return a;
  if (!a) return b;
  if (!b.kids) return put(a, depth, b);
  if (!a.kids) return join(put(INNER, depth, a), b, depth);
  let out = a;
  for (let bits = b.bits; bits; bits &= bits - 1) {
    const bb = bits & -bits;
    const kid = b.kids[below(b.bits, bb)];
    const i = below(out.bits, bb);
    if (!(out.bits & bb)) out = { bits: out.bits | bb, kids: [...out.kids.slice(0, i), kid, ...out.kids.slice(i)] };
    else {
      const met = join(out.kids[i], kid, depth + 1);
      if (met !== out.kids[i]) {
        const kids = out.kids.slice();
        kids[i] = met;
        out = { bits: out.bits, kids };
      }
    }
  }
  return out;
}

class Keys {
  constructor(root = null) {
    this.root = root;
  }

  get(k) {
    const h = hashOf(k);
    let node = this.root;
    for (let depth = 0; node?.kids; depth++) {
      const b = bitOf(h, depth);
      if (!(node.bits & b)) return undefined;
      node = node.kids[below(node.bits, b)];
    }
    return node ? leavesOf(node).find((l) => l.k === k)?.v : undefined;
  }

  has(k) {
    return this.get(k) !== undefined;
  }

  with(k, v) {
    const root = put(this.root, 0, { h: hashOf(k), k, v });
    return root === this.root ? this : new Keys(root);
  }

  // These keys and those of another; the same object when the other adds nothing.
  and(other) {
    const root = join(this.root, other.root, 0);
    return root === this.root ? this : new Keys(root);
  }
}

class State {
  constructor(locals = new Map(), written = new Keys(), asked = new Keys(), skipped = new Keys(), picks = new Map(), facts = []) {
    this.locals = locals; // Local -> value
    this.written = written; // box key -> the statement that first wrote it on this path
    this.asked = asked; // question key -> the statement that first asked it on this path
    this.skipped = skipped; // box key (a radio group's: "radio\t" + field) -> the skip that first skipped it on this path
    this.picks = picks; // radio group key -> [the picks on this path that may select it: a Condition each]
    this.facts = facts; // [Condition]: the conditions on answers this path took, each yes or no
  }

  copy() {
    return new State(copyLocals(this.locals), this.written, this.asked, this.skipped, new Map(this.picks), this.facts);
  }

  // Everything the rest of the check reads of this path's values (§10.4.0).
  sign(fn) {
    return fn.locals.map((l) => sign(this.locals.has(l) ? this.locals.get(l) : null)).join("|");
  }
}

const MAX_PATHS = 100_000; // paths kept apart at one point, in one call and turn (§15.1): past it, S602, never a merge
const MAX_TURNS = 100_000; // turns of loops the PDF check follows, over the whole check (§15.1)
const MAX_PROOF = 100_000; // steps of one search for conditions that can hold together (§15.1)
const MAX_WORKING = 100_000; // steps of the interpreter working out one pure call (§15.1)
const KEEPS_MOST = new Set(["sorted", "sorted_by", "reversed", "filled", "append", "without", "widen"]);

// ----- the values an answer can be, ordered, for the picks of a radio group (§10.4.1)

// Days as whole numbers, from the calendar itself (a two-digit year is that year, not 1900 and after).
const dayOf = (d) => {
  const y = d.m <= 2 ? d.y - 1 : d.y, era = Math.floor(y / 400), yoe = y - era * 400;
  const doy = Math.floor((153 * (d.m + (d.m > 2 ? -3 : 9)) + 2) / 5) + d.d - 1;
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
};
const DAY_MIN = dayOf({ y: 1, m: 1, d: 1 }), DAY_MAX = dayOf({ y: 9999, m: 12, d: 31 });
const DATES = {
  kind: "ordered",
  inside: (d) => dayOf(d),
  valid: (d) => dayOf(d) >= DAY_MIN && dayOf(d) <= DAY_MAX,
  compare: (a, b) => dayOf(a) - dayOf(b),
  cmp: (a, b) => a - b,
  min: DAY_MIN,
  next: (n) => (n + 1 > DAY_MAX ? null : Math.max(n + 1, DAY_MIN)),
};

// Numbers as [coefficient, exponent] with exact BigInt arithmetic: at most 34 digits, below 10^34 in size, a
// multiple of 10^-6176 (§3.3).
const normal = ([c, e]) => {
  if (c === 0n) return [0n, 0];
  while (c % 10n === 0n) (c /= 10n), e++;
  return [c, e];
};
const digits = (c) => (c < 0n ? -c : c).toString().length;
const representable = ([c, e]) => c === 0n || (digits(c) <= 34 && e >= -6176 && digits(c) + e <= 34);
const numCmp = ([a, x], [b, y]) => {
  const m = Math.min(x, y);
  const p = a * 10n ** BigInt(x - m), q = b * 10n ** BigInt(y - m);
  return p < q ? -1 : p > q ? 1 : 0;
};
const numAdd = ([a, x], [b, y]) => {
  const m = Math.min(x, y);
  return normal([a * 10n ** BigInt(x - m) + b * 10n ** BigInt(y - m), m]);
};
// The value next after n: n plus the finest step at which the sum is a number at all.
const numStep = (n, sign) => {
  const [c, e] = normal(n);
  const top = c === 0n ? -6176 : digits(c) + e;
  for (let q = Math.max(-6176, top - 36); q <= 34; q++) {
    const v = numAdd([c, e], [BigInt(sign), q]);
    if (representable(v)) return v;
  }
  return null;
};
const MAX_NUM = [10n ** 34n - 1n, 0];
const NUMBERS = {
  kind: "ordered",
  inside: (d) => normal([d.c, d.e]),
  valid: (d) => representable(normal([d.c, d.e])),
  compare: (a, b) => V.D.compare(a, b),
  cmp: numCmp,
  min: [-(10n ** 34n - 1n), 0],
  next: (n) => {
    if (numCmp(n, MAX_NUM) >= 0) return null;
    const v = numStep(n, 1);
    return v && numCmp(v, MAX_NUM) <= 0 ? v : null;
  },
};

// Words in code point order; the word next after w is w and the character 0, while it stays 100,000 characters
// or fewer (§3.1, §6.7).
const cpCmp = (a, b) => V.order(a, b);
const WORDS = {
  kind: "ordered",
  inside: (w) => w,
  valid: (w) => [...w].length >= 1 && [...w].length <= 100000,
  compare: cpCmp,
  cmp: cpCmp,
  min: "\u0000",
  // At the longest, the next word is the shortest one above it: its last character not already the greatest one
  // up by one (past the surrogates, which are no characters), the characters after it dropped.
  next: (w) => {
    const cs = [...w];
    if (cs.length < 100000) return `${w}\u0000`;
    for (let i = cs.length - 1; i >= 0; i--) {
      let cp = cs[i].codePointAt(0) + 1;
      if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xe000;
      if (cp <= 0x10ffff) return [...cs.slice(0, i), String.fromCodePoint(cp)].join("");
    }
    return null;
  },
};

export function checkPdf(program, header, diagnostics, { discover = false } = {}) {
  // A code W… is a warning: the program compiles all the same.
  const err = (code, node, message, notes) => !discover && (code.startsWith("W") ? diagnostics.warn(KIND.PDF, node?.file ?? null, node?.span ?? null, message, notes ?? [], code) : diagnostics.add(KIND.PDF, node?.file ?? null, node?.span ?? null, message, notes, code));
  const once = new Set();
  const errOnce = (code, key, node, message, notes) => {
    if (once.has(key)) return;
    once.add(key);
    err(code, node, message, notes);
  };
  if (!discover && header.pdf !== program.pdf) err("S501", program.pdfNode ?? null, `the program is written for the PDF ${program.pdf.slice(0, 12)}…, and the header is for ${header.pdf.slice(0, 12)}… (run stride header ${program.form}.pdf again, or change the pdf line)`);
  if (!discover && header.form && header.form !== program.form) err("S502", program.formNode ?? null, `the program is for the form ${program.form}, and the header for ${header.form}`);

  const prefix = program.prefix;
  const byField = new Map();
  for (const b of header.boxes) byField.set(b.field, [...(byField.get(b.field) ?? []), b]);
  const shortNames = [...byField.keys()].map((f) => (f.startsWith(prefix) ? f.slice(prefix.length) : f));
  const keyOf = (b) => (b.kind === "radio" ? `${b.field}\t${b.on}` : b.field);
  const done = new Set(); // box keys written or skipped somewhere
  const boxes = new Map(); // full field name -> { kind, on } for the machine
  const discovered = new Map(); // in discover mode: every box the program writes
  const keys = new Map(); // question key -> { q, printed, node }
  const near = new Map(); // question key -> printed words beside the boxes its answer goes into
  const optionNear = new Map(); // `${key}\t${value}` -> printed words beside the box an option ticks or picks
  const links = new Map(); // `${key}\t${box}` -> { key, box, direct }
  const maxOf = new Map(); // question key -> most length
  const questions = new Set(); // the question templates reached
  // Words gathered once each: a path followed again adds none twice.
  const push = (m, k, words) => {
    const was = m.get(k) ?? [];
    const added = words.filter((w) => !was.includes(w));
    if (added.length || !m.has(k)) m.set(k, [...was, ...added]);
  };

  // ----- running a function on every path

  // The paths out of fn, called with args from the path `entry`: [{ value, state }], each state back in the
  // caller's locals.
  // The calls being followed, innermost last: a mistake inside a function says where it was called from.
  const calls = [];
  const fromCalls = () => calls.slice().reverse().map((c) => ({ file: c.node?.file, span: c.node?.span, message: "called from here" }));
  let current = null; // the statement being followed
  let turnsFollowed = 0; // over the whole check (§15.1)
  // Whether a write stands inside a branch, itself or through the calls that led to it (§10.6).
  const inside = (branch, s) => encloses(branch, s.node) || calls.some((c) => encloses(branch, c?.node));

  // The locals each block may still read (liveness, a backward dataflow over the graph): a value no later
  // statement reads makes no difference to a path, and is dropped before paths are compared.
  const liveness = new Map();
  function liveIn(fn) {
    if (liveness.has(fn)) return liveness.get(fn);
    const reads = (x, out) => {
      if (x.e === "local") out.add(x.l);
      for (const c of IR.children(x)) reads(c, out);
      return out;
    };
    const order = fn.order();
    const gen = new Map();
    const kill = new Map();
    for (const b of order) {
      const g = new Set();
      const k = new Set();
      const stmts = [...b.stmts, ...(b.term ? [b.term] : [])];
      for (const st of stmts) {
        for (const x of IR.expressionsOf(st)) for (const l of reads(x, new Set())) if (!k.has(l)) g.add(l);
        // A store, an append or an answer into a field changes the record or list it holds: it reads it too.
        if (["store", "append"].includes(st.op) || (st.op === "ask" && st.path.length)) if (!k.has(st.dst)) g.add(st.dst);
        if (st.op === "set" || (st.op === "ask" && !st.path.length)) k.add(st.dst);
      }
      gen.set(b, g);
      kill.set(b, k);
    }
    const live = new Map(order.map((b) => [b, new Set()]));
    for (let changed = true; changed; ) {
      changed = false;
      for (const b of [...order].reverse()) {
        const out = new Set();
        for (const n of b.successors) for (const l of live.get(n) ?? []) out.add(l);
        const into = new Set(gen.get(b));
        for (const l of out) if (!kill.get(b).has(l)) into.add(l);
        if (into.size !== live.get(b).size) (live.set(b, into), (changed = true));
      }
    }
    liveness.set(fn, live);
    return live;
  }

  // Blocks in the order paths are followed: a depth-first order that goes into a branch's no last, so a loop's
  // body (its yes) comes before its exit, and every turn has ended before the paths after the loop go on.
  const rankings = new Map();
  function ranks(fn) {
    if (rankings.has(fn)) return rankings.get(fn);
    const seen = new Set(), post = [];
    const visit = (b) => {
      seen.add(b);
      for (const n of [...b.successors].reverse()) if (!seen.has(n)) visit(n);
      post.push(b);
    };
    visit(fn.entry);
    const rank = new Map(post.reverse().map((b, i) => [b, i]));
    rankings.set(fn, rank);
    return rank;
  }

  function analyse(fn, args, entry) {
    const live = liveIn(fn);
    const start = entry.copy();
    start.locals = new Map();
    fn.params.forEach((p, i) => start.locals.set(p, copy(args[i] ?? null)));
    const seen = new Map(); // block -> { paths: signature -> kept path, count: turn -> how many kept }
    const loops = new Map(); // the head of a loop whose turns are not known -> what its body changes, by the rest
    const counters = fn.locals.filter((l) => l.counter);
    // Blocks in the order they come, each taking every path that has arrived before any goes on: paths meeting at a
    // block are taken together once, not sent on again for each that arrives.
    const rank = ranks(fn);
    const arriving = new Map();
    const work = { push: ([b, st]) => (arriving.has(b) ? arriving.get(b).push(st) : arriving.set(b, [st])) };
    work.push([fn.entry, start]);
    const exits = [];
    while (arriving.size) {
      let block = null;
      for (const b of arriving.keys()) if (block === null || (rank.get(b) ?? Infinity) < (rank.get(block) ?? Infinity)) block = b;
      const states = arriving.get(block);
      arriving.delete(block);
      const goes = new Map();
      for (const st of states) {
        const now = admit(block, st);
        if (now) goes.set(now.sig, now);
      }
      for (const state of goes.values()) follow(block, state);
    }
    for (const x of exits) x.state.locals = copyLocals(entry.locals);
    return exits;

    function follow(block, state) {
      // Each path at a loop's head is a turn followed, every visit counted; past the budget the check stops.
      if (block.loopHead && ++turnsFollowed > MAX_TURNS) throw new AnalysisLimit("the PDF check following loop turns", `${MAX_TURNS.toLocaleString("en")} turns`, block.term?.node);
      let paths = [state];
      for (const s of block.stmts) paths = paths.flatMap((st) => statement(fn, s, st));
      for (const st of paths) {
        const t = block.term;
        if (t.op === "jump") work.push([t.to, st]);
        else if (t.op === "branch") {
          for (const [c, st2] of evaluate(fn, t.cond, st)) {
            if (c === true) work.push([t.yes, st2]);
            else if (!isTop(c)) work.push([t.no, st2]);
            else {
              // Each way knows the condition it took (§10.4.1).
              const yes = st2.copy();
              yes.facts = [...st2.facts, { ...condition(fn, t.cond, st2, true), node: t.node }];
              st2.facts = [...st2.facts, { ...condition(fn, t.cond, st2, false), node: t.node }];
              work.push([t.yes, yes]);
              work.push([t.no, st2]);
            }
          }
        } else if (t.op === "return" && t.value) {
          for (const [v, st2] of evaluate(fn, t.value, st)) exits.push({ value: v, state: st2 });
        } else exits.push({ value: null, state: st });
      }
    }

    // A path arriving at a block, or nothing when it adds nothing to a path already kept there (§10.4.0).
    function admit(block, state) {
      const alive = live.get(block);
      if (alive) for (const l of [...state.locals.keys()]) if (!alive.has(l)) state.locals.delete(l);
      if (block.widen) changing(block, state);
      if (!seen.has(block)) seen.set(block, { paths: new Map(), count: new Map() });
      const kept = seen.get(block);
      // Paths are taken together only when every value the rest of the check reads is the same, its type, its
      // list's most, the answers it is made of and what it says of them included.
      const sig = state.sign(fn);
      const same = kept.paths.get(sig);
      if (!same) {
        // Paths kept apart at one point, in one call and one turn of each known loop; past the budget the check
        // stops (§15.1).
        const turn = turnOf(state, counters);
        const n = (kept.count.get(turn) ?? 0) + 1;
        if (n > MAX_PATHS) throw new AnalysisLimit("the PDF check following paths", `${MAX_PATHS.toLocaleString("en")} paths kept apart at one point`, current?.node ?? block.term?.node);
        kept.count.set(turn, n);
        kept.paths.set(sig, state.copy());
        state.sig = sig;
        return state;
      }
      // The same values: what either wrote, asked, skipped and picked is kept with the conditions it was done
      // under, and the path's conditions become the one or the other.
      let grew = false;
      for (const part of ["written", "asked", "skipped"]) {
        const both = same[part].and(state[part]);
        if (both !== same[part]) (same[part] = both), (grew = true);
      }
      for (const [g, list] of state.picks) {
        const was = same.picks.get(g) ?? [];
        const added = list.filter((c) => !was.some((w) => entryKey(w) === entryKey(c)));
        if (added.length) (same.picks.set(g, [...was, ...added]), (grew = true));
      }
      const facts = either(same.facts, state.facts);
      if (facts !== same.facts) (same.facts = facts), (grew = true);
      if (!grew) return null;
      const again = same.copy();
      again.sig = sig;
      return again;
    }

    // The head of a loop whose turns are not known (§10.4.0): a var its body changes keeps its value while every
    // turn gives it the same one; one that differs between turns is undetermined from then on, the answers each
    // turn made it of kept. Zero turns is a path too: the first to come keeps its values.
    function changing(block, state) {
      const changes = new Set(block.widen);
      const rest = fn.locals.filter((l) => !changes.has(l)).map((l) => sign(state.locals.has(l) ? state.locals.get(l) : null)).join("|");
      if (!loops.has(block)) loops.set(block, new Map());
      const byRest = loops.get(block);
      if (!byRest.has(rest)) {
        byRest.set(rest, new Map(block.widen.map((l) => [l, state.locals.has(l) ? copy(state.locals.get(l)) : null])));
        return;
      }
      const values = byRest.get(rest);
      for (const l of block.widen) {
        const was = values.get(l), now = state.locals.has(l) ? state.locals.get(l) : null;
        if (sign(was) === sign(now)) continue;
        if (!(isTop(was) && was.loop === block && [...taints(now)].every((k) => was.from.has(k)) && (mostBound(now) ?? 0) <= (was.most ?? 0))) {
          const most = [mostBound(was), mostBound(now)].filter((m) => m !== undefined);
          const any = new Top(new Set([...taints(was), ...taints(now)]), null, most.length ? { most: Math.max(...most) } : {});
          any.loop = block;
          values.set(l, any);
        }
        state.locals.set(l, values.get(l));
      }
    }
  }

  // Two paths' conditions taken together (§10.4.0): the one path's or the other's, kept as the alternatives
  // themselves, each the conditions one way took. The conditions every alternative took stay as they are; the rest
  // become one condition, any of the alternatives. An alternative already there, or one that says all another does
  // and more, adds nothing, so paths meeting again and again come to rest.
  function either(a, b) {
    const kept = fewest([...alternatives(a), ...alternatives(b)]);
    const keys = kept.map((w) => w.map(factKey).sort().join("\n")).sort().join("\n\n");
    if (keys === waysKey(a)) return a;
    const shared = kept[0].filter((f) => kept.every((w) => w.some((g) => factKey(g) === factKey(f))));
    const sharedKeys = new Set(shared.map(factKey));
    const rests = kept.map((w) => w.filter((f) => !sharedKeys.has(factKey(f))));
    let out;
    if (rests.some((r) => !r.length)) out = shared;
    else {
      const all = (fs) => fs.map((f) => (f.truth ? f.f : { k: "not", a: f.f })).reduce((x, y) => ({ k: "and", a: x, b: y }));
      const any = rests.map(all).reduce((x, y) => ({ k: "or", a: x, b: y }));
      const from = new Set(rests.flat().flatMap((f) => [...(f.from ?? [])]));
      out = [...shared, { f: any, truth: true, from, node: null, ways: rests }];
    }
    waysKeys.set(out, keys);
    return out;
  }
  // The alternatives with nothing said twice and exactly as much said: one that holds every condition another
  // holds, and more, says no more than that other; two that differ only in one condition, yes in one and no in the
  // other, are the one without it.
  function fewest(ways) {
    let keyed = ways.map((w) => ({ w, k: new Set(w.map(factKey)) }));
    for (let changed = true; changed; ) {
      changed = false;
      const out = keyed.filter((x, i) => !keyed.some((y, j) => j !== i && y.k.size <= x.k.size && [...y.k].every((k) => x.k.has(k)) && (y.k.size < x.k.size || j < i)));
      if (out.length !== keyed.length) (keyed = out), (changed = true);
      for (let i = 0; i < keyed.length && !changed; i++) {
        for (let j = i + 1; j < keyed.length && !changed; j++) {
          const [x, y] = [keyed[i], keyed[j]];
          if (x.w.length !== y.w.length) continue;
          const onlyX = x.w.filter((f) => !y.k.has(factKey(f)));
          if (onlyX.length !== 1) continue;
          const onlyY = y.w.filter((f) => !x.k.has(factKey(f)));
          if (onlyY.length === 1 && formulaKey(onlyX[0].f) === formulaKey(onlyY[0].f) && onlyX[0].truth !== onlyY[0].truth) {
            const w = x.w.filter((f) => f !== onlyX[0]);
            keyed = [...keyed.slice(0, i), { w, k: new Set(w.map(factKey)) }, ...keyed.slice(i + 1, j), ...keyed.slice(j + 1)];
            changed = true;
          }
        }
      }
    }
    return keyed.map((x) => x.w);
  }

  // A path's conditions as the alternatives they are: one, or each a joined condition holds.
  function alternatives(fs) {
    const join = fs.find((f) => f.ways);
    if (!join) return [fs];
    const rest = fs.filter((f) => f !== join);
    return join.ways.map((w) => [...rest, ...w]);
  }
  const waysKeys = new WeakMap();
  function waysKey(fs) {
    if (!waysKeys.has(fs)) waysKeys.set(fs, alternatives(fs).map((w) => w.map(factKey).sort().join("\n")).sort().join("\n\n"));
    return waysKeys.get(fs);
  }

  // ----- statements

  // The paths out of one statement.
  function statement(fn, s, state) {
    current = s;
    switch (s.op) {
      case "set":
        return evaluate(fn, s.value, state).map(([v, st]) => (st.locals.set(s.dst, v), st));
      case "store":
        // The positions first, each into its temporary when it has one (§7.5.1), then the value.
        for (const p of s.path) if (p.into) state.locals.set(p.into, evaluate(fn, p.index, state)[0][0]);
        return evaluate(fn, s.value, state).map(([v, st]) => {
          place(st, s.dst, s.path, v, fn);
          return st;
        });
      case "append":
        return evaluate(fn, s.value, state).map(([v, st]) => {
          const list = st.locals.get(s.dst);
          if (Array.isArray(list)) list.push(v);
          else st.locals.set(s.dst, top(list, v));
          return st;
        });
      case "eval":
        return evaluate(fn, s.value, state).map(([, st]) => st);
      case "check":
        return [state];
      case "ask":
        return ask(fn, s, state);
      case "skip":
        return evaluate(fn, s.box, state).map(([name, st]) => {
          const full = boxName(s, name);
          if (full === null) return st;
          if (discover) {
            discovered.set(full, { field: full, kind: "text" });
            return st;
          }
          const found = byField.get(full);
          if (!found) errOnce("S503", `skip\t${full}`, s.node?.box ?? s.node, `skips "${full.slice(prefix.length)}", which the PDF does not have${didYouMean(full.slice(prefix.length), shortNames)}`);
          else {
            for (const b of found) done.add(keyOf(b));
            // A box written and skipped on one path (§10.4): W008 at the later; skips again are harmless.
            const k = targetOf(found[0], full);
            const picked = (st.picks.get(k) ?? []).find((c) => together([c, ...c.facts, ...st.facts]));
            const w = under(st.written.get(k), st);
            if (w) twice(s, k, full, w, "skipped after it is written");
            else if (picked) twice(s, k, full, picked.stmt, "skipped after it is picked");
            // The skip keeps what its path knew, for a pick after it (§10.4.3).
            else if (!under(st.skipped.get(k), st)) st.skipped = st.skipped.with(k, [{ node: s.node, stmt: s, facts: st.facts }]);
          }
          return st;
        });
      case "fill":
      case "tick":
      case "pick":
        return write(fn, s, state);
      case "expect": {
        // Follow its calls against the test file's empty header (§4.3), then drop its sub-run's effects (§7.17.1).
        // A later expectation may ask the same question again.
        for (const [, st] of evaluate(fn, s.value, state.copy())) {
          if (s.message) evaluate(fn, s.message, st);
        }
        return [state];
      }
      default:
        throw new Error(`cannot analyse ${s.op}`);
    }
  }

  function boxName(s, name) {
    if (isTop(name) || typeof name !== "string") {
      errOnce("S403", `name\t${s.node?.span?.start}`, s.node, "the PDF check cannot tell which box this is: its name depends on an answer, or working it out faults; it must be known before the form opens");
      return null;
    }
    return prefix + name;
  }

  function ask(fn, s, state) {
    const out = [];
    for (const [key, st1] of evaluate(fn, s.key, state)) {
      for (const [printed, st] of evaluate(fn, s.printed, st1)) {
        questions.add(s.q);
        out.push(st);
        if (isTop(key)) {
          errOnce("S403", `key\t${s.node?.span?.start}`, s.node, "this question's key depends on an answer; it must be known before the form opens");
          continue;
        }
        if (isTop(printed)) errOnce("S403", `printed\t${s.node?.span?.start}`, s.node, "this question's printed words depend on an answer; they must be known before the form opens");
        const first = under(st.asked.get(key), st);
        if (first) {
          errOnce("S507", `asked\t${key}\t${s.node?.span?.start}`, s.node, `the question ${key} is asked twice when the form is filled one way`, [{ file: first.node?.file, span: first.node?.span, message: "asked here first" }, ...fromCalls()]);
        } else st.asked = st.asked.with(key, [{ node: s.node, stmt: s, facts: st.facts }]);
        if (!keys.has(key)) keys.set(key, { q: s.q, printed: isTop(printed) ? "" : textOf(printed), node: s.node });
        const value = new Top(new Set([key]), key);
        if (!s.path.length) st.locals.set(s.dst, value);
        else place(st, s.dst, s.path, value, fn);
      }
    }
    return out;
  }

  // A value put at a path inside a local's record or list.
  // Records are made on the way where a place holds empty (§7.5.1), as the run makes them, so a field set there
  // holds its value (an answer, unknown) and is not read back as empty.
  function place(state, dst, path, value, fn) {
    const index = (e) => evaluate(fn, e, state)[0][0];
    const made = (decl) => V.emptyRecord(decl.name, decl.fields.map((f) => (f.type?.t === "list" && Number.isFinite(f.type.most) ? f.type.most : null)), decl.fields.map((f) => f.name));
    let target = state.locals.get(dst) ?? null;
    if (path[0]?.field !== undefined && V.isEmpty(target) && path[0].ensure) state.locals.set(dst, (target = made(path[0].ensure)));
    for (let k = 0; k < path.length - 1; k++) {
      const p = path[k], next = path[k + 1];
      if (p.field !== undefined) {
        if (!(target instanceof StrideRecord)) return;
        if (V.isEmpty(target.fields[p.field]) && next.field !== undefined && p.ensureNext) target.fields[p.field] = made(p.ensureNext);
        target = target.fields[p.field];
      } else {
        const i = V.whole(index(p.index));
        if (!Array.isArray(target) || i === null || i < 1) return;
        if (V.isEmpty(target[i - 1]) && i <= target.length && next.field !== undefined && p.ensureNext) target[i - 1] = made(p.ensureNext);
        target = target[i - 1] ?? null;
      }
    }
    const last = path[path.length - 1];
    if (last.field !== undefined) {
      if (target instanceof StrideRecord) target.fields[last.field] = value;
    } else {
      const i = index(last.index);
      if (Array.isArray(target) && V.whole(i) !== null && V.whole(i) >= 1) target[V.whole(i) - 1] = value;
    }
  }

  function write(fn, s, state) {
    const out = [];
    const valueExpr = s.op === "fill" ? s.value : s.cond;
    for (const [name, st1] of evaluate(fn, s.box, state)) {
      const button = s.op === "pick" ? evaluate(fn, s.button, st1)[0][0] : null;
      for (const [value, st] of evaluate(fn, valueExpr, st1)) {
        out.push(st);
        const full = boxName(s, name);
        if (full === null) continue;
        if (discover) {
          discovered.set(s.op === "pick" ? `${full}\t${button}` : full, s.op === "pick" ? { field: full, kind: "radio", on: button } : s.op === "tick" ? { field: full, kind: "check", on: "Yes" } : { field: full, kind: "text" });
          boxes.set(full, { kind: s.op, on: s.op === "tick" ? "Yes" : null });
          continue;
        }
        const found = byField.get(full);
        const short = full.slice(prefix.length);
        if (!found) {
          errOnce("S508", `nobox\t${full}\t${s.node?.span?.start}`, s.node?.box ?? s.node, program.script ? `a script has no form, so it has no box "${short}" to write; start the file with form and pdf lines to fill a form (§4.6)` : `the PDF has no box "${short}"${didYouMean(short, shortNames)}`);
          continue;
        }
        const first = found[0];
        const kinds = { fill: ["text", "choice"], tick: ["check"], pick: ["radio"] };
        if (!kinds[s.op].includes(first.kind)) {
          const how = { text: "fill", choice: "fill", check: "tick", radio: "pick" }[first.kind];
          errOnce("S509", `kind\t${full}\t${s.node?.span?.start}`, s.node, `"${short}" is a ${first.kind === "check" ? "check box" : first.kind === "radio" ? "radio group" : `${first.kind} box`}; ${s.op} cannot write it (${how} does)`);
          for (const x of found) done.add(keyOf(x)); // one mistake, not a second for the box never written
          continue;
        }
        let box = first;
        if (s.op === "pick") {
          if (isTop(button)) {
            errOnce("S403", `button\t${s.node?.span?.start}`, s.node, "this button's name depends on an answer; it must be known before the form opens");
            continue;
          }
          box = found.find((b) => b.on === button);
          if (!box) {
            errOnce("S511", `button\t${full}\t${button}`, s.node?.button ?? s.node, `the radio group "${short}" has no button "${button}"; it has ${found.map((b) => `"${b.on}"`).join(", ")}`);
            continue;
          }
        }
        const k = keyOf(box);
        if (s.op === "tick") for (const x of found) done.add(keyOf(x));
        else done.add(k);
        // What one path writes (§10.4): fill and tick always; a pick only when its condition is yes. A pick whose
        // condition depends on an answer splits the path: on one it is picked, the answer taken to be what makes it
        // so, on the other not. Two picks in one radio group on one path are W008, whatever their buttons.
        const target = targetOf(box, full);
        if (s.op !== "fill") {
          // The options that tick or pick it: those its condition tests, through lets too, and, when the condition
          // is yes on this path, those the branches taken to reach it chose (if o == "a", a match arm) (§10.6).
          const conds = [condition(fn, s.cond, st, true), ...(value === true ? st.facts.filter((f) => inside(f.node, s)) : [])];
          const tested = [...optionTests(fn, s.cond, st), ...conds.flatMap((c) => chosenOptions(c.f, c.truth))];
          for (const [key, v] of new Map(tested.map(([key, v]) => [`${key}\t${v}`, [key, v]])).values()) push(optionNear, `${key}\t${v}`, box.near ?? []);
        }
        if (s.op === "pick") {
          // A pick selects only when its condition is yes (§10.4.1): one known to be no selects nothing; two in
          // one group are W008 only when both can be yes on one run, with what each path knew (§10.4.2).
          if (value !== true && !isTop(value)) continue;
          const now = { ...condition(fn, s.cond, st, true), stmt: s, facts: st.facts };
          const before = st.picks.get(target) ?? [];
          const clash = before.find((c) => together([c, ...c.facts, now, ...st.facts]));
          if (clash) twice(s, target, full, clash.stmt, "picked again in its radio group", `"${full.slice(prefix.length)}" may be picked again in its radio group: the check cannot show this pick and the first exclude each other (§10.4.1); put each in its own branch of one if … else or match`);
          else {
            const sk = (st.skipped.get(target) ?? []).find((e) => together([now, ...st.facts, ...e.facts]));
            if (sk) twice(s, target, full, sk, "picked after it is skipped");
          }
          st.picks.set(target, [...before, now]);
        } else {
          const w = under(st.written.get(target), st), sk = under(st.skipped.get(target), st);
          if (w) twice(s, target, full, w, "written twice");
          else if (sk) twice(s, target, full, sk, "written after it is skipped");
          else st.written = st.written.with(target, [{ node: s.node, stmt: s, facts: st.facts }]);
        }
        boxes.set(full, { kind: s.op, on: s.op === "tick" ? box.on ?? "Yes" : null});
        // What the box says about the questions whose answers go into it.
        const words = found.flatMap((x) => x.near ?? []);
        // The answers that go into it: those its value or condition is made of and, for a tick or pick whose
        // condition is yes on this path, those of the branches taken to reach it (§10.6).
        const into = new Set(taints(value));
        const around = s.op !== "fill" && value === true ? st.facts.filter((f) => inside(f.node, s)) : [];
        for (const f of around) for (const k of f.from ?? []) into.add(k);
        for (const key of into) {
          push(near, key, s.op === "pick" ? box.near ?? [] : words);
          link(key, full, false);
        }
        if (s.op === "fill" && isTop(value) && value.direct && value.from.size === 1) {
          link(value.direct, full, true);
          if (box.max) maxOf.set(value.direct, Math.min(maxOf.get(value.direct) ?? Infinity, box.max));
        }
        // A known value by its words (§3.5): a number or a date too.
        const entryWords = known(value) && !V.isEmpty(value) ? textOf(value) : "";
        if (s.op === "fill" && first.kind === "choice" && entryWords !== "" && first.options && !first.options.includes(entryWords)) errOnce("S514", `choice\t${full}\t${entryWords}`, s.node?.value ?? s.node, `the list box "${short}" has no entry "${entryWords}"`);
        // A choice box takes empty, or words the check proves are all its entries on this path (§10.3): each
        // answer the value is made of takes each value it can have here (a one-of's options and empty; any other
        // answer only what the path's conditions name), and the value is worked out for each. Words it knows are
        // not entries are S514; words it cannot tell beforehand go in as they are.
        if (s.op === "fill" && first.kind === "choice" && first.options && isTop(value)) {
          const proof = possibleWords(fn, valueExpr, st, value);
          for (const [w, why] of proof.words) if (!first.options.includes(w)) errOnce("S514", `choice\t${full}\t${w}`, s.node?.value ?? s.node, `the list box "${short}" has no entry "${w}", which it gets when ${why}`);
        }
      }
    }
    return out;
  }

  // The words a value not known before the form opens can give on this path (§10.3): { words: [[w, why]], unknown }
  // with `unknown` saying why some cannot be known. Each answer it is made of takes, one combination after another,
  // each value this path allows it, and the value is worked out again from the program's locals with them.
  const MAX_COMBINATIONS = 4096; // beyond it the check stops: S602 (§15.1), never a silent pass
  function possibleWords(fn, x, st, value) {
    const choices = [];
    for (const key of taints(value)) {
      const q = keys.get(key)?.q;
      let values;
      if (q?.type === "one-of") values = [...q.options.map((o) => o.value), null];
      else if (q?.type === "yes-no") values = [true, false, null];
      else if (q?.type === "any-of") {
        // Every set of its options the path allows, empty among them (§10.3), each option in or out by the facts.
        const options = q.options.map((o) => o.value);
        if (2 ** options.length > MAX_COMBINATIONS) throw new AnalysisLimit("the PDF check proving a choice box's words", `${MAX_COMBINATIONS.toLocaleString("en")} combinations of answer values`, x.node ?? current?.node);
        const sets = [];
        for (let m = 0; m < 2 ** options.length; m++) {
          const chosen = options.filter((_, i) => m & (2 ** i));
          const says = options.map((o) => ({ f: { k: "lit", key, op: "has", c: o }, truth: chosen.includes(o) }));
          if (!chosen.length) says.push({ f: { k: "lit", key, op: "==", c: null }, truth: true });
          if (together([...st.facts, ...says])) sets.push(chosen.length ? V.set(chosen, options) : null);
        }
        choices.push([key, sets]);
        continue;
      } else {
        // What the path's conditions say the answer is, or nothing when they leave it free.
        let named = null;
        for (const f of st.facts) named = meetDomains(named, allowedBy(f.f, f.truth, key));
        if (!named) return { words: [], unknown: `${key} can be any ${q?.type === "number" ? "number" : q?.type === "date" ? "date" : "words"} here` };
        values = [...named.values()];
      }
      choices.push([key, values.filter((c) => together([...st.facts, { f: { k: "lit", key, op: "==", c }, truth: true }]))]);
    }
    if (!choices.length) return { words: [], unknown: "it is worked out when the form is filled" };
    if (choices.reduce((n, [, v]) => n * Math.max(1, v.length), 1) > MAX_COMBINATIONS) throw new AnalysisLimit("the PDF check proving a choice box's words", `${MAX_COMBINATIONS.toLocaleString("en")} combinations of answer values`, x.node ?? current?.node);
    const words = [];
    const walk = (k, pinned) => {
      if (k === choices.length) {
        const done = new Map();
        // An unknown made from the answers is made again from what it was made of (a let or var keeps it so).
        const sub = (v) => {
          if (isTop(v)) {
            if (v.direct && pinned.has(v.direct)) return pinned.get(v.direct);
            if (!v.recipe) return v;
            if (!done.has(v)) done.set(v, v.recipe.fn ? pureCall(v.recipe.fn, v.recipe.args.map(sub)) : applyOnce(v.recipe.x, v.recipe.vals.map(sub)));
            return done.get(v);
          }
          return v instanceof StrideRecord ? new StrideRecord(v.type, v.fields.map(sub), v.names) : Array.isArray(v) && !V.isSet(v) ? V.list(v.map(sub), V.mostOf(v)) : v;
        };
        const at = new State(new Map([...st.locals].map(([l, v]) => [l, sub(v)])));
        for (const [w] of evaluate(fn, x, at)) {
          if (!known(w)) return "it is not worked out from the answers alone";
          const t = V.isEmpty(w) ? "" : textOf(w);
          if (t !== "") words.push([t, [...pinned].map(([key, c]) => `${key} is ${c === null ? "empty" : `"${V.words(c)}"`}`).join(" and ")]);
        }
        return null;
      }
      const [key, values] = choices[k];
      for (const c of values) {
        const bad = walk(k + 1, new Map([...pinned, [key, c]]));
        if (bad) return bad;
      }
      return null;
    };
    const bad = walk(0, new Map());
    return bad ? { words: [], unknown: bad } : { words };
  }
  // The values a condition taken yes or no allows one answer, as a Map (its encoding -> value), or null when it
  // leaves the answer free: key == c yes, key != c no, key in [...] yes; an and taken yes allows what both sides
  // allow, an or taken yes what either side does, each only when it is restricted (§10.3).
  const meetDomains = (a, b) => (a === null ? b : b === null ? a : new Map([...a].filter(([k]) => b.has(k))));
  const joinDomains = (a, b) => (a === null || b === null ? null : new Map([...a, ...b]));
  // Each part of a formula worked out once per answer, however many formulas share it.
  const allowedOnce = new WeakMap();
  function allowedBy(f, truth, key) {
    if (!allowedOnce.has(f)) allowedOnce.set(f, new Map());
    const memo = allowedOnce.get(f), k = `${truth}\t${key}`;
    if (!memo.has(k)) memo.set(k, allowedFresh(f, truth, key));
    return memo.get(k);
  }
  function allowedFresh(f, truth, key) {
    switch (f.k) {
      case "not":
        return allowedBy(f.a, !truth, key);
      case "and":
        return truth ? meetDomains(allowedBy(f.a, true, key), allowedBy(f.b, true, key)) : joinDomains(allowedBy(f.a, false, key), allowedBy(f.b, false, key));
      case "or":
        return truth ? joinDomains(allowedBy(f.a, true, key), allowedBy(f.b, true, key)) : meetDomains(allowedBy(f.a, false, key), allowedBy(f.b, false, key));
      case "lit":
        if (f.key !== key) return null;
        if ((f.op === "==" && truth) || (f.op === "!=" && !truth)) return new Map([[V.encode(f.c), f.c]]);
        if (f.op === "in" && truth && Array.isArray(f.c)) return new Map(f.c.map((c) => [V.encode(c), c]));
        return null;
      case "const":
        return f.v === truth ? null : new Map(); // a condition that cannot hold allows nothing
      default:
        return null;
    }
  }

  // What a write or a skip of a box takes up on a path: a radio group as one, any other box by its name.
  function targetOf(box, full) {
    return box.kind === "radio" ? `radio\t${full}` : full;
  }

  function twice(s, target, full, first, how, message = null) {
    const short = full.slice(prefix.length);
    errOnce("W008", `twice\t${target}\t${s.node?.span?.start}`, s.node, message ?? `"${short}" is ${how} when the form is filled one way`, [{ file: first.node?.file, span: first.node?.span, message: "first here" }, ...fromCalls()]);
  }

  // ----- conditions on answers (§10.4.1)

  // The first of a box's or a question's entries that can have been done on the run this path is: one done earlier
  // on the same path at once, else one whose conditions can hold with the path's (§10.4.0).
  function under(entries, st) {
    if (!entries) return undefined;
    return entries.find((e) => e.facts.every((f, i) => st.facts[i] === f)) ?? entries.find((e) => together([...e.facts, ...st.facts]));
  }

  // A condition taken as `truth` on a path: what it says of the answers.
  function condition(fn, x, st, truth) {
    const v = evaluate(fn, x, new State(st.locals))[0]?.[0];
    return { f: predOf(v), truth, from: taints(v) };
  }

  // Whether every condition can hold on one run. Each unknown (a comparison of an answer with a known value, or
  // one the check cannot read) is taken yes, then no, one after another; a combination is given up as soon as a
  // condition is decided against it or an answer's comparisons can no longer be met by one value. The search
  // always ends, with an answer, or stops at its budget with S602 (§15.1): never "not together" for want of work.
  function together(all) {
    let work = 0;
    const step = () => {
      if (++work > MAX_PROOF) throw new AnalysisLimit("the PDF check proving conditions exclude each other", `${MAX_PROOF.toLocaleString("en")} steps of one proof`, current?.node);
    };
    const idOf = (f) => (f.k === "lit" ? `${f.key}\t${f.op}\t${typeof f.c}\t${Array.isArray(f.c) ? JSON.stringify(f.c) : V.words(f.c)}` : f.id);
    // The same condition once; then the conditions in groups that share no unknown and no answer: each group can
    // hold or not whatever the others do, so each is searched on its own.
    const conds = [...new Map(all.map((c) => [factKey(c), c])).values()];
    const atomsOf = conds.map((c) => {
      const atoms = new Map(), visited = new Set();
      const collect = (f) => {
        if (visited.has(f)) return;
        visited.add(f);
        step();
        if (f.k === "lit" || f.k === "opaque") atoms.set(idOf(f), f);
        else if (f.a) (collect(f.a), f.b && collect(f.b));
      };
      collect(c.f);
      return atoms;
    });
    const parent = conds.map((_, i) => i);
    const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
    const owner = new Map();
    atomsOf.forEach((atoms, i) => {
      for (const [id, f] of atoms) {
        for (const k of [`a\t${id}`, ...(f.k === "lit" ? [`k\t${f.key}`] : [])]) {
          if (owner.has(k)) parent[root(i)] = root(owner.get(k));
          else owner.set(k, i);
        }
      }
    });
    const groups = new Map();
    conds.forEach((_, i) => groups.set(root(i), [...(groups.get(root(i)) ?? []), i]));
    for (const members of groups.values()) {
      const atoms = new Map();
      for (const i of members) for (const [id, f] of atomsOf[i]) atoms.set(id, f);
      if (!satisfiable(members.map((i) => conds[i]), [...atoms.entries()], step, idOf)) return false;
    }
    return true;
  }

  // Whether conditions sharing their unknowns can all hold: each unknown taken yes, then no, one after another; a
  // combination is given up as soon as a condition is decided against it or an answer's comparisons can no longer
  // be met by one value. Each part of a condition is worked out once for each choice made.
  function satisfiable(conds, list, step, idOf) {
    const truth = new Map();
    let memo = new Map();
    // yes, no, or undefined while not yet decided
    const holds = (f) => {
      if (memo.has(f)) return memo.get(f);
      step();
      let r;
      switch (f.k) {
        case "const":
          r = f.v;
          break;
        case "lit":
        case "opaque":
          r = truth.get(idOf(f));
          break;
        case "not": {
          const a = holds(f.a);
          r = a === undefined ? undefined : !a;
          break;
        }
        case "and": {
          const a = holds(f.a), b = holds(f.b);
          r = a === false || b === false ? false : a === true && b === true ? true : undefined;
          break;
        }
        default: {
          const a = holds(f.a), b = holds(f.b);
          r = a === true || b === true ? true : a === false && b === false ? false : undefined;
        }
      }
      memo.set(f, r);
      return r;
    };
    const search = (i) => {
      step();
      memo = new Map();
      const now = conds.map((c) => holds(c.f));
      if (conds.some((c, k) => now[k] !== undefined && now[k] !== c.truth)) return false;
      if (!meetable(list.filter(([id]) => truth.has(id)).map(([id, f]) => [f, truth.get(id)]))) return false;
      if (now.every((v, k) => v === conds[k].truth)) return true;
      if (i === list.length) return false;
      for (const t of [true, false]) {
        truth.set(list[i][0], t);
        if (search(i + 1)) return true;
      }
      truth.delete(list[i][0]);
      return false;
    };
    return search(0);
  }

  // Whether each answer the decided comparisons speak of can be one value meeting them all: empty, or one of the
  // values its question can give (§8.7) — an option of its set, yes or no, a day from 0001-01-01 to 9999-12-31, a
  // number of at most 34 digits below 10^34 in size, words of at most 100,000 characters. Neither numbers nor words
  // are taken as dense: the value next after a bound is worked out exactly.
  function meetable(decided) {
    const by = new Map();
    for (const [f, t] of decided) if (f.k === "lit") by.set(f.key, [...(by.get(f.key) ?? []), [f, t]]);
    for (const [key, lits] of by) if (!oneValue(lits, domainOf(key, lits))) return false;
    return true;
  }

  // The values an answer can be, from its question; by the values compared with when the question is not known.
  function domainOf(key, lits) {
    const q = keys.get(key)?.q;
    if (q?.type === "one-of") return { kind: "list", values: q.options.map((o) => o.value), compare: cpCmp };
    // An any-of answer compared with a set or list of options (`s == ["a"]`): every set of its options is tried.
    if (q?.type === "any-of" && lits.some(([f]) => Array.isArray(f.c))) return { kind: "sets", options: q.options.map((o) => o.value) };
    const c = lits.map(([f]) => (f.op === "in" ? f.c.find((m) => m !== null) : f.c)).find((x) => x !== null && x !== undefined);
    if (q?.type === "yes-no" || typeof c === "boolean") return { kind: "list", values: [true, false], compare: (a, b) => (a === b ? 0 : a ? 1 : -1) };
    if (q?.type === "date" || V.isDate(c)) return DATES;
    if (q?.type === "number" || V.isNumber(c)) return NUMBERS;
    return WORDS;
  }

  function oneValue(all, domain) {
    if (domain.kind === "sets") return someSet(all, domain.options);
    // Comparisons with empty itself (`n == empty`, `n is empty`): == yes (or != no) asks for empty, == no (or != yes)
    // for a value; an order with empty is never yes (§6.6, §6.7).
    let wantEmpty = false, wantValue = false;
    for (const [f, t] of all) {
      if (f.c !== null) continue;
      if (f.op === "==" || f.op === "!=") (f.op === "==") === t ? (wantEmpty = true) : (wantValue = true);
      else if (t) return false;
    }
    if (wantEmpty && wantValue) return false;
    // An any-of answer's options (`"a" in s`): each yes or no on its own, every one no when it is empty (§10.4.1).
    const has = all.filter(([f]) => f.op === "has");
    if (has.length) {
      if (wantEmpty && has.some(([, t]) => t)) return false;
      if (has.length === all.filter(([f]) => f.c !== null).length) return true;
    }
    const lits = all.filter(([f]) => f.c !== null && f.op !== "has");
    // Empty meets: every order and == taken as no, every != as yes.
    if (!wantValue && lits.every(([f, t]) => (f.op === "!=" ? t : !t))) return true;
    if (wantEmpty) return false;
    // A value, not empty: each comparison as it is taken.
    const meets = (v) =>
      lits.every(([f, t]) => {
        if (f.op === "in") return f.c.some((m) => m !== null && domain.compare(v, m) === 0) === t;
        const k = domain.compare(v, f.c);
        const r = { "<": k < 0, "<=": k <= 0, ">": k > 0, ">=": k >= 0, "==": k === 0, "!=": k !== 0 }[f.op];
        return r === t;
      });
    if (domain.kind === "list") return domain.values.some(meets);
    // Among listed values: one of them, as its kind allows; not among them: each is left out.
    const among = lits.filter(([f, t]) => f.op === "in" && t);
    if (among.length) return among[0][0].c.filter((m) => m !== null).some((m) => domain.valid(m) && meets(m));
    // An ordered domain: from the lowest value the comparisons allow, step past each value left out.
    let lo = null, hi = null;
    const out = [];
    for (const [f, t] of lits) {
      const op = t ? f.op : { "<": ">=", "<=": ">", ">": "<=", ">=": "<", "==": "!=", "!=": "==" }[f.op];
      if (f.op === "in") {
        for (const m of f.c) if (m !== null) out.push(domain.inside(m));
        continue;
      }
      const c = domain.inside(f.c);
      if (op === "==") return meets(f.c) && domain.valid(f.c);
      if (op === "!=") out.push(c);
      else if (op === ">" || op === ">=") {
        const at = op === ">" ? domain.next(c) : c;
        if (at === null) return false;
        if (!lo || domain.cmp(at, lo) > 0) lo = at;
      } else if (!hi || domain.cmp(c, hi.c) < 0 || (domain.cmp(c, hi.c) === 0 && op === "<")) hi = { c, strict: op === "<" };
    }
    let v = lo ?? domain.min;
    const above = (x) => hi !== null && (domain.cmp(x, hi.c) > 0 || (hi.strict && domain.cmp(x, hi.c) === 0));
    for (let i = 0; i <= out.length; i++) {
      if (v === null || above(v)) return false;
      if (!out.some((c) => domain.cmp(c, v) === 0)) return true;
      v = domain.next(v);
    }
    return false;
  }

  // Whether one set of an any-of answer's options, empty among them, meets every comparison as the machine works it
  // out (§6.6, §6.8). The sets tried count toward the proof's budget (§15.1).
  function someSet(all, options) {
    if (2 ** options.length > MAX_PROOF) throw new AnalysisLimit("the PDF check proving conditions exclude each other", `${MAX_PROOF.toLocaleString("en")} steps of one proof`, current?.node);
    const holds = (f, v) => {
      try {
        return (f.op === "has" ? op2("in", f.c, v) : op2(f.op, v, f.c)) === true;
      } catch {
        return false; // a comparison that faults is not yes
      }
    };
    for (let m = 0; m < 2 ** options.length; m++) {
      const chosen = options.filter((_, i) => m & (2 ** i));
      const v = chosen.length ? V.set(chosen, options) : null;
      if (all.every(([f, t]) => holds(f, v) === t)) return true;
    }
    return false;
  }

  function link(key, box, direct) {
    const k = `${key}\t${box}`;
    const was = links.get(k);
    if (was) was.direct ||= direct;
    else links.set(k, { key, box, direct });
  }

  // Option values a condition tests as the one that ticks or picks: "sign" in acts, kind == "individual". Not
  // `!=`: the option it names is the one that leaves the box as it is (§10.6).
  function optionTests(fn, x, state, out = []) {
    if (x.e === "binary" && ["in", "=="].includes(x.op)) {
      const [lit, other] = IR.isConst(x.a) ? [x.a, x.b] : IR.isConst(x.b) ? [x.b, x.a] : [null, null];
      if (lit && typeof lit.v === "string" && !IR.children(other).some((c) => c.e === "call")) {
        for (const [v] of evaluate(fn, other, state.copy())) if (isTop(v) && v.direct) out.push([v.direct, lit.v]);
      }
    }
    for (const c of IR.children(x)) optionTests(fn, c, state, out);
    return out;
  }

  // The option values a condition, taken yes or no, says the answer may be: kind == "a" taken yes, kind != "a"
  // taken no, each side of an and or of an or taken yes (a match arm of several values is their or). Not what it
  // says the answer is not (§10.6).
  function chosenOptions(f, truth, out = []) {
    if (f.k === "not") return chosenOptions(f.a, !truth, out);
    if ((f.k === "and" || f.k === "or") && truth) (chosenOptions(f.a, true, out), chosenOptions(f.b, true, out));
    if (f.k === "or" && !truth) (chosenOptions(f.a, false, out), chosenOptions(f.b, false, out));
    if (f.k === "lit" && ((f.op === "==" && truth) || (f.op === "!=" && !truth)) && typeof f.c === "string") out.push([f.key, f.c]);
    if (f.k === "lit" && f.op === "in" && truth && Array.isArray(f.c)) for (const c of f.c) if (typeof c === "string") out.push([f.key, c]);
    return out;
  }

  // ----- expressions: [value, state] for each path (a call to a function with effects may give several)

  function evaluate(fn, x, state) {
    switch (x.e) {
      case "const":
        return [[copy(x.v), state]];
      case "local":
        return [[state.locals.has(x.l) ? state.locals.get(x.l) : null, state]];
      case "call": {
        const paths = [];
        for (const [args, st] of evaluateAll(fn, x.args, state)) {
          if (x.fn.pure) {
            paths.push([pureCall(x.fn, args, x.at), st]);
            continue;
          }
          const at = current;
          calls.push(at);
          // A call with effects gives an unknown of its own each time (§10.4.1): never one fact with another call.
          for (const exit of analyse(x.fn, args, st)) paths.push([isTop(exit.value) ? fresh(exit.value) : exit.value, exit.state]);
          calls.pop();
          current = at;
        }
        return paths;
      }
      case "native":
        if (x.name === "fail") {
          // Its arguments are reached, but no statement after the call is (§13.4). An expectation catches the
          // fault at its own boundary; its caller still continues with the next expectation.
          evaluateAll(fn, x.args, state);
          return [];
        }
        return applyAll(fn, x, state);
      case "cond": {
        // Only the branch taken, on each path; both when the condition is not known, each knowing the condition it
        // took, as a branch's way does (§10.3): `if t == "a" then t else empty` gives "a" or empty.
        const paths = [];
        for (const [c, st] of evaluate(fn, x.cond, state)) {
          if (c === true) paths.push(...evaluate(fn, x.yes, st));
          else if (known(c)) paths.push(...evaluate(fn, x.no, st));
          else {
            const yes = forkState(st), no = forkState(st);
            yes.facts = [...st.facts, { ...condition(fn, x.cond, st, true), node: null }];
            no.facts = [...st.facts, { ...condition(fn, x.cond, st, false), node: null }];
            paths.push(...evaluate(fn, x.yes, yes), ...evaluate(fn, x.no, no));
          }
        }
        return paths;
      }
      case "binary":
        if (x.op === "and" || x.op === "or") {
          // Decided on the left when it can be: the right is then not worked out (§6.2).
          const paths = [];
          for (const [a, st] of evaluate(fn, x.a, state)) {
            if (x.op === "and" && known(a) && a !== true) paths.push([false, st]);
            else if (x.op === "or" && a === true) paths.push([true, st]);
            else for (const [b, st2] of evaluate(fn, x.b, st)) paths.push([known(a) && known(b) ? b === true : Object.assign(withPred(top(a, b), { k: x.op, a: predOf(a), b: predOf(b) }), { sig: intern(`${x.op}(${sigOf(a)},${sigOf(b)})`) }), st2]);
          }
          return paths;
        }
        return applyAll(fn, x, state);
      case "comp": {
        // A comprehension makes a value and has no effects (S398): worked out when its list is known.
        const paths = [];
        for (const [l, st] of evaluate(fn, x.list, state)) {
          if (!Array.isArray(l) || !l.every(known)) {
            // Its most is its list's (§3.7.5), known even when the items are not.
            const most = mostBound(l);
            paths.push([most === undefined ? top(l) : new Top(taints(l), null, { most }), st]);
            continue;
          }
          const out = [];
          let unknown = false;
          for (let k = 0; k < l.length && !unknown; k++) {
            const inner = forkState(st);
            inner.locals.set(x.item, copy(l[k]));
            inner.locals.set(x.index, V.num(k + 1));
            if (x.cond) {
              const [[c]] = evaluate(fn, x.cond, inner);
              if (!known(c)) unknown = true;
              if (c !== true) continue;
            }
            const [[v]] = evaluate(fn, x.value, inner);
            out.push(v);
          }
          paths.push([unknown ? top(l) : V.list(out, x.most), st]);
        }
        return paths;
      }
      default:
        return applyAll(fn, x, state);
    }
  }

  function applyAll(fn, x, state) {
    const paths = [];
    for (const [vals, st] of evaluateAll(fn, IR.children(x), state)) paths.push([apply(x, vals), st]);
    return paths;
  }

  function evaluateAll(fn, list, state) {
    let paths = [[[], state]];
    for (const e of list) {
      const next = [];
      for (const [vals, st] of paths) for (const [v, st2] of evaluate(fn, e, st)) next.push([[...vals, v], st2]);
      paths = next;
    }
    return paths;
  }

  // A pure function on unknowns is one unknown for the same arguments wherever it is called (§10.4.1).
  // `at`: the call's place, where S602 stands when its working out passes the budget (§16.2.1).
  function pureCall(fn, args, at = null) {
    if (!args.every(known)) return Object.assign(withRecipe(top(...args), { fn, args }), { sig: intern(`call:${fnId(fn)}(${args.map(sigOf).join(",")})`) });
    try {
      return interpret(program, fn, args, { limit: MAX_WORKING }).value;
    } catch (e) {
      // Too long to work out: the check stops (§15.1). A fault leaves the result unknown.
      if (e?.code === "F014") {
        const file = current?.node?.file;
        const node = at && file && (file.name ?? "") === at.file ? { file, span: { line: at.line, col: at.column, endLine: at.line, endCol: at.column + fn.name.length } } : current?.node;
        throw new AnalysisLimit("the PDF check working out a pure call", `${MAX_WORKING.toLocaleString("en")} steps of the interpreter`, node);
      }
      return top(...args);
    }
  }

  // An expression's value from its parts' values.
  // A value an operation gives that is not known carries what it was made of (`sig`): the same operation on the
  // same unknowns is the same unknown wherever it is worked out, so a condition written twice, or kept in a let,
  // is one fact about the answers (§10.4.1).
  // Not an impure native's (today): two of its calls are never taken to give the same value.
  function apply(x, vals) {
    const r = applyOnce(x, vals);
    // How it was made, so it can be made again for each value an answer can take (§10.3).
    if (isTop(r) && !r.recipe && !(x.e === "native" && !NATIVES[x.name]?.pure)) withRecipe(r, { x, vals });
    if (isTop(r) && !r.sig) r.sig = x.e === "native" && !NATIVES[x.name]?.pure ? `?${unique++}` : intern(`${x.e}:${x.op ?? x.name ?? ""}(${vals.map(sigOf).join(",")})`);
    return r;
  }

  function applyOnce(x, vals) {
    switch (x.e) {
      case "unary":
        if (isTop(vals[0]) && x.op === "not") return withPred(top(vals[0]), { k: "not", a: predOf(vals[0]) });
        return isTop(vals[0]) ? top(vals[0]) : op1(x.op, vals[0]);
      case "binary": {
        const [a, b] = vals;
        if (x.op === "and" && a === false) return false;
        if (x.op === "or" && a === true) return true;
        // A known number against one known only to be at most `max`: k <= count(l), past l's most, is no.
        if (V.isNumber(a) && isTop(b) && b.max !== undefined) {
          const k = V.D.compare(a, V.num(b.max));
          if ((x.op === "<=" && k > 0) || (x.op === "<" && k >= 0)) return false;
        }
        if (!known(a) || !known(b)) {
          // What it says of the answers, kept for the picks of a radio group (§10.4.1).
          if (x.op === "and" || x.op === "or") return withPred(top(a, b), { k: x.op, a: predOf(a), b: predOf(b) });
          if (COMPARE.has(x.op) && isTop(a) && a.direct && known(b)) return withPred(top(a, b), { k: "lit", key: a.direct, op: x.op, c: b });
          // An answer among known values (`o in ["a", "b"]`): one fact, its values listed.
          if ((x.op === "in" || x.op === "not in") && isTop(a) && a.direct && Array.isArray(b) && known(b)) {
            const lit = { k: "lit", key: a.direct, op: "in", c: [...b] };
            return withPred(top(a, b), x.op === "in" ? lit : { k: "not", a: lit });
          }
          if (COMPARE.has(x.op) && isTop(b) && b.direct && known(a)) return withPred(top(a, b), { k: "lit", key: b.direct, op: FLIP[x.op], c: a });
          // A known option in an any-of answer (`"a" in s`): one fact per option, `not in` its opposite.
          if ((x.op === "in" || x.op === "not in") && isTop(b) && b.direct && known(a) && !Array.isArray(a) && keys.get(b.direct)?.q?.type === "any-of") {
            const lit = { k: "lit", key: b.direct, op: "has", c: a };
            return withPred(top(a, b), x.op === "in" ? lit : { k: "not", a: lit });
          }
          return top(a, b);
        }
        try {
          const v = op2(x.op, a, b);
          return v === undefined ? null : v;
        } catch {
          return top(a, b);
        }
      }
      case "key":
        return known(vals[0]) ? V.encode(vals[0]) : top(vals[0]);
      case "slice": {
        const [l, a, b] = vals;
        const from = V.whole(a), to = V.whole(b);
        if (!Array.isArray(l) || from === null || to === null || !l.every(known)) return top(l, a, b);
        const f = Math.max(1, from), t = Math.min(l.length, to);
        return V.list(f > t ? [] : l.slice(f - 1, t), V.mostOf(l));
      }
      case "concat":
        return vals.some((v) => !known(v)) ? top(...vals) : vals.map(textOf).join("");
      case "native": {
        const n = NATIVES[x.name];
        // The length of a list is known when the list is, whatever its items hold.
        if (x.name === "count" && Array.isArray(vals[0])) return V.num(vals[0].length);
        if (x.name === "count" && isTop(vals[0])) {
          // At most its most: the value's own, or its type's (a list's most, a set's number of options).
          const t = x.args[0].e === "local" ? x.args[0].l.type : null;
          const most = vals[0].most ?? (t?.t === "list" && Number.isFinite(t.most) ? t.most : t?.t === "options" ? t.set.options.length : undefined);
          if (most !== undefined) return new Top(vals[0].from, null, { max: most });
        }
        // What a list keeps of its most through the library (§14.4) and a placing (§3.7.2), known or not.
        if (KEEPS_MOST.has(x.name) && !vals.every(known) && mostBound(vals[0]) !== undefined) return new Top(new Set(vals.flatMap((v) => [...taints(v)])), null, { most: x.name === "widen" ? Number(V.words(vals[1]).split(",")[0]) : mostBound(vals[0]) });
        // `x is empty` of an answer says so of it, for the picks of a radio group (§10.4.1).
        if (x.name === "is_empty" && isTop(vals[0]) && vals[0].direct) return withPred(top(vals[0]), { k: "lit", key: vals[0].direct, op: "==", c: null });
        if (!n?.pure || !vals.every(known)) return top(...vals);
        try {
          return n.fn(...vals) ?? null;
        } catch {
          return top(...vals);
        }
      }
      case "field": {
        const r = vals[0];
        if (r instanceof StrideRecord) return r.fields[x.i] ?? null;
        return isTop(r) ? new Top(r.from) : null;
      }
      case "item": {
        const [l, i] = vals;
        if (Array.isArray(l) && V.whole(i) !== null) return l[V.whole(i) - 1] ?? null;
        return top(l, i);
      }
      case "record":
        return new StrideRecord(x.decl.name, vals, x.decl.fields.map((f) => f.name));
      case "list":
        return vals;
      default:
        throw new Error(`cannot analyse the expression ${x.e}`);
    }
  }

  // ----- the run

  analyse(program.main, [], new State());
  if (discover) return { boxes, questions: [...questions], links: [], maxOf, keys, discovered: [...discovered.values()] };

  // Every box written or skipped somewhere.
  const missing = header.boxes.filter((b) => !done.has(keyOf(b)));
  for (const b of missing.slice(0, 40)) err("W009", program.formNode ?? null, `the box "${b.field.slice(prefix.length)}"${b.kind === "radio" ? ` button "${b.on}"` : ""} (${b.kind}, page ${b.page}${b.near?.[0] ? `, beside "${b.near[0].slice(0, 60)}"` : ""}) is neither written nor skipped`);
  if (missing.length > 40) err("W010", program.formNode ?? null, `and ${plural(missing.length - 40, "more box", "more boxes")} neither written nor skipped`);

  // Printed words beside the boxes each question's answers go into; each option's beside its box. A question
  // asked in several turns is reported once.
  const reported = new Set();
  for (const [key, k] of keys) {
    if (k.q.item) continue;
    const words = near.get(key);
    // An answer that goes into boxes whose header lists the words beside them: its words among them (§10.6). A
    // header that lists none for those boxes says nothing of them, and nothing is checked.
    if (words?.length && !said(k.printed, words) && !reported.has(k.q)) {
      reported.add(k.q);
      const shown = [...new Set(words)].slice(0, 3).map((p) => `"${p.slice(0, 60)}"`).join(", ");
      err("S517", k.q.node.printed ?? k.node, `"${k.printed}" is not printed beside the boxes ${key} goes into (beside them: ${shown}); those are the words the header lists: if the form prints these beside the box, add them to its "near" there`);
    }
    for (const o of k.q.options) {
      const w = optionNear.get(`${key}\t${o.value}`);
      if (w?.length && !said(o.printed, w) && !reported.has(`${k.q.name}\t${o.value}`)) {
        reported.add(`${k.q.name}\t${o.value}`);
        const shown = [...new Set(w)].slice(0, 2).map((p) => `"${p.slice(0, 60)}"`).join(", ");
        err("S518", o.node ?? k.node, `the option "${o.value}": "${o.printed}" is not printed beside its box (beside it: ${shown}); those are the words the header lists: if the form prints these beside the box, add them to its "near" there`);
      }
    }
  }

  return { boxes, questions: [...questions], links: [...links.values()], maxOf, keys };
}

// Printed words, compared without case, dashes of every kind, quotes of every kind, and runs of spaces.
const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/[“”«»]/g, '"')
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}()'"$%/&-]+/gu, " ")
    .trim();

export const said = (printed, near) => near.some((p) => norm(p).includes(norm(printed)));
