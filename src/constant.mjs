// Values known before the form opens: a constant's value, a list's most, a loop's bounds, the words of a box
// name with a loop's counter put in. This is the compiler's evaluator for them; it works on the syntax tree,
// before anything is lowered, and gives a value or null (not known before the form opens).
//
// The values are the machine's (runtime/values.mjs): words, exact decimals, dates, yes or no, null for
// empty. A fault met on known values (dividing by zero, a native given what it cannot take) gives no value and is
// recorded on the node as `knownFault`, which the flow check reports as S413 when the code is reachable (§11.3).
//
// A pure function (§9.9, once the flow check has worked out which are) called with known arguments is run here, on
// its syntax tree: lets, vars, assignments to names, ifs and matches on known values, loops with known bounds, and
// returns. Anything else in it, or more than 100,000 steps, and the call is not known; a fault in it is the call's.
import { NATIVES } from "../runtime/natives.mjs";
import { binary, unary } from "../runtime/ops.mjs";
import { StrideFault, StrideRecord, emptyRecord, words as textOf, list, isEmpty, mostOf, whole, copy, num, equal, set, isSet } from "../runtime/values.mjs";

// A value placed where `type` is expected, as the machine places it (§3.7.2, §3.8): a list widened to the type's
// mosts (F017 when it holds more), a list of options made the set.
function placed(v, type) {
  if (!type) return v;
  if (type.t === "options" && (v === null || (Array.isArray(v) && !isSet(v)))) return set(v ?? [], type.set.options.map((o) => o.value));
  // `?` where a level's most is known only as the program runs: the value keeps its own there (§3.9 rule 4).
  const mosts = [];
  for (let t = type; t?.t === "list"; t = t.element) mosts.push(Number.isFinite(t.most) ? t.most : "?");
  while (mosts.at(-1) === "?") mosts.pop();
  if (!Number.isFinite(mosts[0]) && type.t === "list" && v === null) return list([], 0); // §3.7.3.1
  return mosts.length ? NATIVES.widen.fn(v, mosts.join(",")) : v;
}

// A known value placed where `type` is: what a let made of it holds (undefined when not known, or when placing it
// faults, which the run reports where it stands).
export function knownPlaced(expr, type, env = new Map()) {
  const v = evaluate(expr, env);
  if (v === undefined) return undefined;
  try {
    return placed(v, type);
  } catch (e) {
    if (e instanceof StrideFault) return undefined;
    throw e;
  }
}

// Thrown inside a function run here when something in it is not known before the form opens.
const UNKNOWN = Symbol("unknown");

// A check the compiler must make that would pass its budget (§15.1): compilation stops with S602 at `node`.
export class AnalysisLimit extends Error {
  constructor(check, budget, node) {
    super(`compiler analysis limit exceeded: ${check} would pass its budget of ${budget}`);
    this.node = node;
  }
}
// One working out's work (§15.1): each expression, each statement and each turn of a loop, an empty one too, in
// the functions it calls as well.
const FUEL = 100_000;
let fuel = FUEL;
const spend = () => {
  if (--fuel < 0) throw new AnalysisLimit("working out a value before the form opens", `${FUEL.toLocaleString("en")} steps`, root);
};
let calls = 0;

const faultOf = (e, f) => {
  try {
    return f();
  } catch (x) {
    // Inside a function run here, a fault is the call's: it goes on up to it, carrying the operation it began at.
    if (x instanceof StrideFault && !x.origin) x.origin = e;
    if (x instanceof StrideFault && calls === 0) {
      e.knownFault = { code: x.code, message: x.message, origin: x.origin };
      return undefined;
    }
    throw x;
  }
};

// `env` gives the value of a name that is known (a loop's counter while unrolling, a function's static
// argument while specialising); `symbols` resolve a constant's own value.
// What is known (§11.1) leaves out list items and calls of Stride functions. The one exception is the operation
// being checked itself (`root`): a pure call on known arguments is worked out, by running it, to see whether it
// faults whenever it runs (§11.3.1). Inside a function run here, everything is worked out.
let root = null;
export function evaluate(expr, env = new Map()) {
  fuel = FUEL;
  calls = 0;
  root = expr;
  return value(expr, env, new Set());
}

// A pure function run on known arguments: its result, or UNKNOWN thrown; a fault in it is thrown as it is.
function runKnown(fn, args) {
  if (++calls > 200) throw UNKNOWN; // deeper than a run may go (§15): left to the machine
  try {
    const env = new Map(fn.params.map((p, i) => [p, copy(placed(args[i] ?? null, p.type))]));
    const out = block(fn.node.body, env);
    return out?.returned ? placed(out.value, fn.result) : null;
  } finally {
    calls--;
  }
}

const known = (e, env) => {
  const v = value(e, env, new Set());
  if (v === undefined) throw UNKNOWN;
  return v;
};

