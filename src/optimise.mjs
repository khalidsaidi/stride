// Phase 7: optimise the intermediate form. Each pass keeps what the program does and makes it smaller; they run
// in turn until none changes anything:
//
//   fold        an expression whose parts are known is worked out (operators, pure natives, joined words),
//               and simple identities applied (x and yes is yes or no as x is, not not not x is not x);
//   propagate   a local given one known value, where that is the only value it ever has and the place it is
//               given dominates every use, is replaced by the value;
//   inline      a call to a small pure function (one block that returns one expression) becomes that expression;
//   evaluate    a call to a pure function whose arguments are all known is run now (by the interpreter of the
//               intermediate form) and its value put in its place, when that value is words, a number, a date or
//               yes-no;
//   branches    a branch on a known condition becomes a jump;
//   blocks      a block that only jumps is skipped; a block with one predecessor that jumps to it is merged into
//               it; blocks no path reaches are removed;
//   dead        a local no statement reads loses the statements that give it a value (when they do nothing else),
//               and an eval of an expression with no effect goes;
//   functions   functions no longer called are removed.
//
// It never removes an ask, a check, a box write or a call with effects that a path can reach: what a person is
// asked and what goes into the PDF stay exactly as the program says.
import * as V from "../runtime/values.mjs";
import * as IR from "./ir.mjs";
import { NATIVES } from "../runtime/natives.mjs";
import { binary, unary } from "../runtime/ops.mjs";
import { textOf as text, StrideRecord } from "../runtime/natives.mjs";
import { interpret } from "./interpret.mjs";

export function optimise(program, { passes = ["fold", "propagate", "inline", "evaluate", "branches", "blocks", "dead"] } = {}) {
  const on = new Set(passes);
  const stats = { folded: 0, propagated: 0, inlined: 0, evaluated: 0, branches: 0, merged: 0, removedBlocks: 0, deadStatements: 0, removedFunctions: 0 };
  for (let round = 0; round < 50; round++) {
    let changed = false;
    for (const fn of program.functions) {
      if (on.has("fold")) changed = foldFunction(fn, stats) || changed;
      if (on.has("inline")) changed = inlineCalls(fn, stats) || changed;
      if (on.has("evaluate")) changed = evaluateCalls(program, fn, stats) || changed;
      if (on.has("propagate")) changed = propagate(fn, stats) || changed;
      if (on.has("branches")) changed = foldBranches(fn, stats) || changed;
      if (on.has("blocks")) changed = simplifyBlocks(fn, stats) || changed;
      if (on.has("dead")) changed = removeDead(fn, stats) || changed;
    }
    changed = removeUncalled(program, stats) || changed;
    if (!changed) break;
  }
  return stats;
}

// ----- fold

const isValue = (x) => x.e === "const";

export function fold(x, stats) {
  const y = IR.mapChildren(x, (c) => fold(c, stats));
  const done = (v) => {
    stats && stats.folded++;
    return IR.constant(v);
  };
  switch (y.e) {
    case "unary": {
      if (isValue(y.a)) {
        const v = unary(y.op, y.a.v);
        if (v !== undefined) return done(v);
      }
      // not not not x is not x; not not x stays, since it makes an empty x no.
      if (y.op === "not" && y.a.e === "unary" && y.a.op === "not" && y.a.a.e === "unary" && y.a.a.op === "not") return (stats && stats.folded++, y.a.a);
      return y;
    }
    case "binary": {
      const a = y.a, b = y.b;
      if (isValue(a) && isValue(b)) {
        try {
          const v = binary(y.op, a.v, b.v);
          if (v !== undefined) return done(v);
        } catch {
          return y; // dividing by zero: the machine reports it, with the line
        }
      }
      // Conditions with one side known.
      // What is left is made yes or no (§6.15.1): `yes and a` with `a` empty is no.
      const bool = (x) => (stats && stats.folded++, IR.unary("not", IR.unary("not", x)));
      if (y.op === "and") {
        if (isValue(a)) return a.v === true ? bool(b) : done(false);
        if (isValue(b) && b.v === true) return bool(a);
      }
      if (y.op === "or") {
        if (isValue(a)) return a.v === true ? done(true) : bool(b);
        if (isValue(b) && b.v !== true && !hasCall(a)) return bool(a);
      }
      return y;
    }
    case "concat": {
      // Known parts next to each other are joined; all known, it is one text.
      const parts = [];
      for (const p of y.parts) {
        const last = parts[parts.length - 1];
        if (isValue(p) && last && isValue(last)) parts[parts.length - 1] = IR.constant(text(last.v) + text(p.v));
        else parts.push(isValue(p) ? IR.constant(text(p.v)) : p);
      }
      // Words longer than the limit are not made here: the run faults on them, where they stand (F012, §3.1).
      if (parts.some((p) => isValue(p) && [...text(p.v)].length > 100_000)) return y;
      if (parts.length === 1 && isValue(parts[0])) return parts.length === y.parts.length ? parts[0] : done(parts[0].v);
      if (parts.length === 0) return IR.constant("");
      return parts.length === y.parts.length ? { ...y, parts } : (stats && stats.folded++, { ...y, parts });
    }
    case "native": {
      const n = NATIVES[y.name];
      if (n?.pure && y.args.every(isValue)) {
        try {
          return done(n.fn(...y.args.map((a) => a.v)));
        } catch {
          return y;
        }
      }
      return y;
    }
    // A field of a record made here, an item of a list made here: the rest is dropped, so only when none of it can
    // fault or ask (§6.2, §19.1).
    case "field":
      if (y.a.e === "record" && y.a.fields.every((f, i) => i === y.i || IR.cannotFault(f))) return (stats && stats.folded++, y.a.fields[y.i]);
      return y;
    case "item":
      if (y.a.e === "list" && isValue(y.i) && V.whole(y.i.v) !== null && V.whole(y.i.v) >= 1 && V.whole(y.i.v) <= (y.a.most ?? Math.max(1, y.a.items.length)) && y.a.items.every((it, k) => k === V.whole(y.i.v) - 1 || IR.cannotFault(it))) {
        const it = y.a.items[V.whole(y.i.v) - 1];
        return (stats && stats.folded++, it ?? IR.constant(null));
      }
      return y;
    default:
      return y;
  }
}

