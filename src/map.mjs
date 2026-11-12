// `stride map` (docs/spec.md §17.6.1): each question the program asks, under its key or its key's pattern, and the
// boxes its answer goes into; the boxes written from no answer; those a name worked out as the program runs may
// be; and those not written.
//
// It follows the program as it is lowered (ir.mjs), each function once for each way it is called: the key its
// questions have there (a call named `as "home"` and one named `as "mail"` ask under their own names), the values
// the compiler knows of its arguments (a box's name given to a helper), and which answers each argument is made of.
// A box named by what a Stride function returns is each name its returns may give, worked out on the syntax tree
// from what the call gives it.
// A question asked in a loop has its key's pattern: `qty[…]` stands for each turn's key. What the map says is said
// for the reader; nothing in it is checked (form.mjs checks the boxes a program names, §10.3).
//
// An answer goes into a box when the write's value, its condition or its button is made of it, through lets,
// records' fields, lists, the functions called and what they return; or when the write stands inside an `if`, a
// `match` or a loop that the answer decides. An answer decides what is asked when a question stands inside such a
// branch, or when another question's words, default or place are made of it.
import { stringOf } from "../runtime/natives.mjs";
import { evaluate } from "./constant.mjs";
import * as V from "../runtime/values.mjs";

const HOLE = { hole: "…", re: "[^]*?" }; // a part of a key or a name worked out as the program runs
const NUMBER = { hole: "", re: "(?:#\\d+)?" }; // the #2 of a second call there, or of an item there twice
const MOST_INVOCATIONS = 20000;
const MOST_TURNS = 2000;
const MOST_CANDIDATES = 500;

// ----- what the compiler knows: values made of constants, loop items and the arguments of a call

// A value the compiler knows to be one of a few, but not which: a name's in a loop over what only the run knows (a
// turn's position in `l[..<5]`, an item of a constant table zipped with answers), or an argument made of such.
class Possible {
  constructor(values) {
    this.values = values;
  }
}
const isPossible = (v) => v instanceof Possible;

// The lets whose value the program changes after making it: what they hold is not their value.
const changedLets = new WeakSet();
// A let made once, of a value it keeps: what it stands for is its value.
const letOf = (sym) => (sym?.kind === "let" && sym.branches?.length === 1 && sym.node?.value && !changedLets.has(sym) ? sym : null);
// A call of a Stride function: the function's symbol, its parameters and its syntax tree.
const strideCallee = (e) => (e?.kind === "call" && e.callee?.kind === "function" && Array.isArray(e.callee.node?.body) ? e.callee : null);
// The parts of a syntax tree that are not its expressions.
const NOT_EXPRESSIONS = new Set(["span", "opSpan", "type", "symbol", "callee", "itemSymbol", "indexSymbol", "recordSymbol", "param", "written", "writtenValue", "knownFault", "decl", "declaredType", "sameAs"]);
function* childrenOf(e) {
  for (const [k, v] of Object.entries(e)) {
    if (NOT_EXPRESSIONS.has(k) || !v || typeof v !== "object") continue;
    if (Array.isArray(v)) {
      for (const x of v) if (x && typeof x === "object") yield x;
    } else yield v;
  }
}
// Each name an expression reads, outside the functions written in it.
function* namesIn(e, seen = new Set()) {
  if (!e || typeof e !== "object" || seen.has(e) || seen.size > 5000 || e.kind === "lambda") return;
  seen.add(e);
  if (e.kind === "name") yield e;
  for (const x of childrenOf(e)) yield* namesIn(x, seen);
}

function known(e, env) {
  if (!e || typeof e !== "object") return true;
  switch (e.kind) {
    case "number":
    case "bool":
    case "null":
    case "plain-string":
      return true;
    case "string":
      return e.parts.every((p) => typeof p === "string" || known(p, env));
    case "name":
      return !e.functionValue && !!e.symbol && (env.has(e.symbol) ? !isPossible(env.get(e.symbol)) : e.symbol.kind === "const" || e.symbol.kind === "enum");
    case "unary":
      return known(e.operand, env);
    case "binary":
      return known(e.a, env) && known(e.b, env);
    case "call":
      return e.callee?.kind === "native" && e.args.every((a) => known(a.kind === "named-arg" ? a.value : a, env));
    case "slice":
      return known(e.target, env) && known(e.from, env) && known(e.to, env);
    case "index":
      return known(e.target, env) && known(e.index, env);
    case "field":
      return !e.optionLabel && known(e.target, env);
    case "list":
    case "tuple":
      return e.items.every((x) => known(x, env));
    case "map":
      return e.entries.every((x) => known(x.key, env) && known(x.value, env));
    case "new":
      return e.fields.every((f) => known(f.value, env));
    case "cond":
      return known(e.condition, env) && known(e.yes, env) && known(e.no, env);
    case "match-expr":
      return known(e.subject, env) && e.arms.every((a) => (a.values ?? []).every((v) => known(v, env)) && known(a.value, env));
    default:
      return false;
  }
}
const evaluated = (e, env) => {
  try {
    return evaluate(e, env);
  } catch {
    return undefined;
  }
};
// Whether an expression reads what the evaluator leaves to the run but the map can work out: a let, a call of a
// Stride function, a comprehension.
const workableMemo = new WeakMap();
function workable(e, depth = 0) {
  if (!e || typeof e !== "object" || depth > 60 || e.kind === "lambda") return false;
  if (workableMemo.has(e)) return workableMemo.get(e);
  let out = (e.kind === "name" && !!letOf(e.symbol)) || !!strideCallee(e) || e.kind === "comprehension";
  if (!out) {
    for (const x of childrenOf(e)) {
      if (workable(x, depth + 1)) {
        out = true;
        break;
      }
    }
  }
  workableMemo.set(e, out);
  return out;
}
const valueIn = (e, env) => {
  if (known(e, env)) return evaluated(e, env);
  if (!workable(e)) return undefined;
  const p = prepared(e, env);
  return known(p.e, p.env) ? evaluated(p.e, p.env) : undefined;
};
// The expression with the env the evaluator can work it out in: each let the compiler knows the value of given it,
// each call of a Stride function and each comprehension whose value it knows put in as a name of that value.
function prepared(e, env) {
  const out = new Map(env);
  const done = new Map();
  const go = (x, depth) => {
    if (!x || typeof x !== "object" || depth > 60) return x;
    if (done.has(x)) return done.get(x);
    const y = goOnce(x, depth);
    done.set(x, y);
    return y;
  };
  const goOnce = (x, depth) => {
    if (Array.isArray(x)) {
      const ys = x.map((y) => go(y, depth + 1));
      return ys.some((y, i) => y !== x[i]) ? ys : x;
    }
    if (x.kind === "lambda") return x;
    if (x.kind === "name") {
      const sym = letOf(x.symbol);
      if (sym && !out.has(sym)) {
        const v = valueIn(sym.node.value, out);
        if (v !== undefined) out.set(sym, v);
      }
      return x;
    }
    if (strideCallee(x) || x.kind === "comprehension") {
      const v = strideCallee(x) ? callValue(x, out) : comprehensionValue(x, out);
      if (v === undefined) return x;
      const sym = { kind: "worked-out", name: "" };
      out.set(sym, v);
      return { kind: "name", name: "", symbol: sym, span: x.span };
    }
    let copy = null;
    for (const [k, v] of Object.entries(x)) {
      if (NOT_EXPRESSIONS.has(k) || !v || typeof v !== "object") continue;
      const y = go(v, depth + 1);
      if (y !== v) (copy ??= { ...x })[k] = y;
    }
    return copy ?? x;
  };
  const ready = go(e, 0);
  return { e: ready, env: out };
}
// [v for n, x in l if c]: its items, when the compiler knows the list and each value.
function comprehensionValue(e, env) {
  if (e.asMap || !e.itemSymbol) return undefined;
  let l = valueIn(e.list, env);
  if (l instanceof V.StrideRange) l = Number(stringOf(l.count)) > MOST_TURNS ? undefined : l.items;
  if (!Array.isArray(l) || l.length > MOST_TURNS) return undefined;
  const out = [];
  for (let i = 0; i < l.length; i++) {
    const t = new Map(env).set(e.itemSymbol, l[i]);
    if (e.indexSymbol) t.set(e.indexSymbol, V.num(i));
    if (e.condition) {
      const c = valueIn(e.condition, t);
      if (c === undefined) return undefined;
      if (c !== true) continue;
    }
    const v = valueIn(e.value, t);
    if (v === undefined) return undefined;
    if (e.nested) {
      if (!Array.isArray(v)) return undefined;
      out.push(...v);
    } else out.push(v);
  }
  return out;
}
// Its value in each env, or undefined when any is not known.
function knownIn(e, envs) {
  if (!e || !envs?.length) return undefined;
  const out = [];
  for (const env of envs) {
    const v = valueIn(e, env);
    if (v === undefined) return undefined;
    out.push(v);
  }
  return out;
}
const wordsOfValue = (v) => (V.isNull(v) ? "" : stringOf(v));
const distinct = (vs) => [...new Map(vs.map((v) => [signature(v), v])).values()];

