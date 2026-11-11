// Values known before the form opens: a constant's value, a list's most, a loop's bounds, the words of a box
// name with a loop's counter put in. This is the compiler's evaluator for them; it works on the syntax tree,
// before anything is lowered, and gives a value or null (not known before the form opens).
//
// The values are the machine's (runtime/values.mjs): words, exact decimals, dates, yes or no, null for
// empty. A fault met on known values (dividing by zero, a native given what it cannot take) gives no value and is
// recorded on the node as `knownFault`: in a constant's value or a default it is mistake S413 (§11.3).
import { NATIVES } from "../runtime/natives.mjs";
import { binary, unary } from "../runtime/ops.mjs";
import { StrideFault, words as textOf, list, isEmpty, mostOf, whole, copy, num, set, isSet } from "../runtime/values.mjs";

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

// A check the compiler must make that would pass its budget (§15.1): compilation stops with S602 at `node`.
export class AnalysisLimit extends Error {
  constructor(check, budget, node) {
    super(`compiler analysis limit exceeded: ${check} would pass its budget of ${budget}`);
    this.node = node;
  }
}
// One working out's work (§15.1): each expression.
const FUEL = 100_000;
let fuel = FUEL;
const spend = () => {
  if (--fuel < 0) throw new AnalysisLimit("working out a value before the form opens", `${FUEL.toLocaleString("en")} steps`, root);
};

const faultOf = (e, f) => {
  try {
    return f();
  } catch (x) {
    if (!(x instanceof StrideFault)) throw x;
    e.knownFault = { code: x.code, message: x.message };
    return undefined;
  }
};

// `env` gives the value of a name that is known (a loop's counter in one turn). What is known (§11.1) leaves out
// fields, list items, records made with new and calls of Stride functions.
let root = null;
export function evaluate(expr, env = new Map()) {
  fuel = FUEL;
  root = expr;
  return value(expr, env, new Set());
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
      // A set and a list of its option values: the list as a set, as the engines take it (§3.6, §6.6).
      if (e.a.type?.t === "options" && e.b.type?.t === "list") return faultOf(e, () => binary(e.op, a, placed(b, e.a.type)));
      if (e.b.type?.t === "options" && e.a.type?.t === "list") return faultOf(e, () => binary(e.op, placed(a, e.b.type), b));
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
      // A call of a Stride function is not known (§11.1): the run gives its value.
      if (!native?.pure || native.internal) return undefined;
      // `sorted(l, by: …)` names a field, not a value: left to the machine.
      if (e.args.some((a) => a.kind === "named-arg" && !callee.params.some((p) => p.name === a.name))) return undefined;
      const args = e.bound.map((a) => (a.kind === "default-of" ? a.param.defaultValue ?? null : value(a, env, visiting)));
      if (args.some((v) => v === undefined)) return undefined;
      // either's values are placed as their join first, as the machine places them (§3.9).
      return faultOf(e, () => native.fn(...(e.joined ? args.map((v) => placed(v, e.joined)) : args)));
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
    case "index": {
      // An item of a known list (§6.9.2): F004 unless the position is whole and from 1 to the list's most; past the
      // items, empty.
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
