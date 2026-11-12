// What the compiler works out itself (docs/spec.md §11.1): a constant's value, a parameter's default, an
// option's printed words. This is its evaluator for them; it works on the syntax tree, before
// anything is lowered, and gives a value, or undefined for what only a run can work out.
//
// The values are the machine's (runtime/values.mjs): words, exact decimals, dates, true or false, null for
// null. A fault met on known values (dividing by zero, a native given what it cannot take) gives no value and is
// recorded on the node as `knownFault`: in a constant's value or a default it is mistake S413 (§11.3).
import { NATIVES } from "../runtime/natives.mjs";
import { binary, unary } from "../runtime/ops.mjs";
import { StrideFault, words as stringOf, isNull, sliced, sliceBounds, readPosition, outside, copy, set, isSet, equal, StrideTuple, StrideMap, StrideRecord, StrideSet } from "../runtime/values.mjs";

// A value placed where `type` is expected, as the machine places it (§3.6, §3.8): a list of options made the set.
function placed(v, type) {
  if (type?.t === "options" && Array.isArray(v) && !isSet(v)) return set(v, type.set.options.map((o) => o.value));
  return v;
}

// A known value placed where `type` is: what a let made of it holds (undefined when not known).
export function knownPlaced(expr, type, env = new Map()) {
  const v = evaluate(expr, env);
  return v === undefined ? undefined : placed(v, type);
}

const faultOf = (e, f) => {
  try {
    return f();
  } catch (x) {
    if (!(x instanceof StrideFault)) throw x;
    e.knownFault = { code: x.code, message: x.message };
    return undefined;
  }
};

// A value whose insides a program may change (§3.4): a map, a record, a set of any type.
const changes = (v) => v instanceof StrideMap || v instanceof StrideRecord || v instanceof StrideSet;

// `env` gives the value of a name that is known (a loop's counter in one turn). What is known (§11.1) leaves out
// fields, list items, records made with new and calls of Stride functions.
export function evaluate(expr, env = new Map()) {
  return value(expr, env, new Set());
}