// ----- what a call of a Stride function gives: each value its returns may have, given what is known of its arguments

const calling = []; // the functions being worked out, one inside another
const MOST_DEPTH = 8;
const callMemo = new WeakMap(); // function -> what its arguments are -> what it gives

// What the function's parameters are at the call: a value, a few it may be, or nothing known.
function callStart(call, env) {
  const fn = strideCallee(call);
  const bound = call.bound ?? call.args;
  const start = new Map();
  (fn.params ?? []).forEach((p, i) => {
    const a = bound[i];
    if (!a) return;
    if (a.kind === "default-of") {
      const v = a.param.defaultExpr ? valueIn(a.param.defaultExpr, new Map()) : a.param.defaultValue ?? null;
      if (v !== undefined) start.set(p, v);
      return;
    }
    const xs = possible(a.kind === "named-arg" ? a.value : a, env);
    if (xs?.length === 1) start.set(p, xs[0]);
    else if (xs?.length) start.set(p, new Possible(xs));
  });
  return start;
}
const returnsOf = (fn) => {
  if (fn.mapReturns) return fn.mapReturns;
  const out = [];
  const walk = (list) => {
    for (const s of list ?? []) {
      if (!s || typeof s !== "object") continue;
      if (s.kind === "function") continue;
      if (s.kind === "return" && s.value) out.push(s);
      for (const k of ["then", "otherwise", "final", "body"]) if (Array.isArray(s[k])) walk(s[k]);
      for (const a of s.arms ?? []) walk(a.body);
    }
  };
  walk(fn.node.body);
  fn.mapReturns = out;
  return out;
};
// What each of the function's returns gives, by `how` (possible or shapes), in each way it is reached; undefined
// when any is not known.
function callGives(call, env, how) {
  const fn = strideCallee(call);
  if (!fn || calling.includes(fn) || calling.length >= MOST_DEPTH) return undefined;
  const start = callStart(call, env);
  const memoKey = `${how.name}|${[...start].map(([k, v]) => `${k.name}=${signature(v)}`).join("&")}`;
  if (!callMemo.has(fn)) callMemo.set(fn, new Map());
  const memo = callMemo.get(fn);
  if (memo.has(memoKey)) return memo.get(memoKey);
  calling.push(fn);
  let out = [];
  try {
    const returns = returnsOf(fn);
    const envs = returns.length ? statementEnvs(fn.node.body, [start]) : null;
    for (const r of returns) {
      for (const e of envs.get(r) ?? [start]) {
        const xs = how(r.value, e);
        if (!xs) {
          out = undefined;
          break;
        }
        out.push(...xs);
        if (out.length > MOST_CANDIDATES) {
          out = undefined;
          break;
        }
      }
      if (!out) break;
    }
    if (out && !out.length) out = undefined;
  } finally {
    calling.pop();
  }
  if (out && how === possible) out = distinct(out);
  memo.set(memoKey, out);
  return out;
}
// The value of a call, when each way it may go gives the same one.
function callValue(call, env) {
  const xs = callGives(call, env, possible);
  return xs?.length === 1 ? xs[0] : undefined;
}