const hasCall = (x) => x.e === "call" || (x.e === "native" && !NATIVES[x.name]?.pure) || IR.children(x).some(hasCall);

function foldFunction(fn, stats) {
  const before = stats.folded;
  for (const b of fn.blocks) {
    b.stmts = b.stmts.map((s) => IR.mapExpressions(s, (x) => fold(x, stats)));
    if (b.term) b.term = IR.mapExpressions(b.term, (x) => fold(x, stats));
  }
  return stats.folded !== before;
}

// ----- branches

function foldBranches(fn, stats) {
  let changed = false;
  for (const b of fn.blocks) {
    const t = b.term;
    if (t?.op === "branch" && isValue(t.cond)) {
      b.term = { op: "jump", to: t.cond.v === true ? t.yes : t.no, node: t.node };
      stats.branches++;
      changed = true;
    } else if (t?.op === "branch" && t.yes === t.no && !hasCall(t.cond) && IR.cannotFault(t.cond)) {
      // Both ways go to one place: the condition goes too, unless working it out could fault (§19.1).
      b.term = { op: "jump", to: t.yes, node: t.node };
      stats.branches++;
      changed = true;
    }
  }
  return changed;
}

// ----- blocks

function simplifyBlocks(fn, stats) {
  let changed = false;
  // Jumps to a block that only jumps go straight on (not to a loop's head, which must stay where it is).
  const forward = (b) => {
    const seen = new Set();
    let x = b;
    while (x.stmts.length === 0 && x.term?.op === "jump" && !x.loopHead && !seen.has(x)) {
      seen.add(x);
      x = x.term.to;
    }
    return x;
  };
  for (const b of fn.blocks) {
    const t = b.term;
    if (!t) continue;
    if (t.op === "jump") {
      const to = forward(t.to);
      if (to !== t.to) (t.to = to), (changed = true);
    } else if (t.op === "branch") {
      const yes = forward(t.yes), no = forward(t.no);
      if (yes !== t.yes || no !== t.no) (t.yes = yes), (t.no = no), (changed = true);
    }
  }
  const entry = forward(fn.entry);
  if (entry !== fn.entry && !fn.entry.loopHead) (fn.entry = entry), (changed = true);
  // A block whose only predecessor jumps to it is merged into that predecessor.
  for (;;) {
    const preds = fn.predecessors();
    let merged = false;
    for (const b of fn.order()) {
      if (b.term?.op !== "jump") continue;
      const next = b.term.to;
      if (next === b || next === fn.entry || next.loopHead) continue;
      if (preds.get(next).length !== 1) continue;
      b.stmts.push(...next.stmts);
      b.term = next.term;
      next.stmts = [];
      next.term = { op: "jump", to: next };
      stats.merged++;
      merged = changed = true;
      break;
    }
    if (!merged) break;
  }
  // Blocks no path reaches.
  const reachable = new Set(fn.order());
  const before = fn.blocks.length;
  fn.blocks = fn.blocks.filter((b) => reachable.has(b));
  if (fn.blocks.length !== before) {
    stats.removedBlocks += before - fn.blocks.length;
    changed = true;
  }
  // A loop's head that no longer has a jump back to it is an ordinary block.
  const preds = fn.predecessors();
  for (const b of fn.blocks) {
    if (!b.loopHead) continue;
    const order = fn.order();
    const at = order.indexOf(b);
    if (!preds.get(b).some((p) => order.indexOf(p) >= at)) (b.loopHead = false), (changed = true);
  }
  return changed;
}

