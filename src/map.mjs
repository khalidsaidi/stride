// `stride map` (docs/spec.md §17.6.1): each question the program asks, under its key or its key's pattern, and the
// boxes its answer goes into; the boxes written from no answer; those a name worked out as the program runs may
// be; and those not written.
//
// It follows the program as it is lowered (ir.mjs), each function once for each way it is called: the key its
// questions have there (a call named `as "home"` and one named `as "mail"` ask under their own names), the values
// the compiler knows of its arguments (a box's name given to a helper), and which answers each argument is made of.
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
      return !e.functionValue && !!e.symbol && (e.symbol.kind === "const" || e.symbol.kind === "enum" || env.has(e.symbol));
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
const valueIn = (e, env) => {
  if (!known(e, env)) return undefined;
  try {
    return evaluate(e, env);
  } catch {
    return undefined;
  }
};
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

// The values an expression may have when the compiler cannot tell which: the items of a constant list or the values
// of a constant map it reads at a position worked out as the program runs, a field of each, either value of an
// `if … then … else`; undefined when it cannot tell.
function possible(e, env) {
  const v = valueIn(e, env);
  if (v !== undefined) return [v];
  switch (e?.kind) {
    case "index": {
      const t = possible(e.target, env);
      if (!t) return undefined;
      const out = [];
      for (const x of t) {
        if (x instanceof V.StrideMap) out.push(...x.pairs.map(([, y]) => y));
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
    else return null;
    return turns.length > MOST_TURNS ? null : turns;
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
            inner = envs;
            break;
          }
          inner.push(...turns);
        }
        // `for (a, b) in l`: its names are hidden lets made of the item (§7.11.2).
        if (inner !== envs && s.destructure) {
          for (const x of s.body.filter((b) => b.kind === "let" && b.hidden)) {
            if (!x.symbol) continue;
            for (const env of inner) {
              const v = valueIn(x.value, env);
              if (v !== undefined) env.set(x.symbol, v);
            }
          }
        }
        walk(s.body, inner);
        continue;
      }
      for (const c of children(s)) walk(c, envs);
    }
  };
  walk(Array.isArray(body) ? body : [], start);
  return out;
}

// A value's signature, for telling apart the ways a function is called.
function signature(v) {
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
            const v = a.kind === "default-of" ? (a.param.defaultExpr ? valueIn(a.param.defaultExpr, new Map()) : a.param.defaultValue ?? null) : valueIn(a.kind === "named-arg" ? a.value : a, env);
            if (v !== undefined) m.set(p, v);
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
        // What of the name the compiler knows: every box of the statement's kind whose name fits it.
        const parts = node?.box?.kind === "string" ? node.box.parts.flatMap((p) => {
          if (typeof p === "string") return [p];
          const xs = knownIn(p, cx.envs)?.map(wordsOfValue);
          return xs && new Set(xs).size === 1 ? [xs[0]] : [HOLE];
        }) : partsOf(s.box, inv);
        if (parts.filter((p) => typeof p === "string").join("").length >= 2) {
          const re = pattern([prefix, ...parts]);
          maybe = [...byField.keys()].filter((f) => fits(s.op, f) && re.test(f)).map((f) => f.slice(prefix.length));
        }
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