// The values an expression may have when the compiler cannot tell which: those of the names it knows only to be one
// of a few, each way they may be; the items of a constant list or the values of a constant map it reads at a
// position worked out as the program runs, a field of each, either value of an `if … then … else`, an option of the
// name's type, what a Stride function called returns; undefined when it cannot tell.
function possible(e, env) {
  const v = valueIn(e, env);
  if (v !== undefined) return [v];
  const ways = eachWay(e, env);
  if (ways) {
    const out = [];
    for (const w of ways) {
      const x = valueIn(e, w);
      if (x === undefined) {
        out.length = 0;
        break;
      }
      out.push(x);
    }
    if (out.length) return distinct(out);
  }
  switch (e?.kind) {
    case "name": {
      const x = env.get(e.symbol);
      if (isPossible(x)) return x.values;
      const sym = letOf(e.symbol);
      if (sym && !env.has(sym)) return possible(sym.node.value, env);
      const type = e.symbol?.type ?? e.type;
      return type?.t === "option" && !env.has(e.symbol) ? type.set.options.map((o) => o.value) : undefined;
    }
    case "index": {
      const t = possible(e.target, env);
      if (!t) return undefined;
      const out = [];
      for (const x of t) {
        if (x instanceof V.StrideMap) out.push(...x.pairs.map(([, y]) => y));
        else if (x instanceof V.StrideTuple && e.position) out.push(x.items[Number(e.index.raw)] ?? null);
        else if (Array.isArray(x)) out.push(...x);
        else return undefined;
      }
      return out;
    }
    case "field": {
      const t = possible(e.target, env);
      if (!t || e.fieldIndex === undefined) return undefined;
      return t.every((x) => x instanceof V.StrideRecord) ? t.map((x) => x.fields[e.fieldIndex]) : undefined;
    }
    case "cond": {
      const a = possible(e.yes, env), b = possible(e.no, env);
      return a && b ? [...a, ...b] : undefined;
    }
    case "binary": {
      if (e.op !== "??") return undefined;
      const a = possible(e.a, env), b = possible(e.b, env);
      return a && b ? [...a, ...b] : undefined;
    }
    case "match-expr": {
      const out = [];
      for (const a of e.arms) {
        const x = possible(a.value, env);
        if (!x) return undefined;
        out.push(...x);
      }
      return out;
    }
    case "string": {
      let out = [""];
      for (const p of e.parts) {
        const xs = typeof p === "string" ? [p] : possible(p, env)?.map(wordsOfValue);
        if (!xs) return undefined;
        out = out.flatMap((a) => xs.map((b) => a + b));
        if (out.length > MOST_CANDIDATES) return undefined;
      }
      return out;
    }
    case "call": {
      if (strideCallee(e)) return callGives(e, env, possible);
      if (e.callee?.kind !== "native" || e.callee.name !== "get") return undefined;
      const [l, , d] = e.bound ?? e.args;
      const items = possible({ kind: "index", target: l, index: null }, env);
      const other = d && d.kind !== "default-of" ? possible(d, env) : [null];
      return items && other ? [...items, ...other] : undefined;
    }
    default:
      return undefined;
  }
}
// The envs of each way the names an expression reads, itself or through its lets, may be, when some are known only
// to be one of a few; undefined when none is, or there are too many ways.
function eachWay(e, env) {
  const few = new Map();
  const seen = new Set();
  const look = (x) => {
    for (const n of namesIn(x)) {
      if (seen.has(n.symbol)) continue;
      seen.add(n.symbol);
      const v = env.get(n.symbol);
      if (isPossible(v)) few.set(n.symbol, v.values);
      else if (!env.has(n.symbol) && letOf(n.symbol)) look(n.symbol.node.value);
    }
  };
  look(e);
  if (!few.size) return undefined;
  let ways = [new Map(env)];
  for (const [sym, values] of few) {
    if (ways.length * values.length > MOST_CANDIDATES) return undefined;
    ways = ways.flatMap((w) => values.map((v) => new Map(w).set(sym, v)));
  }
  return ways;
}
const isWords = (v) => v === null || typeof v === "string" || typeof v === "boolean" || V.isNumber(v) || V.isDate(v) || V.isNull(v);
// A box's name as far as the compiler can tell it: each name it may be, as words with a hole where only the run
// decides; undefined when even that cannot be told.
function shapes(e, env) {
  const xs = possible(e, env);
  if (xs) return xs.every(isWords) ? xs.map((v) => [wordsOfValue(v)]) : undefined;
  const either = (...ys) => (ys.every(Boolean) ? ys.flat() : undefined);
  const product = (lists) => {
    let out = [[]];
    for (const l of lists) {
      if (!l) return undefined;
      out = out.flatMap((a) => l.map((b) => [...a, ...b]));
      if (out.length > MOST_CANDIDATES) return undefined;
    }
    return out;
  };
  switch (e?.kind) {
    case "string":
      return product(e.parts.map((p) => (typeof p === "string" ? [[p]] : shapes(p, env))));
    case "cond":
      return either(shapes(e.yes, env), shapes(e.no, env));
    case "binary":
      if (e.op === "??") return either(shapes(e.a, env), shapes(e.b, env));
      if (e.op === "+" && e.type?.t === "string") return product([shapes(e.a, env), shapes(e.b, env)]);
      return [[HOLE]];
    case "match-expr":
      return either(...e.arms.map((a) => shapes(a.value, env)));
    case "name": {
      const sym = letOf(e.symbol);
      return sym && !env.has(sym) ? shapes(sym.node.value, env) : [[HOLE]];
    }
    case "call":
      return strideCallee(e) ? callGives(e, env, shapes) ?? [[HOLE]] : [[HOLE]];
    default:
      return [[HOLE]];
  }
}