// ----- propagate

// The dominators of each block (Cooper, Harvey and Kennedy's iterative algorithm).
export function dominators(fn) {
  const order = fn.order();
  const index = new Map(order.map((b, i) => [b, i]));
  const preds = fn.predecessors();
  const idom = new Map([[fn.entry, fn.entry]]);
  const intersect = (a, b) => {
    while (a !== b) {
      while (index.get(a) > index.get(b)) a = idom.get(a);
      while (index.get(b) > index.get(a)) b = idom.get(b);
    }
    return a;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const b of order) {
      if (b === fn.entry) continue;
      let d = null;
      for (const p of preds.get(b)) if (idom.has(p)) d = d ? intersect(p, d) : p;
      if (d && idom.get(b) !== d) (idom.set(b, d), (changed = true));
    }
  }
  return (a, b) => {
    // whether a dominates b
    for (let x = b; ; x = idom.get(x)) {
      if (x === a) return true;
      if (x === fn.entry || !idom.has(x)) return false;
    }
  };
}

function propagate(fn, stats) {
  // Locals given a value exactly once, by a set of a known value, and changed by nothing else.
  const defs = new Map(); // local -> [{ block, index, stmt }]
  const other = new Set(); // locals given values by store, append, ask, or as parameters
  for (const p of fn.params) other.add(p);
  for (const b of fn.blocks) {
    b.stmts.forEach((s, i) => {
      if (s.op === "set") defs.set(s.dst, [...(defs.get(s.dst) ?? []), { block: b, index: i, stmt: s }]);
      if (s.op === "store" || s.op === "append" || s.op === "ask") other.add(s.dst);
      for (const p of s.op === "store" ? s.path : []) if (p.into) other.add(p.into);
    });
  }
  const known = new Map();
  for (const [l, list] of defs) if (list.length === 1 && !other.has(l) && isValue(list[0].stmt.value) && !Array.isArray(list[0].stmt.value.v)) known.set(l, list[0]);
  if (!known.size) return false;
  const dominates = dominators(fn);
  let changed = false;
  const replace = (x, block, index) =>
    x.e === "local" && known.has(x.l) && reaches(known.get(x.l), block, index)
      ? (stats.propagated++, (changed = true), keepPlace(IR.constant(known.get(x.l).stmt.value.v), x))
      : IR.mapChildren(x, (c) => replace(c, block, index));
  const reaches = (def, block, index) => (def.block === block ? def.index < index : dominates(def.block, block));
  for (const b of fn.blocks) {
    b.stmts = b.stmts.map((s, i) => IR.mapExpressions(s, (x) => replace(x, b, i)));
    if (b.term) b.term = IR.mapExpressions(b.term, (x) => replace(x, b, b.stmts.length));
  }
  return changed;
}

// A replacement keeps the place of the expression it replaces.
const keepPlace = (y, x) => (x.at ? { ...y, at: x.at, ...(x.inline ? { inline: x.inline } : {}) } : y);

// ----- inline

// A pure function that is one block returning one expression, used in no loop of its own.
function inlinable(fn) {
  if (!fn.pure || fn.blocks.length !== 1) return null;
  const b = fn.entry;
  if (b.stmts.length !== 0 || b.term?.op !== "return" || !b.term.value) return null;
  const body = b.term.value;
  if (size(body) > 30) return null;
  return body;
}

const size = (x) => 1 + IR.children(x).reduce((n, c) => n + size(c), 0);
const uses = (x, l) => (x.e === "local" && x.l === l ? 1 : 0) + IR.children(x).reduce((n, c) => n + uses(c, l), 0);
const simple = (x) => x.e === "const" || x.e === "local";

