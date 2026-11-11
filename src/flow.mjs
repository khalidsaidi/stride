// Phase 5: check the flow. What depends on the order a program runs in, over every function and the program:
//
//   - effects: a function that asks a question, writes a box or collects a list (itself or through a function it
//     calls) has effects;
//   - a var is read only where every path to it has given it a value;
//   - a function with a result returns one on every path; nothing stands after a return;
//   - every answer is used, and every field a question answers is read somewhere.
//
// It marks: fn.effects, and loop.unroll (the loops and collects that ask or write boxes, whose questions are
// named by turn).
import { KIND, nameSpan } from "./source.mjs";
import { describeExpr } from "./check.mjs";
import { evaluate } from "./constant.mjs";
import * as V from "../runtime/values.mjs";


// `session`: the program is `stride repl`'s, read as it is typed (§17.14): a name not used yet is not a mistake.
export function flow(resolved, diagnostics, { session = false } = {}) {
  const err = (code, node, message, notes) => diagnostics.add(KIND.FLOW, node?.file ?? null, node?.span ?? null, message, notes, code);
  const warn = (code, node, message, notes = []) => diagnostics.warn(KIND.FLOW, node?.file ?? null, node?.span ?? null, message, notes, code);
  const functions = resolved.units.flatMap((r) => r.functions);
  const declaredOn = new Set(); // the lets and vars declared on the path being walked (§12.1.1)
  // Why a let or var may have no value: the latest construct that leaves it so on some path, for S407's words.
  const cause = new Map(); // symbol -> { kind: "declared" | "if" | "match" | "loop", node }
  // What a condition or a subject written out is (`if yes`, §11.3.3): never a call of a Stride function, whose
  // value the run gives.
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
      case "while":
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
      if: () => [s.condition],
      while: () => [s.condition],
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
        return e.valueCall ? [e.target, ...e.args] : e.args;
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

  // ----- 1. which functions each function calls

  const calls = new Map(functions.map((f) => [f, callsIn(f.node.body)]));

  // ----- 2. effects

  const EFFECTS = new Set(["ask", "fill", "tick", "pick", "collect"]);
  // A call of a function a name holds may ask or write (§9.10): which function it is, the run says.
  const directEffects = (body) => [...statements(body)].some((s) => EFFECTS.has(s.kind) || [...expressionsOf(s)].some((e) => e.kind === "call" && e.valueCall));
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

  // Loops and collects with effects: their questions are named by turn (§8.6).
  for (const { body } of bodies) {
    for (const s of statements(body)) {
      if (s.kind === "collect") s.unroll = true;
      if ((s.kind === "for" || s.kind === "for-each" || s.kind === "while") && hasEffects(s.body)) s.unroll = true;
    }
  }

  // ----- 4. vars given a value before they are read; returns; nothing after a return

  for (const { fn, body } of bodies) {
    const state = new Set(); // vars that may have no value yet
    const end = walkFlow(body, state, fn);

    if (fn && fn.result && fn.result.t !== "none" && fn.result.t !== "error" && end.falls) err("S405", fn.node, `${fn.name} gives ${fn.result.t === "record" ? fn.result.decl.name : fn.result.t} on some paths and nothing on others; end every path with a return`);
  }

  // S406 (§7.13): in each block, the statement after a return, break or continue there. A statement a known
  // condition passes over is not one: it is unreachable code (§11.3.3), checked but not refused.
  for (const { body } of bodies) {
    const blocks = [body, ...[...statements(body)].flatMap((s) => (s.kind === "if" ? [s.then, s.otherwise] : s.kind === "match" ? s.arms.map((a) => a.body) : ["while", "for", "for-each", "collect"].includes(s.kind) ? [s.body] : []))];
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
        case "while":
        case "collect": {
          // A loop may run no turns, and what it gives a value is not certain
          // after it. Its body is still checked, once, with what it does not know left unknown.
          const r = walkFlow(s.body, new Set(unset), fn, { breaks: [], continues: [] }, new Map(env));
          // What only its body gives a value is left without one when it runs no turns.
          for (const v of unset) if (r.falls && !r.unset.has(v)) cause.set(v, { kind: "loop", node: s });
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
    // A function used as a value is used (§9.10).
    for (const st of statements(body)) for (const e of expressionsOf(st)) if (e.functionValue) called.add(e.functionValue);
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