// The values a function's statements see of the names the compiler knows, given what its parameters are (one Map
// per way it is reached: each turn of a loop over what the compiler knows). Inside a loop over what only the run
// knows, its names are not known, and the others are as around it. Every statement of the syntax tree is given its
// own.
function statementEnvs(body, start) {
  const out = new Map(); // statement -> [Map] | null
  const children = (s) => {
    switch (s.kind) {
      case "if":
        return [s.then, s.otherwise];
      case "try":
        return [s.then, s.otherwise, s.final ?? []];
      case "match":
        return s.arms.map((a) => a.body);
      case "while":
      case "collect":
        return [s.body];
      default:
        return [];
    }
  };
  const rangeTurns = (s, env) => {
    const a = valueIn(s.from, env), b = valueIn(s.to, env);
    if (!s.symbol || !V.isNumber(a) || !V.isNumber(b)) return null;
    const from = Number(stringOf(a)), to = Number(stringOf(b)) - (s.exclusive ? 1 : 0);
    if (!Number.isInteger(from) || !Number.isInteger(to) || to - from > MOST_TURNS) return null;
    const turns = [];
    for (let i = from; i <= to; i++) turns.push(new Map(env).set(s.symbol, V.num(i)));
    return turns;
  };
  const eachTurns = (s, env) => {
    const l = s.itemSymbol ? valueIn(s.list, env) : undefined;
    if (l === undefined || l === null) return null;
    const turns = [];
    const turn = (index, item) => {
      const t = new Map(env).set(s.itemSymbol, item);
      if (s.indexSymbol) t.set(s.indexSymbol, index);
      turns.push(t);
    };
    if (l instanceof V.StrideMap) for (const [k, v] of l.pairs) s.indexSymbol ? turn(k, v) : turn(null, k);
    else if (V.isSet(l) || Array.isArray(l)) l.forEach((x, i) => turn(V.num(i), x));
    else if (l instanceof V.StrideSet) l.items.forEach((x, i) => turn(V.num(i), x));
    else if (typeof l === "string") [...l].forEach((c, i) => turn(V.num(i), c));
    else if (l instanceof V.StrideRange && Number(stringOf(l.count)) <= MOST_TURNS) l.items.forEach((x, i) => turn(V.num(i), x));
    else return null;
    return turns.length > MOST_TURNS ? null : turns;
  };
  // A loop over what only the run knows: the items and positions its names may have, when the compiler knows them.
  const loopNames = (s, hidden, env) => {
    const t = new Map(env);
    const put = (sym, xs) => sym && xs?.length && xs.length <= MOST_CANDIDATES && t.set(sym, new Possible(distinct(xs)));
    const { items, indices, positions } = itemsOf(s.list, env, !!s.indexSymbol) ?? {};
    put(s.itemSymbol, items);
    put(s.indexSymbol, indices);
    hidden.forEach((x, i) => put(x.symbol, positions?.[i] ?? possible(x.value, t)));
    return t;
  };
  const walk = (list, envs) => {
    for (const s of list ?? []) {
      if (!s || typeof s !== "object") continue;
      out.set(s, envs);
      if (s.kind === "for-each" || s.kind === "for") {
        let inner = [];
        for (const env of envs) {
          const turns = s.kind === "for" ? rangeTurns(s, env) : eachTurns(s, env);
          if (!turns || inner.length + turns.length > MOST_TURNS) {
            inner = null;
            break;
          }
          inner.push(...turns);
        }
        const hidden = s.destructure ? s.body.filter((b) => b.kind === "let" && b.hidden && b.symbol) : [];
        // `for (a, b) in l`: its names are hidden lets made of the item (§7.11.2).
        if (inner) {
          for (const x of hidden) {
            for (const env of inner) {
              const v = valueIn(x.value, env);
              if (v !== undefined) env.set(x.symbol, v);
            }
          }
        } else inner = s.kind === "for-each" ? envs.map((env) => loopNames(s, hidden, env)) : envs;
        walk(s.body, inner);
        continue;
      }
      for (const c of children(s)) walk(c, envs);
    }
  };
  walk(Array.isArray(body) ? body : [], start);
  return out;
}

// What a loop over a list may go through: the items it may have, the positions of its turns (of `l[..<5]`, 0 to 4,
// whatever l is), and for `zip(a, b)` the items of each list; undefined when the compiler knows none of them.
function itemsOf(e, env, keyed) {
  const ls = possible(e, env);
  if (ls) {
    const items = [], indices = [];
    for (const l of ls) {
      if (l instanceof V.StrideMap) for (const [k, v] of l.pairs) keyed ? (indices.push(k), items.push(v)) : items.push(k);
      else if (Array.isArray(l)) l.forEach((x, i) => (items.push(x), indices.push(V.num(i))));
      else if (l instanceof V.StrideSet) l.items.forEach((x, i) => (items.push(x), indices.push(V.num(i))));
      else if (l instanceof V.StrideRange && Number(stringOf(l.count)) <= MOST_TURNS) l.items.forEach((x, i) => (items.push(x), indices.push(V.num(i))));
      else return undefined;
      if (items.length > MOST_TURNS) return undefined;
    }
    return { items, indices };
  }
  if (e?.kind === "slice") {
    const from = e.from ? valueIn(e.from, env) : V.num(0);
    const to = e.to ? valueIn(e.to, env) : undefined;
    let indices;
    if (V.isNumber(from) && V.isNumber(to)) {
      const a = Number(stringOf(from)), b = Number(stringOf(to));
      const n = b - a + (e.exclusive ? 0 : 1);
      if (Number.isInteger(n) && a >= 0 && n >= 0 && n <= MOST_TURNS) indices = Array.from({ length: n }, (_, i) => V.num(i));
    }
    const items = itemsOf(e.target, env, false)?.items;
    return items || indices ? { items, indices } : undefined;
  }
  if (e?.kind === "call" && (e.callee?.kind === "native" || e.callee?.unit?.std) && e.callee.name === "zip") {
    const [a, b] = (e.bound ?? e.args).map((x) => itemsOf(x, env, false));
    return a || b ? { positions: [a?.items, b?.items], indices: a?.indices ?? b?.indices } : undefined;
  }
  return undefined;
}

// A value's signature, for telling apart the ways a function is called.
function signature(v) {
  if (isPossible(v)) return `?[${v.values.map(signature).join(",")}]`;
  if (V.isNull(v)) return "n";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "t" : "f";
  if (V.isNumber(v) || V.isDate(v)) return `#${stringOf(v)}`;
  if (v instanceof V.StrideMap) return `{${v.pairs.map(([k, x]) => `${signature(k)}:${signature(x)}`).join(",")}}`;
  if (v instanceof V.StrideRecord) return `${v.type}(${v.fields.map(signature).join(",")})`;
  if (v instanceof V.StrideSet) return `s[${v.items.map(signature).join(",")}]`;
  if (v instanceof V.StrideTuple) return `(${(v.items ?? []).map(signature).join(",")})`;
  if (Array.isArray(v)) return `[${v.map(signature).join(",")}]`;
  return String(v);
}

// ----- which answers a value is made of: the answers of the whole value, and of each of its fields

class Made {
  constructor() {
    this.deps = new Set();
    this.fields = new Map();
  }
}
const NOTHING = new Made();
const flat = (m, out = new Set()) => {
  for (const d of m.deps) out.add(d);
  for (const f of m.fields.values()) flat(f, out);
  return out;
};
const ofDeps = (deps) => {
  const m = new Made();
  for (const d of deps) m.deps.add(d);
  return m;
};
// Puts what `from` is made of into `into`; whether that added anything. Fields deeper than a few levels (a record
// that holds itself) are taken as the whole value's.
const DEEPEST = 6;
function join(into, from, depth = 0) {
  let changed = false;
  if (depth >= DEEPEST) {
    for (const d of flat(from)) if (!into.deps.has(d)) (into.deps.add(d), (changed = true));
    return changed;
  }
  for (const d of from.deps) if (!into.deps.has(d)) (into.deps.add(d), (changed = true));
  for (const [name, f] of [...from.fields]) {
    if (!into.fields.has(name)) (into.fields.set(name, new Made()), (changed = true));
    changed = join(into.fields.get(name), f, depth + 1) || changed;
  }
  return changed;
}
const merged = (...ms) => {
  const out = new Made();
  for (const m of ms) join(out, m);
  return out;
};
const fieldOf = (m, name) => {
  const f = m.fields.get(name);
  if (!f) return m.deps.size ? ofDeps(m.deps) : NOTHING;
  const out = new Made();
  join(out, f);
  for (const d of m.deps) out.deps.add(d);
  return out;
};
const sigOf = (m) => `${[...m.deps].map((d) => d.id).sort((a, b) => a - b).join(",")}${m.fields.size ? `{${[...m.fields].map(([k, f]) => `${k}:${sigOf(f)}`).join(";")}}` : ""}`;

