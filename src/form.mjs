// The form's side of a program (docs/spec.md §10): what the compiler looks up in the form's header.
//
// It is a lookup, as a name is looked up among the declarations: a box a program names, written out or worked out
// by the compiler (§10.3.1), is one of the form's, and is written by the statement of its kind. Nothing is followed
// and nothing is proved: what a program does with its boxes as it runs is the run's business (a name worked out as
// it runs that the form lacks is F016, §11.2). Stride is no stricter than the form.
//
//   S501, S502   the header is for another PDF, or another form
//   S508         a box the form does not have (with the nearest)
//   S509         a box written by the statement of another kind
//   S511         a button a radio group, or an on value a check box, does not have (with the nearest)
//   S514         a list box given words that are not one of its entries (with the nearest)
//   W010         words longer than a text box holds
//
// Gives the machine what it needs of the form: every box (its kind, and a check box's export value), every
// question the program asks, and, for the page and `stride map`, which boxes a question's answer goes into, where the
// program says so plainly (`fill "box" = answer`, `tick "box" when … answer …`), through the functions it calls.
import { KIND, didYouMean, nearest } from "./source.mjs";
import { stringOf } from "../runtime/natives.mjs";
import { evaluate } from "./constant.mjs";
import * as V from "../runtime/values.mjs";