// An empty record of a record type, its list fields empty lists of their most (§7.5.1).
const madeRecord = (t) => emptyRecord(t.decl.name, t.decl.fields.map((f) => (f.type?.t === "list" && Number.isFinite(f.type.most) ? f.type.most : null)), t.decl.fields.map((f) => f.name));

// `x.f[i].g = v` and the like (§7.5, §7.5.1), as the machine does it: the place's steps from the outside in, each
// but the last a read, a record made where a place on the way holds empty; a last position checked (F005) before
// the value is worked out; then the value, placed as the place's type.
function assignAt(s, env) {
  const steps = [];
  let t = s.target;
  while (t.kind === "field" || t.kind === "index") (steps.unshift(t), (t = t.target));
  if (t.kind !== "name" || !env.has(t.symbol)) throw UNKNOWN;
  let holder = env.get(t.symbol);
  if (steps[0].kind === "field" && isEmpty(holder) && t.symbol.type?.t === "record") env.set(t.symbol, (holder = madeRecord(t.symbol.type)));
  for (let k = 0; k < steps.length - 1; k++) {
    const step = steps[k], next = steps[k + 1];
    if (step.kind === "field") {
      if (!(holder instanceof StrideRecord)) throw new StrideFault("F006", "a field was set on something that is not a record");
      if (isEmpty(holder.fields[step.fieldIndex]) && next.kind === "field" && step.type?.t === "record") holder.fields[step.fieldIndex] = madeRecord(step.type);
      holder = holder.fields[step.fieldIndex];
    } else {
      const i = known(step.index, env);
      const n = whole(i);
      const most = Array.isArray(holder) ? mostOf(holder) : 0;
      if (n === null || n < 1 || n > most) throw new StrideFault("F004", `${isEmpty(i) ? "an empty position" : `position ${textOf(i)}`} is not a whole number from 1 to the list's most, ${most}`);
      if (n > holder.length) throw new StrideFault("F020", `there is no item ${n} to change: the list holds ${holder.length}`);
      if (isEmpty(holder[n - 1]) && next.kind === "field" && step.type?.t === "record") holder[n - 1] = madeRecord(step.type);
      holder = holder[n - 1];
    }
  }
  const last = steps[steps.length - 1];
  if (last.kind === "index") {
    const i = known(last.index, env);
    const n = whole(i);
    if (!Array.isArray(holder)) throw new StrideFault("F006", "an item was set on something that is not a list");
    if (n === null || n < 1 || n > holder.length + 1 || n > mostOf(holder)) throw new StrideFault("F005", `${isEmpty(i) ? "an empty position" : `position ${textOf(i)}`} cannot be set: the list holds ${holder.length} of at most ${mostOf(holder)}`);
    let v = known(s.value, env);
    if (s.op) v = binary(s.op, holder[n - 1] ?? null, v);
    holder[n - 1] = copy(placed(v, last.type));
    return;
  }
  let v = known(s.value, env);
  if (!(holder instanceof StrideRecord)) throw new StrideFault("F006", "a field was set on something that is not a record");
  if (s.op) v = binary(s.op, holder.fields[last.fieldIndex] ?? null, v);
  holder.fields[last.fieldIndex] = copy(placed(v, last.type));
}

// Runs statements; gives { returned, value }, "break", "continue" or null when it runs past the end.
function block(list, env) {
  for (const s of list) {
    spend();
    const out = statement(s, env);
    if (out) return out;
  }
  return null;
}

function statement(s, env) {
  switch (s.kind) {
    case "let":
    case "var":
      if (!s.symbol) throw UNKNOWN;
      // A record var without a value holds empty; a record is made on the way when a field is set (§7.5.1).
      env.set(s.symbol, s.value ? copy(placed(known(s.value, env), s.symbol.type)) : placed(null, s.symbol.type));
      return null;
    case "assign": {
      if (s.target.kind === "name") {
        if (!env.has(s.target.symbol)) throw UNKNOWN;
        let v = known(s.value, env);
        if (s.op) v = binary(s.op, env.get(s.target.symbol), v);
        env.set(s.target.symbol, copy(placed(v, s.target.symbol.type)));
        return null;
      }
      assignAt(s, env);
      return null;
    }
    case "if":
      return block(known(s.condition, env) === true ? s.then : s.otherwise, env);
    case "match": {
      const subject = known(s.subject, env);
      const arm = s.arms.find((a) => !a.values || a.values.some((v) => v.value === subject));
      return arm ? block(arm.body, env) : null;
    }
    case "for": {
      // Each bound a whole number, else F004, as the machine checks it (§7.11).
      const [from, to] = [s.from, s.to].map((b) => whole(NATIVES.loop_bound.fn(known(b, env))));
      if (!s.symbol) throw UNKNOWN;
      for (let i = from; i <= to; i++) {
        spend();
        env.set(s.symbol, num(i));
        const out = block(s.body, env);
        if (out === "break") break;
        if (out && out !== "continue") return out;
      }
      return null;
    }
    case "for-each": {
      const items = known(s.list, env);
      if (!Array.isArray(items) && items !== null) throw UNKNOWN;
      for (const [i, item] of (items ?? []).entries()) {
        spend();
        if (s.indexSymbol) env.set(s.indexSymbol, num(i + 1));
        env.set(s.itemSymbol, copy(item));
        const out = block(s.body, env);
        if (out === "break") break;
        if (out && out !== "continue") return out;
      }
      return null;
    }
    case "return":
      return { returned: true, value: s.value ? known(s.value, env) : null };
    case "break":
      return "break";
    case "continue":
      return "continue";
    case "call-statement":
      known(s.call, env);
      return null;
    default:
      throw UNKNOWN;
  }
}