// Natives that change their first argument itself (§14.4), and those whose value is their first argument's items.
const CHANGES = new Set(["append", "insert", "remove_at", "clear", "remove", "add"]);
const ITEMS = new Set(["each_of", "get", "copy", "need", "set_items", "sorted", "sorted_by", "reversed", "filled", "first", "last", "values", "append", "insert", "remove_at", "remove", "add", "unique", "flat", "to_set"]);

// ----- a function's blocks: which blocks each branch decides, which call comes before which

function shapeOf(fn) {
  if (fn.shape) return fn.shape;
  const order = fn.order();
  const index = new Map(order.map((b, i) => [b, i]));
  const exits = order.filter((b) => !b.successors.length);
  // Post-dominators: the blocks every way from a block to the function's end goes through.
  const all = new Set(order);
  const pdom = new Map(order.map((b) => [b, exits.includes(b) ? new Set([b]) : new Set(all)]));
  for (let changed = true; changed; ) {
    changed = false;
    for (const b of [...order].reverse()) {
      if (exits.includes(b)) continue;
      let meet = null;
      for (const s of b.successors) {
        const p = pdom.get(s);
        if (!p) continue;
        meet = meet ? new Set([...meet].filter((x) => p.has(x))) : new Set(p);
      }
      meet = meet ?? new Set();
      meet.add(b);
      if (meet.size !== pdom.get(b).size) (pdom.set(b, meet), (changed = true));
    }
  }
  // Dominators: the blocks every way from the start to a block goes through.
  const preds = fn.predecessors();
  const dom = new Map(order.map((b) => [b, b === fn.entry ? new Set([b]) : new Set(all)]));
  for (let changed = true; changed; ) {
    changed = false;
    for (const b of order) {
      if (b === fn.entry) continue;
      let meet = null;
      for (const p of preds.get(b) ?? []) {
        const d = dom.get(p);
        if (!d) continue;
        meet = meet ? new Set([...meet].filter((x) => d.has(x))) : new Set(d);
      }
      meet = meet ?? new Set();
      meet.add(b);
      if (meet.size !== dom.get(b).size) (dom.set(b, meet), (changed = true));
    }
  }
  // The blocks a branch decides whether they run: those reached from it before a block every way from it reaches.
  const decidedBy = new Map(order.map((b) => [b, []])); // block -> the branching blocks that decide it
  const regions = new Map(); // branching block -> the blocks it decides
  for (const b of order) {
    if (b.term?.op !== "branch" || b.term.yes === b.term.no) continue;
    const stop = pdom.get(b);
    const seen = new Set();
    const go = (x) => {
      if (seen.has(x) || (x !== b && stop.has(x))) return;
      seen.add(x);
      for (const s of x.successors) go(s);
    };
    for (const s of b.successors) go(s);
    for (const x of seen) decidedBy.get(x)?.push(b);
    regions.set(b, seen);
  }
  // Which blocks a block reaches.
  const reach = new Map();
  const reaches = (a) => {
    if (reach.has(a)) return reach.get(a);
    const seen = new Set();
    const go = (x) => {
      for (const s of x.successors) if (!seen.has(s)) (seen.add(s), go(s));
    };
    go(a);
    reach.set(a, seen);
    return seen;
  };
  // A branch that decides whether a question is asked, or a function called that can ask one.
  const asking = new Set([...regions].filter(([, blocks]) => [...blocks].some((x) => statementsOf(x).some((s) => s.op === "ask" || expressionsOf(s).some((e) => [...callsIn(e)].some((c) => canAsk(c.fn)))))).map(([b]) => b));
  fn.shape = { order, index, decidedBy, dom, reaches, asking };
  return fn.shape;
}

function* callsIn(x) {
  if (!x || typeof x !== "object") return;
  if (x.e === "call") yield x;
  for (const [k, v] of Object.entries(x)) {
    if (k === "node") continue;
    if (Array.isArray(v)) for (const y of v) yield* callsIn(y);
    else if (v && typeof v === "object" && v.e) yield* callsIn(v);
  }
}
// Whether a function asks a question, or calls one that can.
function canAsk(fn, seen = new Set()) {
  if (!fn?.blocks) return false;
  if (fn.asks !== undefined) return fn.asks;
  if (seen.has(fn)) return false;
  seen.add(fn);
  const out = fn.blocks.some((b) => statementsOf(b).some((s) => s.op === "ask" || expressionsOf(s).some((e) => [...callsIn(e)].some((c) => canAsk(c.fn, seen)))));
  if (seen.size === 1) fn.asks = out;
  return out;
}
// The segment a call adds to its questions' keys (§8.6.2): call_key of the words before its number.
const segmentOf = (c) => (c.args[0]?.e === "concat" && c.args[0].parts[0]?.e === "native" && c.args[0].parts[0].name === "call_key" ? c.args[0].parts[0] : null);
const statementsOf = (b) => [...b.stmts, ...(b.term ? [b.term] : [])];
const expressionsOf = (s) => [s.value, s.cond, s.box, s.button, s.key, s.printed, s.default, s.message, ...(s.path ?? []).map((p) => p.index)].filter(Boolean);

// ----- the map

