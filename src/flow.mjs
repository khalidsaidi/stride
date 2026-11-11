// Phase 5: check the flow. What depends on the order a program runs in, over every function and the program:
//
//   - no function reaches itself, directly or through others, so every program ends;
//   - effects: a function that asks a question, writes a box or collects a list (itself or through a function it
//     calls) has effects; one that does none is pure;
//   - known before the form opens: a box's name, a button's, a question's printed words, a loop's bounds when the
//     loop has effects. Such a value is made of constants, the counters of loops with effects, and parameters
//     that every call gives a known value; a parameter is known when it is used where a known value is needed,
//     and then every call must give it one;
//   - a var is read only where every path to it has given it a value;
//   - a function with a result returns one on every path; nothing stands after a return;
//   - every answer is used, and every field a question answers is read somewhere.
//
// It marks: fn.effects, fn.staticParams (a Set of parameter symbols), loop.unroll (the loops and collects whose
// counter is known), let.known.
import { KIND, nameSpan } from "./source.mjs";
import { describeExpr } from "./check.mjs";
import { NATIVES } from "../runtime/natives.mjs";
import { evaluate, knownPlaced, AnalysisLimit } from "./constant.mjs";
import * as V from "../runtime/values.mjs";


// `session`: the program is `stride repl`'s, read as it is typed (§17.14): a name not used yet is not a mistake.
export function flow(resolved, diagnostics, { session = false } = {}) {
  // The turns followed one by one over the whole flow phase, every walk and every visit again counted (§15.1).
  const TURNS = 100_000;
  let turnsFollowed = 0;
  const turn = (s) => {
    if (++turnsFollowed > TURNS) throw new AnalysisLimit("the flow phase following loop turns", `${TURNS.toLocaleString("en")} turns`, s);
  };
  const err = (code, node, message, notes) => diagnostics.add(KIND.FLOW, node?.file ?? null, node?.span ?? null, message, notes, code);
  const warn = (code, node, message, notes = []) => diagnostics.warn(KIND.FLOW, node?.file ?? null, node?.span ?? null, message, notes, code);
  const functions = resolved.units.flatMap((r) => r.functions);
  const declaredOn = new Set(); // the lets and vars declared on the path being walked (§12.1.1)
  // Why a let or var may have no value: the latest construct that leaves it so on some path, for S407's words.
  const cause = new Map(); // symbol -> { kind: "declared" | "if" | "match" | "loop", node }
  const union = (sets) => new Set(sets.flatMap((x) => [...x]));
  // What is known before the form opens (§11.1) of a condition, a bound, a subject, a list or an argument: never
  // a call of a Stride function, even one standing alone, whose value the run gives.
  const know = (e, env) => (e?.kind === "call" && e.callee?.kind === "function" ? undefined : evaluate(e, env));
  const bodies = [...functions.map((f) => ({ fn: f, body: f.node.body })), ...resolved.units.filter((r) => !r.unit.library).map((r) => ({ fn: null, body: r.main }))];

  // ----- walking a body's statements and expressions

  const childStatements = (s) => {
    switch (s.kind) {
      case "if":
        return [...s.then, ...s.otherwise];
      case "match":
        return s.arms.flatMap((a) => a.body);
      case "for":
      case "for-each":
      case "collect":
        return s.body;
      default:
        return [];
    }
  };

  function* statements(list) {
    for (const s of list) {
      yield s;
      yield* statements(childStatements(s));
    }
  }

  function* expressionsOf(s) {
    for (const e of rootsOf(s)) if (e) yield* subexpressions(e);
  }

  // A statement's own expressions, not those of the statements inside it.
  function rootsOf(s) {
    return {
      ask: () => [s.printed, ...(s.set?.anonymous ? s.set.options.map((o) => o.printed) : []), ...s.modifiers.flatMap((m) => (m.kind === "default" ? [m.value] : [m.condition, m.message]))],
      let: () => [s.value],
      var: () => (s.value ? [s.value] : []),
      fill: () => [s.box, s.value],
      tick: () => [s.box, s.condition],
      pick: () => [s.box, s.button, s.condition],
      skip: () => [s.box, s.reason],
      if: () => [s.condition],
      match: () => [s.subject],
      for: () => [s.from, s.to],
      "for-each": () => [s.list],
      collect: () => (s.any ? [s.any, s.another] : [s.another]),
      return: () => (s.value ? [s.value] : []),
      assign: () => [s.target, s.value],
      "call-statement": () => [s.call],
      break: () => [],
      continue: () => [],
      expect: () => [s.value, s.message, s.fault],
    }[s.kind]();
  }

  function* subexpressions(e) {
    if (!e || typeof e !== "object") return;
    yield e;
    for (const x of children(e)) yield* subexpressions(x);
  }

  // An expression's direct parts.
  function children(e) {
    switch (e.kind) {
      case "string":
        return e.parts.filter((p) => typeof p !== "string");
      case "binary":
        return [e.a, e.b];
      case "unary":
      case "is-empty":
        return [e.operand];
      case "field":
        return [e.target];
      case "index":
        return [e.target, e.index];
      case "call":
        return e.args;
      case "list":
        return e.items;
      case "new":
        return e.fields.map((f) => f.value);
      case "named-arg":
        return [e.value];
      case "cond":
        return [e.condition, e.yes, e.no];
      case "slice":
        return [e.target, e.from, e.to];
      case "comprehension":
        return [e.list, e.condition, e.value];
      default:
        return [];
    }
  }


  const callsIn = (body) => {
    const out = [];
    for (const s of statements(body)) for (const e of expressionsOf(s)) if (e.kind === "call" && e.callee?.kind === "function") out.push(e);
    return out;
  };

  // ----- 1. no function reaches itself (Tarjan's strongly connected components)

  const calls = new Map(functions.map((f) => [f, callsIn(f.node.body)]));
  {
    let index = 0;
    const stack = [];
    const info = new Map();
    const strong = (v) => {
      info.set(v, { index, low: index, on: true });
      index++;
      stack.push(v);
      for (const c of calls.get(v) ?? []) {
        const w = c.callee;
        if (!info.has(w)) {
          strong(w);
          info.get(v).low = Math.min(info.get(v).low, info.get(w).low);
        } else if (info.get(w).on) info.get(v).low = Math.min(info.get(v).low, info.get(w).index);
      }
      if (info.get(v).low === info.get(v).index) {
        const component = [];
        let w;
        do {
          w = stack.pop();
          info.get(w).on = false;
          component.push(w);
        } while (w !== v);
        // S401 at each function's call of itself; S402 at the call, in the circle's first-declared function, that
        // starts the circle, named by the shortest way back to it (§16.2.1).
        for (const f of component) {
          const self = (calls.get(f) ?? []).find((c) => c.callee === f);
          if (self) err("S401", self, `${f.name} calls itself; a function may not, so that every program ends (a loop does what is needed)`);
        }
        if (component.length > 1) {
          const first = functions.find((f) => component.includes(f));
          const at = (calls.get(first) ?? []).find((c) => c.callee !== first && component.includes(c.callee));
          const back = new Map([[at.callee, null]]);
          for (const queue = [at.callee]; queue.length && !back.has(first); ) {
            const x = queue.shift();
            for (const c of calls.get(x) ?? []) if (component.includes(c.callee) && !back.has(c.callee)) (back.set(c.callee, x), queue.push(c.callee));
          }
          const names = [first.name];
          for (let x = back.get(first) ?? null, way = []; ; x = back.get(x)) {
            if (x === null) {
              names.push(...way.reverse());
              break;
            }
            way.push(x.name);
          }
          err("S402", at, `functions cannot call each other in a circle (${[...names, first.name].join(" calls ")}): a program must end`);
        }
        if (component.length > 1 || (calls.get(v) ?? []).some((c) => c.callee === v)) {
          for (const f of component) f.recursive = true;
        }
      }
    };
    for (const f of functions) if (!info.has(f)) strong(f);
  }

  // ----- 2. effects

  const EFFECTS = new Set(["ask", "fill", "tick", "pick", "skip", "collect"]);
  const directEffects = (body) => [...statements(body)].some((s) => EFFECTS.has(s.kind));
  for (const f of functions) f.effects = directEffects(f.node.body);
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of functions) {
      if (f.effects) continue;
      if ((calls.get(f) ?? []).some((c) => c.callee.effects)) {
        f.effects = true;
        changed = true;
      }
    }
  }
  const hasEffects = (body) => directEffects(body) || callsIn(body).some((c) => c.callee.effects);

  // A comprehension makes a value: what it works out for each item may not ask, write boxes or collect (S398).
  for (const { body } of bodies) {
    for (const s of statements(body)) {
      for (const e of expressionsOf(s)) {
        if (e.kind !== "comprehension") continue;
        const effect = [e.value, e.condition].flatMap((x) => [...subexpressions(x)]).find((x) => x.kind === "call" && x.callee?.effects);
        if (effect) err("S398", effect, `a comprehension makes a value, and ${effect.callee.name} asks, writes boxes or collects; use for each`);
      }
    }
  }

  // Purity (§9.9): a function that has effects, calls an impure native (today, print, fail), or calls a function that
  // is impure, is impure; only a pure one is worked out before the form opens.
  const nativeCallsIn = (body) => {
    const out = [];
    for (const st of statements(body)) for (const e of expressionsOf(st)) if (e.kind === "call" && e.callee?.kind === "native") out.push(e);
    return out;
  };
  const impureNative = (c) => !NATIVES[c.callee.name]?.pure;
  for (const f of functions) f.impure = f.effects || nativeCallsIn(f.node.body).some(impureNative);
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of functions) {
      if (f.impure) continue;
      if ((calls.get(f) ?? []).some((c) => c.callee.impure)) {
        f.impure = true;
        changed = true;
      }
    }
  }

  // Loops and collects with effects are unrolled: their counter, index and turns are known before the form opens.
  for (const { body } of bodies) {
    for (const s of statements(body)) {
      if (s.kind === "collect") s.unroll = true;
      if ((s.kind === "for" || s.kind === "for-each") && hasEffects(s.body)) s.unroll = true;
    }
  }

  // ----- 3. known before the form opens

  for (const f of functions) f.staticParams = new Set();
  const fnOf = new Map(); // a node's function, for parameters
  const required = []; // { expr, fn, why }
  for (const { fn, body } of bodies) {
    for (const s of statements(body)) {
      const need = (e, why) => e && required.push({ expr: e, fn, why });
      switch (s.kind) {
        case "ask":
          need(s.printed, "a question's printed words");
          if (s.set?.anonymous) for (const o of s.set.options) need(o.printed, "an option's printed words");
          break;
        case "fill":
        case "tick":
        case "skip":
          need(s.box, "a box's name");
          if (s.kind === "skip") need(s.reason, "the reason a box is skipped");
          break;
        case "pick":
          need(s.box, "a box's name");
          need(s.button, "a button's name");
          break;
        case "collect":
          need(s.another, "the question that asks for another item");
          if (s.any) need(s.any, "the question that asks whether there are any");
          break;
        case "expect":
          need(s.fault, "the fault a test expects");
          break;
        case "for":
          if (s.unroll) (need(s.from, "the bounds of a loop that asks or writes boxes"), need(s.to, "the bounds of a loop that asks or writes boxes"));
          break;
        default:
          break;
      }
      for (const e of expressionsOf(s)) if (e.kind === "name") fnOf.set(e, fn);
    }
  }

  // A let whose value is known is known itself.
  const lets = new Map();
  for (const { fn, body } of bodies) for (const s of statements(body)) if (s.kind === "let" && s.symbol) lets.set(s.symbol, { s, fn });

  // Whether a name is known before the form opens, given the parameters known so far.
  function knownName(sym, fn, seen = new Set()) {
    switch (sym.kind) {
      case "const":
        return true;
      case "counter":
        return !!sym.node.unroll;
      case "index":
        return !!sym.node.unroll;
      // The item of a for each over a known list (a list written out): each turn's item is known (§11.1).
      case "item":
        return sym.node.kind === "for-each" && !!sym.node.unroll && !seen.has(sym) && (seen.add(sym), known(sym.node.list, fn, seen));
      case "param":
        return [...(fn?.staticParams ?? [])].includes(sym);
      case "let": {
        if (seen.has(sym)) return false;
        seen.add(sym);
        const l = lets.get(sym);
        return !!l && known(l.s.value, l.fn, seen);
      }
      default:
        return false;
    }
  }

  // `calls`: a call of a pure Stride function on known values counts too (a box's name, §11.2).
  function known(e, fn, seen = new Set(), calls = false) {
    for (const x of subexpressions(e)) {
      if (x.kind === "name" && x.symbol && !knownName(x.symbol, fn, seen)) return false;
      if (x.kind === "call") {
        const c = x.callee;
        if (!c) continue;
        if ((c.kind === "function" && !(calls && c.impure === false)) || (c.kind === "native" && !NATIVES[c.name]?.pure)) return false;
      }
      // A list literal of known values is known (§11.1); its items are checked as they come.
      if (x.kind === "field" || x.kind === "index" || x.kind === "new" || x.kind === "comprehension" || x.kind === "slice") return false;
    }
    return true;
  }

  // Parameters become known from where they are needed, and from calls that pass them on, until nothing changes.
  for (let changed = true; changed; ) {
    changed = false;
    const mark = (e, fn) => {
      for (const x of subexpressions(e)) {
        if (x.kind === "name" && x.symbol?.kind === "param" && fn && fn.params.includes(x.symbol) && !fn.staticParams.has(x.symbol)) {
          fn.staticParams.add(x.symbol);
          changed = true;
        }
        if (x.kind === "name" && x.symbol?.kind === "let") {
          const l = lets.get(x.symbol);
          if (l && !l.marking) {
            l.marking = true;
            mark(l.s.value, l.fn);
            l.marking = false;
          }
        }
      }
    };
    for (const r of required) mark(r.expr, r.fn);
    for (const { fn, body } of bodies) {
      for (const c of callsIn(body)) {
        c.callee.params.forEach((p, i) => {
          // The argument bound to the parameter, named ones by their name (§9.4).
          const a = (c.bound ?? c.args)[i];
          if (c.callee.staticParams.has(p) && a && a.kind !== "default-of") mark(a, fn);
        });
      }
    }
  }

  const unknownPart = (e, fn) => {
    for (const x of subexpressions(e)) {
      if (x.kind === "name" && x.symbol && !knownName(x.symbol, fn)) return x;
      if (x.kind === "call" && x.callee && (x.callee.kind === "function" || !NATIVES[x.callee.name]?.pure)) return x;
      if (["field", "index", "list", "new"].includes(x.kind)) return x;
    }
    return e;
  };
  const reason = (x) => {
    const sym = x.symbol;
    if (!sym) return x.kind === "call" ? `${describeExpr(x)} runs when the form is filled` : `${describeExpr(x)} is known only when the form is filled`;
    if (sym.kind === "answer") return `${sym.name} is an answer, known only when the form is filled`;
    if (sym.kind === "var") return `${sym.name} is a var, which can change as the form is filled`;
    if (sym.kind === "counter" || sym.kind === "index") return `${sym.name} counts a loop that neither asks nor writes boxes, so it runs when the form is filled`;
    if (sym.kind === "item") return `${sym.name} is an item of a list, known only when the form is filled`;
    return `${sym.name} is not known before the form opens`;
  };
  for (const r of required) {
    if (!known(r.expr, r.fn, new Set(), r.why === "a box's name" || r.why === "a button's name")) {
      const x = unknownPart(r.expr, r.fn);
      err("S403", r.expr, `${r.why} must be known before the form opens; ${reason(x)}`);
    }
  }
  for (const { fn, body } of bodies) {
    for (const c of callsIn(body)) {
      c.callee.params.forEach((p, i) => {
        const a = (c.bound ?? c.args)[i];
        if (!a || a.kind === "default-of" || !c.callee.staticParams.has(p) || known(a, fn)) return;
        const x = unknownPart(a, fn);
        err("S404", a, `${c.callee.name}'s ${p.name} names a box or a question, so it must be known before the form opens; ${reason(x)}`, [{ file: p.file, span: p.span, message: `${p.name} is declared here` }]);
      });
    }
  }
  for (const [sym, l] of lets) sym.known = !sym.branchDeclared && known(l.s.value, l.fn);

  // ----- 4. vars given a value before they are read; returns; nothing after a return

  for (const { fn, body } of bodies) {
    const state = new Set(); // vars that may have no value yet
    const end = walkFlow(body, state, fn);

    if (fn && fn.result && fn.result.t !== "none" && fn.result.t !== "error" && end.falls) err("S405", fn.node, `${fn.name} gives ${fn.result.t === "record" ? fn.result.decl.name : fn.result.t} on some paths and nothing on others; end every path with a return`);
  }

  // S406 (§7.13): in each block, the statement after a return, break or continue there. A statement a known
  // condition passes over is not one: it is unreachable code (§11.3.3), checked but not refused.
  for (const { body } of bodies) {
    const blocks = [body, ...[...statements(body)].flatMap((s) => (s.kind === "if" ? [s.then, s.otherwise] : s.kind === "match" ? s.arms.map((a) => a.body) : ["for", "for-each", "collect"].includes(s.kind) ? [s.body] : []))];
    for (const block of blocks) {
      const k = block.findIndex((s) => s.kind === "return" || s.kind === "break" || s.kind === "continue");
      if (k >= 0 && k + 1 < block.length) err("S406", block[k + 1], "this never runs: a return, break or continue comes before it");
    }
  }

  // `unset` holds the vars that may have no value on the way here. Gives { unset, falls }: falls is whether the
  // block can run past its end (not every path returned, broke or continued). `exits` gathers, for the loop the
  // block is in, what is unset at each break and each continue. `env` holds what is known on this path before the
  // form opens (§11.1): known lets, and the counter and item of each loop turn walked one by one. The flow is
  // reduced by it (§11.3.2, §12.1.1): a known condition takes its branch, a known subject its arm, a loop with known
  // bounds or a list literal runs exactly its turns.
  // S407 at the read, naming the path that leaves the name without a value (§16.2.1): a branch that skips it, a
  // loop that may run no turns, or the declaration when nothing gives it one.
  function unsetRead(e) {
    const sym = e.symbol, c = cause.get(sym);
    const declared = sym.kind === "let" || sym.branchDeclared;
    const line = c?.node.span?.line;
    const what = c?.kind === "loop" ? `the ${c.node.kind === "collect" ? "collect" : "loop"} on line ${line} may run no turns` : c && c.kind !== "declared" ? `the ${c.kind} on line ${line} has a way through that ${declared ? "skips its declaration" : "gives it none"}` : null;
    const message = declared ? `${sym.name} may not be declared here: ${what ?? `its declaration on line ${sym.line} is skipped on some path`}` : what ? `${sym.name} may have no value here: ${what}` : `${sym.name} has no value here: it is declared without one on line ${sym.line}, and nothing before this gives it one`;
    const notes = c ? [{ file: c.node.file, span: { ...c.node.span, endLine: c.node.span.line, endCol: c.node.span.col + c.node.kind.length }, message: c.kind === "loop" ? "may run no turns" : c.kind === "declared" ? "declared without a value" : "a way through here leaves it unset" }] : [];
    err("S407", e, message, notes);
  }

  function walkFlow(list, unset, fn, exits = null, env = new Map()) {
    let falls = true;
    for (const s of list) {
      // No path reaches what follows (S406 is the block's own: a statement after a return, break or continue).
      if (!falls) break;
      for (const e of expressionsOf(s)) {
        if (e.kind === "name" && ["var", "let"].includes(e.symbol?.kind) && unset.has(e.symbol) && !(s.kind === "assign" && s.target === e && !s.op)) {
          if (!e.reported) unsetRead(e);
          e.reported = true;
        }
      }
      switch (s.kind) {
        case "let":
        case "var":
          // Declared here, on this path (§12.1.1); a var without a value has none yet.
          unset.delete(s.symbol);
          if (s.kind === "var" && !s.value && s.symbol && !["list", "record"].includes(s.symbol.type?.t)) (unset.add(s.symbol), cause.set(s.symbol, { kind: "declared", node: s }));
          if (s.symbol) declaredOn.add(s.symbol);
          // A let made of known values is known from here on this path (§11.1), placed as its type (§3.7.2).
          if (s.kind === "let" && s.symbol?.known) {
            const v = knownPlaced(s.value, s.symbol.type, env);
            if (v !== undefined) env.set(s.symbol, v);
          }
          break;
        case "break":
          exits?.breaks.push(new Set(unset));
          falls = false;
          break;
        case "continue":
          exits?.continues.push(new Set(unset));
          falls = false;
          break;
        case "assign":
          if (s.target.kind === "name" && s.target.symbol) unset.delete(s.target.symbol);
          break;
        case "if": {
          const known = know(s.condition, env);
          if (known === true || known === false) {
            const r = walkFlow(known ? s.then : s.otherwise, new Set(unset), fn, exits, new Map(env));
            // What only the branch never taken declares is never there after it (§12.1.1).
            for (const x of declaredBy(known ? s.otherwise : s.then)) if (!declaredOn.has(x)) r.unset.add(x);
            merge(unset, r);
            falls = r.falls;
            break;
          }
          const before = new Set(declaredOn);
          const a = walkFlow(s.then, new Set(unset), fn, exits, new Map(env));
          const da = new Set(declaredOn);
          declaredOn.clear();
          before.forEach((x) => declaredOn.add(x));
          const b = walkFlow(s.otherwise, new Set(unset), fn, exits, new Map(env));
          const db = new Set(declaredOn);
          // A let or var declared on only some paths may not be there after the if (§12.1.1).
          for (const x of new Set([...da, ...db])) if (!before.has(x) && (!da.has(x) || !db.has(x)) && ["let", "var"].includes(x.kind)) (a.falls && !da.has(x) ? a.unset.add(x) : null, b.falls && !db.has(x) ? b.unset.add(x) : null);
          declaredOn.clear();
          [...before, ...[...da].filter((x) => db.has(x))].forEach((x) => declaredOn.add(x));
          merge(unset, a, b);
          blame(unset, s, [a, b]);
          falls = a.falls || b.falls;
          break;
        }
        case "match": {
          const k = know(s.subject, env);
          if (k !== undefined) {
            const arm = s.arms.find((a) => a.values?.some((v) => V.equal(v.value, k))) ?? s.arms.find((a) => !a.values);
            const r = arm ? walkFlow(arm.body, new Set(unset), fn, exits, new Map(env)) : { unset: new Set(unset), falls: true };
            for (const a of s.arms) if (a !== arm) for (const x of declaredBy(a.body)) if (!declaredOn.has(x)) r.unset.add(x);
            merge(unset, r);
            falls = r.falls;
            break;
          }
          // Each arm a path, and without an else one more where no arm runs: an empty subject, which no value
          // equals, takes none even when every option has its arm. A let or var declared on only some of these
          // paths may not be there after the match (§12.1.1), as after an if.
          const before = new Set(declaredOn);
          const paths = s.arms.map((arm) => {
            declaredOn.clear();
            before.forEach((x) => declaredOn.add(x));
            const r = walkFlow(arm.body, new Set(unset), fn, exits, new Map(env));
            return { ...r, declared: new Set(declaredOn) };
          });
          if (!s.arms.some((a) => !a.values)) paths.push({ unset: new Set(unset), falls: true, declared: new Set(before) });
          const all = new Set(paths.flatMap((p) => [...p.declared]));
          for (const x of all) if (!before.has(x) && ["let", "var"].includes(x.kind)) for (const p of paths) if (p.falls && !p.declared.has(x)) p.unset.add(x);
          declaredOn.clear();
          [...all].filter((x) => before.has(x) || paths.every((p) => p.declared.has(x))).forEach((x) => declaredOn.add(x));
          merge(unset, ...paths);
          blame(unset, s, paths);
          falls = paths.some((e) => e.falls);
          break;
        }
        case "for":
        case "for-each":
        case "collect": {
          const turns = knownTurns(s, env);
          if (!turns) {
            // Turns not known before the form opens: it may run none, and what it gives a value is not certain
            // after it. Its body is still checked, once, with what it does not know left unknown.
            const r = walkFlow(s.body, new Set(unset), fn, { breaks: [], continues: [] }, new Map(env));
            // What only its body gives a value is left without one when it runs no turns.
            for (const v of unset) if (r.falls && !r.unset.has(v)) cause.set(v, { kind: "loop", node: s });
            break;
          }
          // Each turn starts from what the turn before left at its end or at a continue; the loop ends after its
          // last turn or at a break. No path out of it at all: every path returned.
          // A body that never reads its counter or item gives every turn that starts alike the same end: once a
          // turn starts as the one before did, the turns left change nothing.
          let start = new Set(unset);
          const breaks = [];
          const same = !readsTurn(s);
          for (const bind of turns) {
            if (!start) break;
            const ex = { breaks: [], continues: [] };
            const turnEnv = new Map(env);
            bind(turnEnv);
            const r = walkFlow(s.body, new Set(start), fn, ex, turnEnv);
            breaks.push(...ex.breaks);
            const next = [...(r.falls ? [r.unset] : []), ...ex.continues];
            const was = start;
            start = next.length ? union(next) : null;
            if (same && start && start.size === was.size && [...start].every((v) => was.has(v))) break;
          }
          const after = [...(start ? [start] : []), ...breaks];
          if (after.length) {
            unset.clear();
            for (const v of union(after)) unset.add(v);
          } else falls = false;
          break;
        }
        case "return":
          falls = false;
          break;
        default:
          break;
      }
    }
    return { unset, falls };
  }

  // A loop's turns when they are known before the form opens: a for with known bounds, a for each over a known
  // list; each turn a binding of its counter, or of its item and number, made as it is walked. Null when not
  // known, or for a collect, whose turns are the answers'. Every turn is walked, however many (§11.3.2).
  function knownTurns(s, env) {
    if (s.kind === "for") {
      const from = V.whole(know(s.from, env) ?? null), to = V.whole(know(s.to, env) ?? null);
      if (from === null || to === null) return null;
      return (function* () {
        for (let i = from; i <= to; i++) yield (turn(s), (e) => s.symbol && e.set(s.symbol, V.num(i)));
      })();
    }
    if (s.kind === "for-each") {
      const l = know(s.list, env);
      if (l === undefined || (l !== null && !Array.isArray(l))) return null;
      return (function* () {
        for (const [k, item] of (l ?? []).entries()) yield (turn(s), (e) => (e.set(s.itemSymbol, item), s.indexSymbol && e.set(s.indexSymbol, V.num(k + 1))));
      })();
    }
    return null;
  }

  // Whether a loop's body reads its counter, item or number anywhere, so that its turns may differ.
  function readsTurn(s) {
    const mine = new Set([s.symbol, s.itemSymbol, s.indexSymbol].filter(Boolean));
    for (const t of statements(s.body)) for (const e of expressionsOf(t)) if (e.kind === "name" && mine.has(e.symbol)) return true;
    return false;
  }

  // The lets and vars a block declares at its own level or in its branches (not inside loops, whose names end
  // with them).
  function declaredBy(list) {
    const out = [];
    for (const s of list) {
      if ((s.kind === "let" || s.kind === "var") && s.symbol) out.push(s.symbol);
      if (s.kind === "if") out.push(...declaredBy(s.then), ...declaredBy(s.otherwise));
      if (s.kind === "match") for (const a of s.arms) out.push(...declaredBy(a.body));
    }
    return out;
  }

  // A name left without a value on one path out of an if or match and given one on another: that construct is why.
  function blame(unset, s, ends) {
    for (const v of unset) if (ends.some((e) => e.falls && !e.unset.has(v))) cause.set(v, { kind: s.kind, node: s });
  }

  function merge(into, ...ends) {
    const after = new Set();
    for (const e of ends) if (e.falls) for (const v of e.unset) after.add(v);
    into.clear();
    for (const v of after) into.add(v);
  }

  // ----- 5. every answer used; every answered field read

  const reads = new Set(); // symbols read
  const fieldReads = new Set(); // `${decl.name}.${field}` read anywhere
  // A record used whole — printed, or compared — reads every field, through nested records and lists of them.
  const readWhole = (t, seen = new Set()) => {
    if (!t || seen.has(t)) return;
    if (t.t === "list") return readWhole(t.element, seen);
    if (t.t !== "record") return;
    seen.add(t);
    for (const f of t.decl.fields) (fieldReads.add(`${t.decl.name}.${f.name}`), readWhole(f.type, seen));
  };
  for (const { body } of bodies) {
    for (const s of statements(body)) {
      for (const e of expressionsOf(s)) {
        if (e.kind === "call" && e.callee?.kind === "native" && e.callee.name === "print") for (const a of e.args) readWhole(a.type);
        if (e.kind === "binary" && ["==", "!=", "in", "not in"].includes(e.op)) (readWhole(e.a.type), readWhole(e.b.type));
      }
    }
  }
  for (const { body } of bodies) {
    for (const s of statements(body)) {
      for (const e of expressionsOf(s)) {
        if (s.kind === "assign" && e === s.target) continue;
        if (e.kind === "name" && e.symbol) reads.add(e.symbol);
        if (e.kind === "field" && e.target.type?.t === "record") fieldReads.add(`${e.target.type.decl.name}.${e.name}`);
        // sorted(l, by: "field") reads that field of every item (§14.4).
        if (e.kind === "call" && e.sortField !== undefined) {
          const el = e.bound?.[0]?.type?.element;
          if (el?.t === "record") fieldReads.add(`${el.decl.name}.${el.decl.fields[e.sortField].name}`);
        }
      }
    }
  }
  // A name in a type's most (`list of number most m`) is read there (§5.6).
  const mostReads = (t) => {
    if (!t || typeof t !== "object") return;
    if (t.kind === "type-list") {
      if (t.most) for (const e of subexpressions(t.most)) if (e.kind === "name" && e.symbol) reads.add(e.symbol);
      mostReads(t.element);
    }
  };
  for (const { body } of bodies) for (const s of statements(body)) if (s.kind === "let" || s.kind === "var") mostReads(s.type);
  const askedInto = new Set();
  for (const { body } of bodies) for (const s of statements(body)) if (s.kind === "ask" && s.fieldPath && s.target.symbol) askedInto.add(s.target.symbol);
  for (const { body } of bodies) {
    for (const s of statements(body)) {
      if (s.kind === "ask") {
        if (s.symbol && !reads.has(s.symbol) && !session) warn("W004", s.target, `${s.symbol.name} is asked, but its answer is never used`);
        if (s.fieldPath) {
          const base = s.target.symbol?.type;
          let type = base;
          for (const name of s.fieldPath.slice(0, -1)) type = type?.decl?.fields.find((f) => f.name === name)?.type;
          const last = s.fieldPath.at(-1);
          if (type?.t === "record" && !fieldReads.has(`${type.decl.name}.${last}`) && !session) warn("W005", s.target, `${s.target.names.join(".")} is asked, but no ${type.decl.name}'s ${last} is ever read`);
        }
        // A collected item that is not a record goes into its list: reading the list reads it.
        const item = s.target.names.length === 1 && s.target.symbol?.kind === "item" ? s.target.symbol : null;
        if (item && !reads.has(item) && !(item.collected && reads.has(item.node.listSymbol)) && !session) warn("W006", s.target, `${item.name} is asked, but never read`);
      }
      // A var asked into is reported by its fields (W005), once, not again as unused.
      if ((s.kind === "let" || s.kind === "var") && s.symbol && !reads.has(s.symbol) && !s.symbol.collectedBy && !askedInto.has(s.symbol) && !session) warn("W007", { file: s.file, span: nameSpan(s.file, s.span, s.name) }, `${s.name} is never used`);
    }
  }

  // ----- 7. a constant's value, or a parameter's default, whose working out faults (§11.3)

  // The type phase marks the operation; it is reported once, here.
  const reportedFaults = new Set();
  const certainFault = (e) => {
    if (reportedFaults.has(e)) return;
    reportedFaults.add(e);
    err("S413", { file: e.file, span: e.opSpan ?? e.span }, `this faults when it is worked out, before any answer is given: ${e.knownFault.code} ${e.knownFault.message}`);
  };
  for (const r of resolved.units) for (const c of r.consts) if (c.fault) certainFault(c.fault);
  for (const f of functions) for (const p of f.params ?? []) if (p.fault) certainFault(p.fault);

  // ----- warnings: what runs, but likely not as meant

  for (const { body } of bodies) {
    for (const s of statements(body)) {
      if (s.kind === "match" && s.missing?.length) warn("W001", s, `this match has no else, and nothing happens when ${describeExpr(s.subject)} is ${s.missing.join(" or ")}`);
    }
  }
  const called = new Set();
  const usedConsts = new Set();
  for (const { body } of bodies) {
    for (const c of callsIn(body)) called.add(c.callee);
    for (const s of statements(body)) for (const e of expressionsOf(s)) if (e.kind === "name" && e.symbol?.kind === "const") usedConsts.add(e.symbol);
  }
  for (const r of resolved.units) {
    if (r.unit.library) continue;
    for (const f of r.functions) if (!called.has(f)) warn("W002", { file: f.node.file, span: nameSpan(f.node.file, f.node.span, f.name) }, `${f.name} is defined, and never called`);
    // A constant may be used where no statement is: a list's most, another constant.
    for (const c of r.consts) if (!usedConsts.has(c) && !c.referenced) warn("W003", c.node, `the constant ${c.name} is never used`);
  }

  return { functions };
}