function inlineCalls(fn, stats) {
  let changed = false;
  const visit = (x) => {
    const y = IR.mapChildren(x, visit);
    if (y.e !== "call" || y.fn === fn) return y;
    const body = inlinable(y.fn);
    if (!body) return y;
    // Every argument must be one that cannot fault: put in where its parameter stands, it may be worked out in
    // another order, or not at all, and the faults must stay the call's own, in order (§9.4.1, §19.1). One used
    // more than once must be a value or a local, so nothing is worked out twice: optimising never makes a run do
    // more instructions (§19.1.1).
    if (y.args.some((a, i) => !IR.cannotFault(a) || (uses(body, y.fn.params[i]) > 1 && !simple(a)))) return y;
    // The body's own expressions remember the call they were inlined through, so a fault in them shows the same
    // logical stack as if the call had run (§13.4); the arguments put in are the caller's and keep its chain.
    const frame = { function: y.fn.name, call: y.at ?? { file: "", line: 0, column: 0 } };
    const put = (z) => {
      if (z.e === "local" && y.fn.params.includes(z.l)) return y.args[y.fn.params.indexOf(z.l)];
      // Innermost first: the body's own chain, this call, then the chain the call itself was inlined through.
      return { ...IR.mapChildren(z, put), inline: [...(z.inline ?? []), frame, ...(y.inline ?? [])] };
    };
    stats.inlined++;
    changed = true;
    return put(body);
  };
  for (const b of fn.blocks) {
    b.stmts = b.stmts.map((s) => IR.mapExpressions(s, visit));
    if (b.term) b.term = IR.mapExpressions(b.term, visit);
  }
  return changed;
}

// ----- evaluate

function evaluateCalls(program, fn, stats) {
  let changed = false;
  const visit = (x) => {
    const y = IR.mapChildren(x, visit);
    if (y.e !== "call" || !y.fn.pure || y.fn === fn || !y.args.every(isValue)) return y;
    let value;
    try {
      value = interpret(program, y.fn, y.args.map((a) => a.v), { limit: 10_000 }).value;
    } catch {
      return y; // a fault, or too long to run now: left for the machine, which reports a fault with its line
    }
    if (value instanceof StrideRecord || Array.isArray(value) || value === undefined) return y;
    stats.evaluated++;
    changed = true;
    return IR.constant(value);
  };
  for (const b of fn.blocks) {
    b.stmts = b.stmts.map((s) => IR.mapExpressions(s, visit));
    if (b.term) b.term = IR.mapExpressions(b.term, visit);
  }
  return changed;
}

// ----- dead

function removeDead(fn, stats) {
  const read = new Set();
  const mark = (x) => {
    if (x.e === "local") read.add(x.l);
    IR.children(x).forEach(mark);
  };
  for (const b of fn.blocks) {
    for (const s of b.stmts) {
      IR.expressionsOf(s).forEach(mark);
      // An answer that goes into a record's field needs the record; so does a store or an append, which may fault.
      if ((s.op === "ask" && s.path.length) || s.op === "store" || s.op === "append") read.add(s.dst);
    }
    if (b.term) IR.expressionsOf(b.term).forEach(mark);
  }
  let changed = false;
  for (const b of fn.blocks) {
    const before = b.stmts.length;
    b.stmts = b.stmts.filter((s) => {
      // Only what cannot fault goes: a fault the program would meet stays (§19.1).
      if (s.op === "set" && !read.has(s.dst) && !fn.params.includes(s.dst) && !IR.hasEffect(s.value, NATIVES) && IR.cannotFault(s.value)) return false;
      if (s.op === "eval" && !IR.hasEffect(s.value, NATIVES) && IR.cannotFault(s.value)) return false;
      return true;
    });
    if (b.stmts.length !== before) {
      stats.deadStatements += before - b.stmts.length;
      changed = true;
    }
  }
  // Locals no statement mentions any more.
  const used = new Set(fn.params);
  for (const b of fn.blocks) {
    for (const s of b.stmts) {
      if (s.dst) used.add(s.dst);
      IR.expressionsOf(s).forEach(function m(x) {
        if (x.e === "local") used.add(x.l);
        IR.children(x).forEach(m);
      });
    }
    if (b.term) IR.expressionsOf(b.term).forEach(function m(x) {
      if (x.e === "local") used.add(x.l);
      IR.children(x).forEach(m);
    });
  }
  fn.locals = fn.locals.filter((l) => used.has(l));
  return changed;
}

// ----- functions

function removeUncalled(program, stats) {
  const called = new Set([program.main]);
  const queue = [program.main];
  const visit = (x) => {
    if (x.e === "call" && !called.has(x.fn)) {
      called.add(x.fn);
      queue.push(x.fn);
    }
    IR.children(x).forEach(visit);
  };
  while (queue.length) {
    const fn = queue.pop();
    for (const b of fn.blocks) {
      for (const s of b.stmts) IR.expressionsOf(s).forEach(visit);
      if (b.term) IR.expressionsOf(b.term).forEach(visit);
    }
  }
  const before = program.functions.length;
  program.functions = program.functions.filter((f) => called.has(f));
  stats.removedFunctions += before - program.functions.length;
  return program.functions.length !== before;
}