export function mapOf(program, header, resolved) {
  const prefix = program.prefix;
  const byField = new Map();
  for (const b of header?.boxes ?? []) if (!byField.has(b.field)) byField.set(b.field, b);
  const kinds = { fill: ["text", "choice"], tick: ["check"], pick: ["radio", "check"] };
  const fits = (op, full) => byField.has(full) && kinds[op].includes(byField.get(full).kind);

  const questions = new Map(); // key as shown -> { key, re, printed, order, boxes: Map box -> direct, decides, intoNamed, q }
  const sources = new Map(); // ask statement \t key -> source { id, entry, s, fn }
  const written = new Set(); // the boxes written by a name the compiler knows, in this invocation's terms
  const linked = new Set(); // the boxes some answer goes into
  const candidates = new Set(); // the boxes a name worked out as the program runs may be
  let somewhere = false; // a write whose box the compiler cannot tell at all
  const mainEnv = new Map(); // the program's own names, which functions read and change (§9.1)
  let mainVersion = 0;
  const memo = new Map();
  let invocations = 0;
  // The lets the program changes after making them: a field or an item given a value, a native that changes it.
  const rootOf = (x) => {
    while (x && (x.kind === "field" || x.kind === "index")) x = x.target;
    return x?.kind === "name" ? x.symbol : null;
  };
  const scanned = new Set();
  const scan = (x) => {
    if (!x || typeof x !== "object" || scanned.has(x)) return;
    scanned.add(x);
    if (Array.isArray(x)) return x.forEach(scan);
    if (x.kind === "assign" && x.target?.kind !== "name") changedLets.add(rootOf(x.target) ?? {});
    if (x.kind === "call" && x.callee?.kind === "native" && CHANGES.has(x.callee.name)) changedLets.add(rootOf((x.bound ?? x.args)?.[0]) ?? {});
    for (const y of childrenOf(x)) scan(y);
  };
  scan(resolved?.mainResult?.main);
  for (const fn of program.functions) scan(fn.source?.node?.body);
  const astOf = (fn) => (fn === program.main ? resolved?.mainResult?.main : fn.source?.node?.body);

  const shown = (parts) => parts.map((p) => (typeof p === "string" ? p : p.hole)).join("").replace(/…(…)+/g, "…");
  const pattern = (parts) => new RegExp(`^${parts.map((p) => (typeof p === "string" ? p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : p.re)).join("")}$`);

  // A key, a printed question or a box's name as the compiler knows it: its words, a hole where the run decides.
  const partsOf = (x, inv, n = null) => {
    if (!x) return [HOLE];
    switch (x.e) {
      case "const":
        return [wordsOfValue(x.v)];
      case "concat":
        return x.parts.flatMap((p) => partsOf(p, inv, n));
      case "local":
        return inv.words.get(x.l) ?? [HOLE];
      case "native":
        if (x.name === "call_key") {
          const base = partsOf(x.args[0], inv);
          return [...base, ...(base.every((p) => typeof p === "string") ? (n > 1 ? [`#${n}`] : []) : [NUMBER])];
        }
        if (x.name === "turn_key") return ["[", HOLE, "]", NUMBER];
        return [HOLE];
      default:
        return [HOLE];
    }
  };

  const sourceOf = (s, inv, order) => {
    const parts = partsOf(s.key, inv);
    const key = shown(parts);
    const id = `${s.q.node?.span?.start}\t${s.q.name}\t${key}`;
    if (sources.has(id)) return sources.get(id);
    let entry = questions.get(key);
    if (!entry) {
      const astEnvs = inv.envs.get(s.node);
      const said = knownIn(s.node?.printed, astEnvs)?.map(wordsOfValue);
      const printed = said && new Set(said).size === 1 ? said[0] : shown(partsOf(s.printed, inv)).replace(/^…$/, "");
      entry = { key, re: pattern(parts), printed, order, boxes: new Map(), decides: false, intoNamed: false, q: s.q };
      questions.set(key, entry);
    }
    const source = { id: sources.size + 1, entry, s, fn: inv.fn };
    sources.set(id, source);
    return source;
  };

  // The order questions are listed in: where each call on the way to it, and the question itself, stand.
  const placeOf = (node) => node?.span?.start ?? 0;

  // One way a function is called: the words of its key (`key`), the values the compiler knows of its arguments
  // (`envs`, the syntax tree's), what its arguments are made of (`given`), and the answers that decide whether it
  // runs (`control`: `writes`, those of branches that decide only what is written, and `asks`, of every branch).
  // Gives what its value is made of and what its arguments are made of when it ends.
  function invoke(fn, { key = null, given = [], envs = [new Map()], control = { writes: new Set(), asks: new Set() }, path = [], stack = [] }) {
    if (stack.includes(fn) || stack.length > 40 || invocations > MOST_INVOCATIONS) {
      const all = merged(...given);
      return { result: ofDeps(flat(all)), out: given };
    }
    const memoKey = `${program.functions.indexOf(fn)}|${key ? shown(key) : ""}|${given.map(sigOf).join("/")}|${envs ? envs.map((e) => [...e].map(([k, v]) => `${k.name}=${signature(v)}`).join("&")).join("|") : "?"}|${[...control.writes].map((d) => d.id).join(",")}/${[...control.asks].map((d) => d.id).join(",")}|${mainVersion}|${path.join(".")}`;
    if (memo.has(memoKey)) return memo.get(memoKey);
    invocations++;
    const shape = shapeOf(fn);
    const inv = { fn, words: new Map(), envs: statementEnvs(astOf(fn), envs), env: fn === program.main ? mainEnv : new Map() };
    if (fn.keyed && fn.params.length >= 2) (inv.words.set(fn.params[0], key ?? [HOLE]), inv.words.set(fn.params[1], [""]));
    const offset = fn.keyed ? 2 : 0;
    fn.params.forEach((l, i) => i >= offset && given[i - offset] && inv.env.set(l, merged(given[i - offset])));
    const result = new Made();
    const decided = new Map(); // branching block -> what its condition is made of

    // The calls of functions that ask, in order, and how many calls with the same key may come before each (§8.6.2).
    const sites = new Map(); // call expression -> [n, …]
    const listed = [];
    shape.order.forEach((b, bi) =>
      statementsOf(b).forEach((s, si) => {
        let xi = 0;
        for (const x of expressionsOf(s)) for (const c of callsIn(x)) if (c.fn?.keyed && segmentOf(c)) listed.push({ c, b, at: [bi, si, xi++], base: shown(partsOf(segmentOf(c).args[0], inv)) });
      }),
    );
    for (const site of listed) {
      if (site.base.includes("…")) {
        sites.set(site.c, [1]);
        continue;
      }
      const before = (d) => d.b === site.b ? d.at[1] < site.at[1] || (d.at[1] === site.at[1] && d.at[2] < site.at[2]) : null;
      let must = 0, may = 0;
      for (const d of listed) {
        if (d === site || d.base !== site.base) continue;
        const same = before(d);
        if (same === true) (must++, may++);
        else if (same === null && shape.reaches(d.b).has(site.b)) (may++, shape.dom.get(site.b)?.has(d.b) && must++);
      }
      const ns = [];
      for (let n = must + 1; n <= Math.min(may + 1, must + 6); n++) ns.push(n);
      sites.set(site.c, ns);
    }

    // A branch around a write whose answers decide only what is written credits them to the boxes; one around a
    // question, to what is asked.
    const controlOf = (b) => {
      const out = { writes: new Set(control.writes), asks: new Set(control.asks) };
      for (const x of shape.decidedBy.get(b) ?? []) {
        for (const d of decided.get(x) ?? []) {
          out.asks.add(d);
          if (!shape.asking.has(x)) out.writes.add(d);
        }
      }
      return out;
    };
    const rootOf = (x) => (x?.e === "local" ? inv.env : x?.e === "outer" ? mainEnv : null);
    const keyOfRoot = (x) => (x.e === "local" ? x.l : program.outer?.get(x.sym));
    const holder = (s) => (s.outer ? [mainEnv, program.outer?.get(s.outer)] : [inv.env, s.dst]);
    let changed = true;
    const put = (env, local, m) => {
      if (!local) return;
      if (!env.has(local)) env.set(local, new Made());
      if (join(env.get(local), m)) {
        changed = true;
        if (env === mainEnv && fn !== program.main) mainVersion++;
      }
    };
    const read = (env, local) => env.get(local) ?? NOTHING;

    const value = (x, cx) => {
      if (!x || typeof x !== "object") return NOTHING;
      switch (x.e) {
        case "const":
        case "fnref":
          return NOTHING;
        case "local":
        case "cellref":
          return read(inv.env, x.l);
        case "outer":
          return read(mainEnv, program.outer?.get(x.sym));
        case "field":
          return fieldOf(value(x.a, cx), x.name);
        case "item": {
          const a = value(x.a, cx);
          const out = merged(a);
          for (const d of flat(value(x.i, cx))) out.deps.add(d);
          return out;
        }
        case "record": {
          const out = new Made();
          x.fields.forEach((f, i) => {
            const m = value(f, cx);
            const name = x.decl?.fields?.[i]?.name ?? String(i);
            if (m.deps.size || m.fields.size) out.fields.set(name, merged(m));
          });
          return out;
        }
        case "list":
          return merged(...x.items.map((i) => value(i, cx)));
        case "cond": {
          const out = merged(value(x.yes, cx), value(x.no, cx));
          for (const d of flat(value(x.cond, cx))) out.deps.add(d);
          return out;
        }
        case "bind":
          put(inv.env, x.l, value(x.value, cx));
          return value(x.body, cx);
        case "safe":
          put(inv.env, x.l, value(x.target, cx));
          return value(x.body, cx);
        case "comp": {
          const list = value(x.list, cx);
          put(inv.env, x.item, list);
          if (x.key) put(inv.env, x.key, ofDeps(list.deps));
          const out = merged(value(x.value, cx));
          for (const d of [...list.deps, ...(x.cond ? flat(value(x.cond, cx)) : [])]) out.deps.add(d);
          return out;
        }
        case "native": {
          const args = x.args.map((a) => value(a, cx));
          if (CHANGES.has(x.name) && rootOf(x.args[0])) put(rootOf(x.args[0]), keyOfRoot(x.args[0]), merged(...args.slice(1)));
          if (ITEMS.has(x.name) && args.length) {
            const out = merged(args[0], ...(x.name === "get" && args[2] ? [args[2]] : []), ...(["append", "insert"].includes(x.name) ? [args.at(-1)] : []));
            for (const a of args.slice(1)) for (const d of flat(a)) if (x.name !== "append" && x.name !== "insert") out.deps.add(d);
            return out;
          }
          return ofDeps(new Set(args.flatMap((a) => [...flat(a)])));
        }
        case "call":
          return callOf(x, cx);
        case "callv":
        case "closure":
        default: {
          const out = new Made();
          for (const [k, v] of Object.entries(x)) {
            if (k === "node" || k === "at") continue;
            for (const y of Array.isArray(v) ? v : [v]) if (y && typeof y === "object" && y.e) for (const d of flat(value(y, cx))) out.deps.add(d);
          }
          return out;
        }
      }
    };

    const callOf = (c, cx) => {
      const callee = c.fn;
      if (!callee?.blocks) return ofDeps(new Set(c.args.flatMap((a) => [...flat(value(a, cx))])));
      const skip = callee.keyed ? 2 : 0;
      const keeps = (callee.source?.keeps ?? []).length;
      const args = c.args.slice(skip).map((a) => value(a, cx));
      // The values the compiler knows of the arguments, in each way the call is reached.
      const params = callee.source?.params ?? [];
      const bound = c.node?.bound ?? c.node?.args ?? [];
      let calleeEnvs = null;
      if (cx.envs) {
        const seen = new Map();
        for (const env of cx.envs) {
          const m = new Map();
          params.forEach((p, i) => {
            const a = bound[i];
            if (!a) return;
            if (a.kind === "default-of") {
              const v = a.param.defaultExpr ? valueIn(a.param.defaultExpr, new Map()) : a.param.defaultValue ?? null;
              if (v !== undefined) m.set(p, v);
              return;
            }
            // An argument the compiler knows only to be one of a few is that to the function.
            const x = a.kind === "named-arg" ? a.value : a;
            const v = valueIn(x, env);
            const xs = v === undefined ? possible(x, env) : null;
            if (v !== undefined) m.set(p, v);
            else if (xs?.length) m.set(p, new Possible(xs));
          });
          seen.set([...m].map(([k, v]) => `${k.name}=${signature(v)}`).join("&"), m);
          if (seen.size > 200) break;
        }
        calleeEnvs = seen.size > 200 ? [new Map()] : [...seen.values()];
      }
      const ns = callee.keyed ? sites.get(c) ?? [1] : [null];
      const result = new Made();
      for (const n of ns) {
        const key = !callee.keyed ? null : segmentOf(c) ? [...partsOf(segmentOf(c), inv, n), ...c.args[0].parts.slice(1).flatMap((p) => partsOf(p, inv))] : partsOf(c.args[0], inv);
        const r = invoke(callee, { key, given: args, envs: calleeEnvs ?? [new Map()], control: cx.control, path: [...path, placeOf(c.node)], stack: [...stack, fn] });
        join(result, r.result);
        // What a function puts into a list or a record it is given is in the caller's too.
        r.out.forEach((m, i) => {
          const a = c.args[skip + i];
          if (i >= keeps && rootOf(a) && m) put(rootOf(a), keyOfRoot(a), m);
        });
      }
      return result;
    };

    // A write: the boxes it may be, and the answers it is made of go into each.
    const write = (s, cx) => {
      // Its value, condition, button and name, and the branches around it that decide only what is written; a write
      // made of none of them is credited to every answer that decides whether it runs.
      const made = new Set([...flat(value(s.op === "fill" ? s.value : s.cond, cx)), ...(s.op === "pick" ? flat(value(s.button, cx)) : []), ...flat(value(s.box, cx)), ...cx.control.writes]);
      if (!made.size) for (const d of cx.control.asks) made.add(d);
      const node = s.node;
      let exact = null;
      let maybe = null;
      if (s.box?.e === "const") exact = [wordsOfValue(s.box.v)];
      else if (node?.box) {
        exact = knownIn(node.box, cx.envs)?.map(wordsOfValue) ?? null;
        if (!exact) {
          const all = [];
          for (const env of cx.envs ?? [new Map()]) {
            const xs = possible(node.box, env);
            if (!xs) {
              all.length = 0;
              all.push(null);
              break;
            }
            all.push(...xs.map(wordsOfValue));
          }
          if (!all.includes(null) && all.length <= MOST_CANDIDATES) maybe = [...new Set(all)];
        }
      }
      if (!exact && !maybe) {
        // What of the name the compiler knows, in each name it may be: that name, or every box of the statement's
        // kind whose name fits it.
        const ways = new Map();
        if (node?.box) {
          for (const env of cx.envs ?? [new Map()]) {
            const xs = shapes(node.box, env);
            if (!xs) {
              ways.clear();
              break;
            }
            for (const parts of xs) ways.set(shown(parts), parts);
          }
        } else ways.set("", partsOf(s.box, inv));
        const names = [];
        for (const parts of ways.values()) {
          if (parts.every((p) => typeof p === "string")) names.push(parts.join(""));
          else if (parts.filter((p) => typeof p === "string").join("").length >= 2) {
            const re = pattern([prefix, ...parts]);
            names.push(...[...byField.keys()].filter((f) => fits(s.op, f) && re.test(f)).map((f) => f.slice(prefix.length)));
          } else {
            names.length = 0;
            break;
          }
        }
        if (names.length) maybe = names;
      }
      const boxes = exact ?? maybe;
      if (!boxes) return records.push({ boxes: null, made });
      const direct = s.op === "fill" && s.value?.e === "local" ? s.value.l : null;
      records.push({ boxes: [...new Set(boxes)].map((short) => prefix + short).filter((full) => fits(s.op, full)), exact: !!exact, made: [...made].map((d) => ({ d, direct: !!direct && d.s.dst === direct && !d.s.path?.length && d.fn === fn && !!exact })) });
    };

    // Round after round until nothing changes; then once more, its writes the invocation's (records).
    let records = [];
    const pass = () => shape.order.forEach((b) => {
        const control = controlOf(b);
        for (const s of statementsOf(b)) {
          const cx = { control, envs: s.node ? inv.envs.get(s.node) ?? null : null };
          switch (s.op) {
            case "set":
            case "append": {
              const [env, local] = holder(s);
              put(env, local, value(s.value, cx));
              break;
            }
            case "store": {
              const [env, local] = holder(s);
              let m = value(s.value, cx);
              for (const p of [...s.path].reverse()) {
                const up = new Made();
                if (p.field !== undefined) up.fields.set(p.name, m);
                else {
                  join(up, m);
                  for (const d of flat(value(p.index, cx))) up.deps.add(d);
                }
                m = up;
              }
              put(env, local, m);
              break;
            }
            case "ask": {
              // A collect's "Another?" is listed after its item's questions.
              const source = sourceOf(s, inv, [...path, s.q.item && s.q.name.endsWith(".another") ? s.node?.span?.end ?? 0 : placeOf(s.node)]);
              let m = ofDeps([source]);
              for (const p of [...(s.path ?? [])].reverse()) {
                const up = new Made();
                if (p.field !== undefined) up.fields.set(p.name, m);
                else join(up, m);
                m = up;
              }
              const [env, local] = holder(s);
              put(env, local, m);
              // An answer this question's words, default or place are made of decides what is asked; so does one
              // that decides whether it is asked.
              for (const d of [...control.asks, ...flat(value(s.printed, cx)), ...(s.default ? flat(value(s.default, cx)) : []), ...(s.path ?? []).flatMap((p) => (p.index ? [...flat(value(p.index, cx))] : []))]) if (d !== source) d.entry.decides = true;
              break;
            }
            case "fill":
            case "tick":
            case "pick":
              write(s, cx);
              break;
            case "eval":
            case "throw":
              value(s.value, cx);
              break;
            case "return":
              if (s.value && join(result, value(s.value, cx))) changed = true;
              break;
            case "branch": {
              const m = flat(value(s.cond, cx));
              const was = decided.get(b) ?? new Set();
              for (const d of m) if (!was.has(d)) (was.add(d), (changed = true));
              decided.set(b, was);
              break;
            }
            default:
              break;
          }
        }
      });
    for (let round = 0; changed && round < 40; round++) {
      changed = false;
      records = [];
      pass();
    }
    records = [];
    pass();
    // A later call from the same place, given more, says what this one said and more.
    latest.set(`${path.join(".")}|${program.functions.indexOf(fn)}|${key ? shown(key) : ""}`, records);
    const out = { result, out: fn.params.slice(offset).map((l) => inv.env.get(l) ?? null) };
    memo.set(memoKey, out);
    return out;
  }

  const latest = new Map(); // the place of a call -> the writes its last invocation made
  invoke(program.main, {});
  // A function no call of the program's reaches by name (one given as a value): its questions under a key the run
  // works out.
  const reached = new Set([...sources.values()].map((x) => x.fn));
  for (const fn of program.functions) if (fn !== program.main && !reached.has(fn) && fn.blocks.some((b) => b.stmts.some((s) => s.op === "ask"))) invoke(fn, { envs: [new Map()], path: [Infinity] });

  const order = (a, b) => {
    for (let i = 0; i < Math.max(a.order.length, b.order.length); i++) {
      const x = a.order[i] ?? -1, y = b.order[i] ?? -1;
      if (x !== y) return x - y;
    }
    return 0;
  };
  for (const records of latest.values()) {
    for (const r of records) {
      if (!r.boxes) {
        somewhere = true;
        for (const d of r.made) d.entry.intoNamed = true;
        continue;
      }
      for (const full of r.boxes) {
        (r.exact ? written : candidates).add(full);
        for (const { d, direct } of r.made) {
          linked.add(full);
          d.entry.boxes.set(full, (d.entry.boxes.get(full) ?? false) || direct);
        }
      }
    }
  }
  const list = [...questions.values()].sort(order);
  const fields = [...byField.keys()];
  const at = new Map(fields.map((f, i) => [f, i]));
  return {
    questions: list.map((q) => ({ key: q.key, pattern: q.re, printed: q.printed, boxes: [...q.boxes].sort(([a], [b]) => at.get(a) - at.get(b)).map(([box, direct]) => ({ box, direct })), decides: q.decides, intoNamed: q.intoNamed })),
    writtenFromNoAnswer: fields.filter((f) => written.has(f) && !linked.has(f)),
    writtenByName: fields.filter((f) => !written.has(f) && candidates.has(f)),
    someBoxNamedAtRun: somewhere,
    notWritten: fields.filter((f) => !written.has(f) && !candidates.has(f)),
  };
}