function value(e, env, visiting) {
  spend();
  switch (e.kind) {
    case "comprehension": {
      // Its own loop, as the machine runs it (§6.12): each item in turn, those the if takes, the list's most.
      const l = value(e.list, env, visiting);
      if (l === undefined) return undefined;
      const items = Array.isArray(l) ? l : [];
      const out = [];
      for (const [k, item] of items.entries()) {
        spend();
        const inner = new Map(env);
        inner.set(e.itemSymbol, copy(item));
        if (e.indexSymbol) inner.set(e.indexSymbol, num(k + 1));
        if (e.condition) {
          const c = value(e.condition, inner, visiting);
          if (c === undefined) return undefined;
          if (c !== true) continue;
        }
        const v = value(e.value, inner, visiting);
        if (v === undefined) return undefined;
        out.push(copy(v));
      }
      return list(out, Number.isFinite(e.type?.most) ? e.type.most : Array.isArray(l) ? mostOf(l) : 0);
    }
    case "number":
      return e.value;
    case "yes-no":
      return e.value;
    case "empty":
      return null;
    case "string": {
      let out = "";
      for (const p of e.parts) {
        if (typeof p === "string") out += p;
        else {
          const v = value(p, env, visiting);
          if (v === undefined) return undefined;
          out += textOf(v);
        }
      }
      // Words longer than the limit fault (F012, §3.1): known, that is S413.
      return faultOf(e, () => {
        if ([...out].length > 100_000) throw new StrideFault("F012", "the words would be more than 100000 characters");
        return out;
      });
    }
    case "plain-string":
      return e.value;
    case "name": {
      const sym = e.symbol;
      if (!sym) return undefined;
      if (env.has(sym)) return env.get(sym);
      if (sym.kind === "const") {
        if (sym.known) return sym.value;
        if (visiting.has(sym)) return undefined; // a constant made of itself: reported by the checker
        visiting.add(sym);
        const v = value(sym.node.value, env, visiting);
        visiting.delete(sym);
        return v;
      }
      // A let made of known values is known (§11.1), placed as its type; one declared in two arms is not.
      if (sym.kind === "let" && !sym.branchDeclared && sym.node?.value && !visiting.has(sym)) {
        visiting.add(sym);
        try {
          const v = value(sym.node.value, env, visiting);
          return v === undefined ? undefined : placed(v, sym.type);
        } catch (x) {
          if (x instanceof StrideFault) return undefined; // placing it faults: the run reports it where it stands
          throw x;
        } finally {
          visiting.delete(sym);
        }
      }
      return undefined;
    }
    case "unary": {
      const a = value(e.operand, env, visiting);
      if (a === undefined) return undefined;
      return faultOf(e, () => unary(e.op, a));
    }
    case "binary": {
      const a = value(e.a, env, visiting);
      // and / or decide on the left when they can, and give yes or no (§6.15.1).
      if (e.op === "and" && a !== undefined && a !== true) return false;
      if (e.op === "or" && a === true) return true;
      const b = value(e.b, env, visiting);
      if (a === undefined || b === undefined) return undefined;
      // l + m is placed into its joined type, as the engines place it (§3.9 rule 4, §6.5.1).
      return faultOf(e, () => (e.op === "+" && e.type?.t === "list" ? placed(binary(e.op, a, b), e.type) : binary(e.op, a, b)));
    }
    case "is-empty": {
      const a = value(e.operand, env, visiting);
      if (a === undefined) return undefined;
      return e.not ? !isEmpty(a) : isEmpty(a);
    }
    case "call": {
      const callee = e.callee ?? (e.target.kind === "name" ? e.target.symbol : null);
      if (!callee || !e.bound) return undefined;
      const native = callee.kind === "native" ? NATIVES[callee.name] : null;
      if (callee.kind === "native" ? !native?.pure || native.internal : callee.kind !== "function" || callee.impure !== false) return undefined;
      if (callee.kind === "function" && calls === 0 && e !== root) return undefined;
      // `sorted(l, by: …)` names a field, not a value: left to the machine.
      if (e.args.some((a) => a.kind === "named-arg" && !callee.params.some((p) => p.name === a.name))) return undefined;
      const args = e.bound.map((a) => (a.kind === "default-of" ? a.param.defaultValue ?? null : value(a, env, visiting)));
      if (args.some((v) => v === undefined)) {
        // Its control arguments known and wrong: a fault whatever the rest hold, since they are checked first
        // (§14.0.3.1). Tried with the rest empty, which never faults by itself (§14.0.3); no value either way.
        const control = native?.control;
        if (control && args.every((v, i) => v !== undefined || !control.includes(i))) faultOf(e, () => native.fn(...args.map((v) => v ?? null)));
        return undefined;
      }
      // either's values are placed as their join first, as the machine places them (§3.9).
      if (native) return faultOf(e, () => native.fn(...(e.joined ? args.map((v) => placed(v, e.joined)) : args)));
      try {
        return faultOf(e, () => runKnown(callee, e.placedAs ? args.map((v, i) => placed(v, e.placedAs[i])) : args));
      } catch (x) {
        if (x === UNKNOWN) return undefined;
        throw x;
      }
    }
    case "slice": {
      // l[a..b] (§6.9.3): bounds whole numbers, else F004; then the items a to b, l's most.
      const l = value(e.target, env, visiting);
      const a = value(e.from, env, visiting), b = value(e.to, env, visiting);
      if (l === undefined || a === undefined || b === undefined || (l !== null && !Array.isArray(l))) return undefined;
      return faultOf(e, () => {
        const x = whole(a), y = whole(b);
        if (x === null || y === null) throw new StrideFault("F004", "a slice's bounds are whole numbers");
        const from = Math.max(1, x), to = Math.min(l?.length ?? 0, y);
        return list(from > to ? [] : l.slice(from - 1, to).map(copy), mostOf(l));
      });
    }
    case "field": {
      // A field read (§6.10): of empty, empty. A field is not known before the form opens (§11.1), but inside a
      // function run here.
      if (calls === 0 && e !== root) return undefined;
      const r = value(e.target, env, visiting);
      if (r === undefined) return undefined;
      if (r === null) return null;
      return faultOf(e, () => {
        if (!(r instanceof StrideRecord)) throw new StrideFault("F006", "a field was read on something that is not a record");
        return r.fields[e.fieldIndex] ?? null;
      });
    }
    case "new": {
      // A record made with new (§6.2): the fields given worked out as written, each placed as its field's type, the
      // others empty. Not known before the form opens (§11.1), but inside a function run here.
      if (calls === 0 && e !== root) return undefined;
      const decl = e.recordSymbol?.decl;
      if (!decl) return undefined;
      const given = new Map();
      for (const f of e.fields) {
        const v = value(f.value, env, visiting);
        if (v === undefined) return undefined;
        given.set(f.name, v);
      }
      return faultOf(e, () => new StrideRecord(decl.name, decl.fields.map((f) => copy(placed(given.has(f.name) ? given.get(f.name) : null, f.type))), decl.fields.map((f) => f.name)));
    }
    case "index": {
      // A list position read (§6.9.2): F004 unless whole and from 1 to the list's most; past the items, empty.
      // An item is not known before the form opens (§11.1), but inside a function run here.
      if (calls === 0 && e !== root) return undefined;
      const l = value(e.target, env, visiting);
      const i = value(e.index, env, visiting);
      if (l === undefined || i === undefined || (l !== null && !Array.isArray(l))) return undefined;
      return faultOf(e, () => {
        const n = whole(i);
        if (n === null || n < 1 || n > mostOf(l)) throw new StrideFault("F004", `${i === null ? "an empty position" : `position ${textOf(i)}`} is not a whole number from 1 to the list's most, ${mostOf(l)}`);
        return l?.[n - 1] ?? null;
      });
    }
    case "list": {
      // Each item widened to the literal's element type (§3.9).
      const items = [];
      for (const x of e.items) {
        const v = value(x, env, visiting);
        if (v === undefined) return undefined;
        items.push(v);
      }
      return faultOf(e, () => list(items.map((v) => placed(v, e.type?.element)), Math.max(1, items.length)));
    }
    case "cond": {
      // Whichever branch runs, its value has the conditional's type: the join of the two (§3.9, §6.13).
      const c = value(e.condition, env, visiting);
      if (c === undefined) return undefined;
      const v = value(c === true ? e.yes : e.no, env, visiting);
      return v === undefined ? undefined : faultOf(e, () => placed(v, e.type));
    }
    default:
      return undefined;
  }
}