function value(e, env, visiting) {
  switch (e.kind) {
    case "number":
      return e.value;
    case "bool":
      return e.value;
    case "null":
      return null;
    case "string": {
      let out = "";
      for (const p of e.parts) {
        if (typeof p === "string") out += p;
        else {
          const v = value(p, env, visiting);
          if (v === undefined) return undefined;
          out += stringOf(v);
        }
      }
      return out;
    }
    case "plain-string":
      return e.value;
    case "name": {
      const sym = e.symbol;
      if (!sym) return undefined;
      if (env.has(sym)) return env.get(sym);
      if (sym.kind === "const") {
        if (sym.known) return copy(sym.value); // a constant's own value is never the one handed out (§3.4)
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
          // A list may be changed after the let is made (§3.4): what it holds then is not known.
          return v === undefined || (Array.isArray(v) && !isSet(placed(v, sym.type))) || changes(v) ? undefined : placed(v, sym.type);
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
      // and / or decide on the left when they can, and give true or false (§6.15.1).
      if (e.op === "and" && a !== undefined && a !== true) return false;
      if (e.op === "or" && a === true) return true;
      // a ?? b works out b only when a is null (§6.16); the one it gives is placed as their join.
      if (e.op === "??" && a !== undefined && a !== null) return placed(a, e.type);
      const b = value(e.b, env, visiting);
      if (a === undefined || b === undefined) return undefined;
      // A set and a list of its option values: the list as a set, as the engines take it (§3.6, §6.6).
      if (e.a.type?.t === "options" && e.b.type?.t === "list") return faultOf(e, () => binary(e.op, a, placed(b, e.a.type)));
      if (e.b.type?.t === "options" && e.a.type?.t === "list") return faultOf(e, () => binary(e.op, placed(a, e.b.type), b));
      if (e.op === "??") return placed(b, e.type);
      return faultOf(e, () => binary(e.op, a, b));
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
      return faultOf(e, () => native.fn(...args));
    }
    case "slice": {
      // l[a..b], l[a..<b] (§6.9.3): the items a to b, or to before b.
      const l = value(e.target, env, visiting);
      const a = value(e.from, env, visiting), b = value(e.to, env, visiting);
      if (l === undefined || a === undefined || b === undefined || (l !== null && !Array.isArray(l))) return undefined;
      return faultOf(e, () => {
        const [x, y] = sliceBounds(l, a, b);
        return sliced(l, x, e.exclusive ? y - 1 : y);
      });
    }
    case "index": {
      // An item of a known list (§6.9.2): F004 unless the position is a whole number from 0 to below the count.
      const l = value(e.target, env, visiting);
      const i = value(e.index, env, visiting);
      // The value under a key of a known map, null when it has none (§6.11.1).
      if (l instanceof StrideMap) return i === undefined ? undefined : l.get(i);
      // A known tuple's value at a position written out (§6.17).
      if (l instanceof StrideTuple) return e.position ? l.items[Number(e.index.raw)] ?? null : undefined;
      if (l === undefined || i === undefined || (l !== null && !Array.isArray(l))) return undefined;
      return faultOf(e, () => {
        const n = readPosition(l, i);
        if (n >= l.length) throw new StrideFault("F004", outside(i, l.length));
        return l[n] ?? null;
      });
    }
    case "list": {
      const items = [];
      for (const x of e.items) {
        const v = value(x, env, visiting);
        if (v === undefined) return undefined;
        items.push(v);
      }
      return items;
    }
    case "map": {
      // A map written out (§6.11.1): its keys in order, a key written twice keeping its last value.
      const out = new StrideMap();
      for (const x of e.entries) {
        const k = value(x.key, env, visiting);
        const v = k === undefined || isNull(k) ? undefined : value(x.value, env, visiting);
        if (v === undefined) return undefined;
        out.set(placed(k, e.type?.key), placed(v, e.type?.value));
      }
      return out;
    }
    case "new": {
      // A record written out (§6.14): each field given, or its default, or what a field left out starts as.
      const decl = e.recordSymbol?.decl;
      if (!decl) return undefined;
      const fields = [];
      for (const f of decl.fields) {
        const given = e.fields.find((x) => x.name === f.name);
        const v = given ? value(given.value, env, visiting) : f.node?.default ? value(f.node.default, env, visiting) : f.type?.t === "list" ? [] : f.type?.t === "map" ? new StrideMap() : null;
        if (v === undefined) return undefined;
        fields.push(placed(v, f.type));
      }
      const out = new StrideRecord(decl.name, fields, decl.fields.map((f) => f.name));
      out.decl = decl;
      return out;
    }
    case "field": {
      // A field of a known record.
      const r = value(e.target, env, visiting);
      if (!(r instanceof StrideRecord) || e.safe || typeof e.fieldIndex !== "number") return undefined;
      return r.fields[e.fieldIndex] ?? null;
    }
    case "tuple": {
      const items = [];
      for (const x of e.items) {
        const v = value(x, env, visiting);
        if (v === undefined) return undefined;
        items.push(v);
      }
      return new StrideTuple(items);
    }
    case "match-expr": {
      // The value of the first arm one of whose values equals the subject; of `else`; or null (§6.18).
      const s = value(e.subject, env, visiting);
      if (s === undefined) return undefined;
      for (const arm of e.arms) {
        if (!arm.values) return value(arm.value, env, visiting);
        for (const v of arm.values) {
          const k = value(v, env, visiting);
          if (k === undefined) return undefined;
          if (equal(k, s)) return value(arm.value, env, visiting);
        }
      }
      return null;
    }
    case "cond": {
      const c = value(e.condition, env, visiting);
      return c === undefined ? undefined : value(c === true ? e.yes : e.no, env, visiting);
    }
    default:
      return undefined;
  }
}