// What an expression is when it is written out: words, a number, a date; undefined when it is worked out as the
// program runs.
function written(x) {
  if (!x) return undefined;
  if (x.e === "const") return x.v;
  if (x.e === "concat") {
    const parts = x.parts.map(written);
    return parts.some((p) => p === undefined) ? undefined : parts.map((p) => (V.isNull(p) ? "" : stringOf(p))).join("");
  }
  return undefined;
}
const wordsOf = (x) => {
  const v = written(x);
  return v === undefined ? undefined : V.isNull(v) ? "" : stringOf(v);
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
// The calls of Stride functions in an expression, and the program's names it reads.
function* callsIn(x) {
  if (!x || typeof x !== "object") return;
  if (x.e === "call") yield x;
  for (const v of Object.values(x)) {
    if (Array.isArray(v)) for (const y of v) yield* callsIn(y);
    else if (v && typeof v === "object" && v.e) yield* callsIn(v);
  }
}
function* outersIn(x) {
  if (!x || typeof x !== "object") return;
  if (x.e === "outer") yield x.sym;
  for (const v of Object.values(x)) {
    if (Array.isArray(v)) for (const y of v) yield* outersIn(y);
    else if (v && typeof v === "object" && v.e) yield* outersIn(v);
  }
}

// ----- names the compiler works out (§10.3.1)

// Whether a syntax tree's expression is made only of what is written out, constants and the names `env` gives (a
// loop's item over a constant): then the compiler knows its value.
function madeOfKnown(e, env) {
  if (!e || typeof e !== "object") return true;
  switch (e.kind) {
    case "number":
    case "bool":
    case "null":
    case "plain-string":
      return true;
    case "string":
      return e.parts.every((p) => typeof p === "string" || madeOfKnown(p, env));
    case "name":
      return !e.functionValue && !!e.symbol && (e.symbol.kind === "const" || env.has(e.symbol));
    case "unary":
      return madeOfKnown(e.operand, env);
    case "binary":
      return madeOfKnown(e.a, env) && madeOfKnown(e.b, env);
    case "call":
      return e.args.every((a) => madeOfKnown(a.kind === "named-arg" ? a.value : a, env));
    case "slice":
      return madeOfKnown(e.target, env) && madeOfKnown(e.from, env) && madeOfKnown(e.to, env);
    case "index":
      return madeOfKnown(e.target, env) && madeOfKnown(e.index, env);
    case "list":
    case "tuple":
      return e.items.every((x) => madeOfKnown(x, env));
    case "map":
      return e.entries.every((x) => madeOfKnown(x.key, env) && madeOfKnown(x.value, env));
    case "cond":
      return madeOfKnown(e.condition, env) && madeOfKnown(e.yes, env) && madeOfKnown(e.no, env);
    case "match-expr":
      return madeOfKnown(e.subject, env) && e.arms.every((a) => (a.values ?? []).every((v) => madeOfKnown(v, env)) && madeOfKnown(a.value, env));
    default:
      return false;
  }
}
// Its value in each env, or undefined when any is not known.
function knownIn(e, envs) {
  if (!e || !envs?.length) return undefined;
  const out = [];
  for (const env of envs) {
    if (!madeOfKnown(e, env)) return undefined;
    const v = evaluate(e, env);
    if (v === undefined) return undefined;
    out.push(v);
  }
  return out;
}
const MOST_TURNS = 2000;

// The turns of the loops around each fill, tick and pick of the syntax tree whose items the compiler knows: for
// each statement, the values its loops' names take (one Map per turn), or null when a loop around it is over what
// only the run knows. A loop over a constant list or map, or a range written out, is known.
function loopTurns(resolved) {
  const out = new Map(); // statement -> [Map] | null
  if (!resolved) return out;
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
  const walk = (list, envs) => {
    for (const s of list ?? []) {
      if (!s || typeof s !== "object") continue;
      if (s.kind === "fill" || s.kind === "tick" || s.kind === "pick") {
        out.set(s, envs);
        continue;
      }
      if (s.kind === "for-each" || s.kind === "for") {
        let inner = null;
        if (envs) {
          inner = [];
          for (const env of envs) {
            const turns = s.kind === "for" ? rangeTurns(s, env) : eachTurns(s, env);
            if (!turns) {
              inner = null;
              break;
            }
            inner.push(...turns);
            if (inner.length > MOST_TURNS) {
              inner = null;
              break;
            }
          }
        }
        // `for (a, b) in l`: its names are hidden lets made of the item (§7.11.2).
        if (inner && s.destructure) {
          for (const x of s.body.filter((b) => b.kind === "let" && b.hidden)) {
            const sym = x.symbol;
            if (!sym) continue;
            for (const env of inner) {
              const v = madeOfKnown(x.value, env) ? evaluate(x.value, env) : undefined;
              if (v !== undefined) env.set(sym, v);
            }
          }
        }
        walk(s.body, inner);
        continue;
      }
      for (const c of children(s)) walk(c, envs);
    }
  };
  const rangeTurns = (s, env) => {
    if (!s.symbol || !madeOfKnown(s.from, env) || !madeOfKnown(s.to, env)) return null;
    const a = evaluate(s.from, env), b = evaluate(s.to, env);
    if (!V.isNumber(a) || !V.isNumber(b)) return null;
    const from = Number(stringOf(a)), to = Number(stringOf(b)) - (s.exclusive ? 1 : 0);
    if (!Number.isInteger(from) || !Number.isInteger(to) || to - from > MOST_TURNS) return null;
    const turns = [];
    for (let i = from; i <= to; i++) turns.push(new Map(env).set(s.symbol, V.num(i)));
    return turns;
  };
  const eachTurns = (s, env) => {
    if (!s.itemSymbol || !madeOfKnown(s.list, env)) return null;
    const l = evaluate(s.list, env);
    if (l === undefined || l === null) return null;
    const turns = [];
    const turn = (index, item) => {
      const t = new Map(env).set(s.itemSymbol, item);
      if (s.indexSymbol) t.set(s.indexSymbol, index);
      turns.push(t);
    };
    if (l instanceof V.StrideMap) {
      for (const [k, v] of l.pairs) s.indexSymbol ? turn(k, v) : turn(null, k);
    } else if (Array.isArray(l)) l.forEach((x, i) => turn(V.num(i), x));
    else if (typeof l === "string") [...l].forEach((c, i) => turn(V.num(i), c));
    else return null;
    return turns.length > MOST_TURNS ? null : turns;
  };
  for (const r of resolved.units) {
    for (const f of r.functions) if (Array.isArray(f.node?.body)) walk(f.node.body, [new Map()]);
    if (!r.unit.library) walk(r.main, [new Map()]);
  }
  return out;
}

// ----- the header

// A field's on values: a check box's (one, or one per widget) and a radio group's buttons. A header lists a field
// once, its `on` words or a list; one written by an earlier `stride header` lists it once per widget.
export function onValuesOf(entries) {
  const ons = [];
  for (const b of entries) for (const v of Array.isArray(b.on) ? b.on : b.on === undefined || b.on === null ? [] : [b.on]) if (!ons.includes(v)) ons.push(v);
  return ons;
}
const quoted = (xs) => xs.map((x) => `"${x}"`).join(", ");
// The entry nearest to words that are not one: the same words in other letters or spaces, one that starts the other,
// else the nearest by spelling.
function nearestEntry(w, entries) {
  const fold = (x) => x.toLowerCase().replace(/\s+/g, " ").trim();
  const f = fold(w);
  const same = entries.find((e) => fold(e) === f);
  if (same !== undefined) return same;
  if (f.length >= 3) {
    const starts = entries.filter((e) => fold(e).length >= 2 && (f.startsWith(fold(e)) || fold(e).startsWith(f)));
    if (starts.length === 1) return starts[0];
  }
  return nearest(w, entries.filter((e) => e !== ""));
}
const didYouMeanEntry = (w, entries) => {
  const n = nearestEntry(w, entries);
  return n === null || n === undefined ? "" : `; did you mean "${n}"?`;
};

// `open`: the header lists no boxes on purpose (a test's, a script's): every box the program names is taken as one
// of the form's, of the kind its statement writes.
export function checkForm(program, header, diagnostics, { open = false, resolved = null } = {}) {
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
  for (const [field, entries] of byField) {
    const kind = entries[0].kind;
    boxes.set(field, { kind: kind === "check" ? "tick" : kind === "radio" ? "pick" : "fill", on: kind === "check" ? onValuesOf(entries)[0] ?? "Yes" : null });
  }
  const writtenOut = new Set(); // the boxes it writes by a name the compiler knows
  const patterns = []; // the boxes it writes by a name worked out as it runs: { kind, re }
  const questions = new Set();
  const keys = new Map(); // a question's key, worked out -> { q, printed, node }
  const links = new Map(); // key \t box -> { key, box, direct }
  const maxOf = new Map();
  const intoNamed = new Set(); // the keys of answers that go into a box named as the program runs
  const turnsOf = loopTurns(resolved);

  // ----- which questions' answers each value is made of, through the functions it calls

  // A value's sources are asks ({ s, fn }) and a function's parameters ({ param }); a parameter stands for what
  // each call gives it (paramIn), and a call's value for what its function returns, made of its own asks (what its
  // parameters are made of is the call's arguments, read already).
  const fnOf = new Map(program.functions.map((f) => [f, f]));
  const deps = new Map(); // local -> Set of sources
  const returns = new Map(); // fn -> Set of sources
  const paramIn = new Map(); // parameter local -> Set of sources, from every call
  const markers = new Map(); // parameter local -> its source
  for (const fn of program.functions) for (const l of fn.params) (markers.set(l, { param: l }), deps.set(l, new Set([markers.get(l)])));
  const depsOf = (x) => {
    const out = new Set();
    for (const l of localsIn(x)) for (const a of deps.get(l) ?? []) out.add(a);
    for (const c of callsIn(x)) for (const a of returns.get(c.fn) ?? []) if (!a.param) out.add(a);
    for (const sym of outersIn(x)) for (const a of deps.get(program.outer?.get(sym)) ?? []) out.add(a);
    return out;
  };
  // The asks a value's sources come to, through every call of the functions it is in.
  const asksOf = (sources, seen = new Set()) => {
    const out = new Set();
    for (const a of sources) {
      if (!a.param) out.add(a);
      else if (!seen.has(a.param)) {
        seen.add(a.param);
        for (const b of asksOf(paramIn.get(a.param) ?? [], seen)) out.add(b);
      }
    }
    return out;
  };
  const addTo = (map, key, from) => {
    if (!key) return false;
    const mine = map.get(key) ?? new Set();
    const before = mine.size;
    for (const a of from) mine.add(a);
    map.set(key, mine);
    return mine.size > before;
  };
  const stmtsOf = (fn) => fn.blocks.flatMap((b) => [...b.stmts, ...(b.term ? [b.term] : [])]);
  const asks = new Map(); // ask statement -> { s, fn }
  for (const fn of program.functions) for (const s of stmtsOf(fn)) if (s.op === "ask") (asks.set(s, { s, fn }), addTo(deps, s.dst, [asks.get(s)]));
  for (let changed = true, rounds = 0; changed && rounds < 50; rounds++) {
    changed = false;
    for (const fn of program.functions) {
      for (const s of stmtsOf(fn)) {
        if ((s.op === "set" || s.op === "append") && s.value) changed = addTo(deps, s.dst, depsOf(s.value)) || changed;
        if (s.op === "store") changed = addTo(deps, s.outer ? program.outer?.get(s.outer) : s.dst, depsOf(s.value)) || changed;
        if (s.op === "return" && s.value) changed = addTo(returns, fn, depsOf(s.value)) || changed;
        // What a call is given goes into the callee's parameters.
        for (const x of expressionsOfStatement(s)) {
          for (const c of callsIn(x)) {
            const callee = fnOf.get(c.fn);
            if (!callee) continue;
            c.args.forEach((a, i) => {
              if (callee.params[i]) changed = addTo(paramIn, callee.params[i], depsOf(a)) || changed;
            });
          }
        }
      }
    }
  }

  // A function's key prefix: the words of its first call's key, when they are known (§8.6.2); main's is "".
  const prefixes = new Map([[program.main, { key: "", turns: "" }]]);
  const keyWords = (x, fn) => {
    if (!x) return undefined;
    const at = prefixes.get(fn);
    if (x.e === "const") return V.isNull(x.v) ? "" : stringOf(x.v);
    if (x.e === "concat") {
      const parts = x.parts.map((p) => keyWords(p, fn));
      return parts.some((p) => p === undefined) ? undefined : parts.join("");
    }
    if (x.e === "native" && x.name === "call_key") return keyWords(x.args[0], fn);
    if (x.e === "local" && fn.keyed && at && x.l === fn.params[0]) return at.key;
    if (x.e === "local" && fn.keyed && at && x.l === fn.params[1]) return at.turns;
    return undefined;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const fn of program.functions) {
      if (!prefixes.has(fn)) continue;
      for (const s of stmtsOf(fn)) {
        for (const x of expressionsOfStatement(s)) {
          for (const c of callsIn(x)) {
            const callee = fnOf.get(c.fn);
            if (!callee?.keyed || prefixes.has(callee)) continue;
            const key = keyWords(c.args[0], fn), turns = keyWords(c.args[1], fn);
            if (key !== undefined && turns !== undefined) (prefixes.set(callee, { key, turns }), (changed = true));
          }
        }
      }
    }
  }
  const keyOf = (a) => keyWords(a.s.key, a.fn);

  for (const { s, fn } of asks.values()) {
    questions.add(s.q);
    const key = keyOf({ s, fn });
    if (key !== undefined && !keys.has(key)) keys.set(key, { q: s.q, printed: wordsOf(s.printed) ?? "", node: s.node });
  }

  // ----- each write

  const kinds = { fill: ["text", "choice"], tick: ["check"], pick: ["radio", "check"] };
  const escape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patternOf = (x) => {
    const w = wordsOf(x);
    if (w !== undefined) return escape(w);
    if (x?.e === "concat") return x.parts.map(patternOf).join("");
    return "[^]*";
  };
  for (const fn of program.functions) {
    // Which questions each local holds an answer of, in this function: the ask's own local, and a let made from
    // such locals.
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
    const givenOf = (x) => x?.e === "local" && from.get(x.l)?.size === 1 && [...from.get(x.l)][0].dst === x.l;
    for (const s of stmts) {
      if (!["fill", "tick", "pick"].includes(s.op)) continue;
      // The questions this write is made of, for the run to say which box an answer went into (codegen.mjs).
      const made = s.op === "fill" ? s.value : s.cond;
      const given = s.op === "fill" && givenOf(made);
      s.sources = [...new Set([...localsIn(made)].flatMap((l) => [...(from.get(l) ?? [])]))].map((a) => ({ q: a.q, direct: given }));

      // The box's name, its button and its words, as the compiler knows them: written out, or worked out from
      // constants and the items of loops over constants (one of each per turn).
      const node = s.node;
      let names = wordsOf(s.box) !== undefined ? [wordsOf(s.box)] : undefined;
      const envs = turnsOf.get(node);
      if (names === undefined && node?.box) names = knownIn(node.box, envs)?.map((v) => (V.isNull(v) ? "" : stringOf(v)));
      if (names === undefined) {
        patterns.push({ op: s.op, re: new RegExp(`^${escape(prefix)}${patternOf(s.box)}$`) });
        for (const a of asksOf([...depsOf(s.op === "fill" ? s.value : s.cond), ...(s.op === "pick" ? depsOf(s.button) : [])])) if (keyOf(a) !== undefined) intoNamed.add(keyOf(a));
        continue; // worked out as the program runs: the run looks it up
      }
      const fromLoop = wordsOf(s.box) === undefined;
      const each = (x, astNode) => {
        const w = wordsOf(x);
        if (w !== undefined) return names.map(() => w);
        if (!fromLoop || !astNode) return names.map(() => undefined);
        return knownIn(astNode, envs)?.map((v) => (V.isNull(v) ? "" : stringOf(v))) ?? names.map(() => undefined);
      };
      const buttons = s.op === "pick" ? each(s.button, node?.button) : [];
      const values = s.op === "fill" ? each(s.value, node?.value) : [];
      const value = s.op === "fill" ? s.value : s.cond;
      const direct = s.op === "fill" && givenOf(value);
      names.forEach((short, turn) => {
        const full = prefix + short;
        if (open && !boxes.has(full)) boxes.set(full, { kind: s.op, on: s.op === "tick" ? "Yes" : null }); // taken as one of the form's, of this statement's kind
        const found = byField.get(full);
        const at = s.node?.box ?? s.node;
        if (!found && !open) {
          errOnce("S508", `nobox\t${full}\t${s.node?.span?.start}`, at, program.script ? `a script has no form, so it has no box "${short}" to write; start the file with form and pdf lines to fill a form (§4.6)` : `the PDF has no box "${short}"${didYouMean(short, shortNames)}`);
          return;
        }
        writtenOut.add(full);
        if (found) {
          const first = found[0];
          if (!kinds[s.op].includes(first.kind)) {
            const how = { text: "fill", choice: "fill", check: onValuesOf(found).length > 1 ? "tick or pick" : "tick", radio: "pick" }[first.kind];
            errOnce("S509", `kind\t${full}\t${s.node?.span?.start}`, s.node, `"${short}" is a ${first.kind === "check" ? "check box" : first.kind === "radio" ? "radio group" : `${first.kind} box`}; ${s.op} cannot write it (${how} does)`);
            return;
          }
          if (s.op === "pick") {
            const button = buttons[turn];
            const ons = onValuesOf(found);
            if (button !== undefined && !ons.includes(button)) {
              const what = first.kind === "check" ? `the check box "${short}" has no on value "${button}"` : `the radio group "${short}" has no button "${button}"`;
              errOnce("S511", `button\t${full}\t${button}`, s.node?.button ?? s.node, `${what}; it has ${quoted(ons)}${didYouMeanEntry(button, ons)}`);
            }
          }
          const w = values[turn];
          if (s.op === "fill" && first.kind === "choice" && first.options && w !== undefined && w !== "" && !first.options.includes(w)) {
            errOnce("S514", `choice\t${full}\t${w}`, s.node?.value ?? s.node, `the list box "${short}" has no entry "${w}"${didYouMeanEntry(w, first.options)}`);
          }
          if (s.op === "fill" && first.kind === "text" && first.max && w !== undefined && [...w].length > first.max) {
            errOnce("W010", `max\t${full}\t${w}`, s.node?.value ?? s.node, `"${w}" is ${[...w].length} characters, and the box "${short}" holds ${first.max}`);
          }
        }
        // Which questions' answers go into this box: as given (`fill "box" = answer`), or deciding what is
        // written; through the functions the write's value is made with, and the parameters it is given.
        for (const a of asksOf([...depsOf(value), ...(s.op === "pick" ? depsOf(s.button) : [])])) {
          const key = keyOf(a);
          if (key === undefined) continue;
          const isDirect = direct && a.s.dst === value.l;
          const id = `${key}\t${full}`;
          const was = links.get(id);
          if (!was) links.set(id, { key, box: full, direct: isDirect });
          else if (isDirect) was.direct = true;
          const max = found?.[0]?.max;
          if (isDirect && max) maxOf.set(key, Math.min(maxOf.get(key) ?? Infinity, max));
        }
      });
    }
  }

  // The boxes a name worked out as the program runs may write: those of the statement's kind whose names fit what
  // of the name is written out.
  const byName = new Set();
  for (const [field, entries] of byField) {
    if (writtenOut.has(field)) continue;
    if (patterns.some((p) => kinds[p.op].includes(entries[0].kind) && p.re.test(field))) byName.add(field);
  }

  return { boxes, written: writtenOut, byName, intoNamed, questions: [...questions], links: [...links.values()], maxOf, keys };
}

// The expressions a statement holds, for finding the calls in it.
function expressionsOfStatement(s) {
  return [s.value, s.cond, s.box, s.button, s.key, s.printed, s.default, s.message, ...(s.path ?? []).map((p) => p.index)].filter(Boolean);
}
