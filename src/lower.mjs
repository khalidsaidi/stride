// Phase 6: lower the checked syntax tree into the intermediate form (ir.mjs): the program's statements become the
// function `main`, each function a function of basic blocks.
//
// Everything runs in the machine as it is written: a loop is a loop, a for each goes through its list, a collect
// asks one item after the other until the person says no or the list's most is reached (Docassemble's gathering
// loop), a function is one function whatever it is called with. What a person is asked, and which box each
// value goes into, are worked out as the program runs:
//
//   - a question's key is built from where it is asked: its name, after the key of the function call it is in
//     (line_2(2).name), with the turn of each loop it is in after it (other_act[1]), or on the item of a list it
//     answers (representatives[2].name);
//   - a box's name, a button's and a question's printed words are expressions like any other ("Name{n}").
//
// The names written out are then looked up in the form's header (form.mjs).
//
// Two values every function with effects is given besides its parameters: the key of the call it is in (the
// prefix of its questions' keys) and the turns of the loops it was called in (their suffix).
import * as V from "../runtime/values.mjs";
import { KIND } from "./source.mjs";
import { evaluate } from "./constant.mjs";
import { textOf } from "../runtime/natives.mjs";
import * as IR from "./ir.mjs";

export function lower(resolved, diagnostics, options = {}) {
  const err = (code, node, message) => diagnostics.add(KIND.LIMIT, node?.file ?? null, node?.span ?? null, message, [], code);
  const mainResult = resolved.mainResult;
  const tree = mainResult.unit.tree;
  const program = {
    form: tree.form?.value ?? "",
    pdf: tree.pdf?.value ?? "",
    test: !!tree.test,
    script: !!tree.script,
    prefix: tree.prefix?.value ?? "",
    formNode: tree.form, // the form and pdf lines, where a mistake about the header points (S501, S502)
    pdfNode: tree.pdf,
    main: null,
    functions: [], // every function, main first
    // Every record type's name and fields, for print and key encodings in every engine (§14.5, §8.6.3).
    records: resolved.units.flatMap((r) => r.records.map((sym) => ({ name: sym.name, fields: sym.decl.fields.map((f) => f.name), decl: sym.decl }))),
  };
  const functions = new Map(); // function symbol -> Fn

  // ----- contexts

  // Where lowering stands: the function being built and its current block; what each name is (a local); the key prefix of the questions asked here (an expression), the turns of
  // the loops around them (expressions, outermost first), and the items of lists being asked about.
  const context = (fn, extra = {}) => ({ fn, block: fn.entry, locals: new Map(), prefix: IR.constant(""), suffixes: [], items: new Map(), ...extra });
  const child = (ctx, extra = {}) => ({ ...ctx, locals: new ctx.locals.constructor(ctx.locals), items: new Map(ctx.items), suffixes: [...ctx.suffixes], ...extra });

  function emit(ctx, stmt) {
    if (ctx.block.term) ctx.block = ctx.fn.block(); // after a return: a block nothing reaches, which is not generated
    ctx.block.stmts.push(stmt);
  }

  function terminate(ctx, term) {
    if (ctx.block.term) ctx.block = ctx.fn.block();
    ctx.block.term = term;
  }

  function jumpTo(ctx, target, node) {
    if (!ctx.block.term) ctx.block.term = { op: "jump", to: target, node };
    ctx.block = target;
  }

  // A value the compiler works out (§11.1), for what must be one: an option's printed words.
  function knownText(ctx, e, why) {
    const v = evaluate(e);
    if (v === undefined) {
      if (diagnostics.empty) err("S412", e, `${why} are worked out by the compiler: words, or constants`);
      return "";
    }
    return textOf(v);
  }

  // Words joined.
  const join = (...parts) => IR.concat(parts.flat());
  const suffix = (ctx, from = 0) => ctx.suffixes.slice(from);

  // ----- main

  const main = new IR.Fn("main", { result: null });
  main.entry = main.block();
  program.main = main;
  program.functions.push(main);
  // Each name of the program's top level and the local that holds it, for the functions that read it (§9.1).
  program.outer = new Map();
  class Recording extends Map {
    set(sym, l) {
      program.outer.set(sym, l);
      return super.set(sym, l);
    }
  }
  const mainCtx = context(main, { locals: new Recording() });
  lowerBlock(mainResult.main, mainCtx);
  if (!mainCtx.block.term) mainCtx.block.term = { op: "halt" };

  // ----- functions

  // Each function once. One with effects takes the key prefix and the loop turns of its call first.
  function functionOf(sym) {
    if (functions.has(sym)) return functions.get(sym);
    const fn = new IR.Fn(sym.name, { source: sym, result: sym.result });
    fn.keyed = !!sym.effects; // it takes the key of its call and the turns around it (§8.6.2)
    fn.keyName = keyName(sym);
    functions.set(sym, fn);
    program.functions.push(fn);
    fn.entry = fn.block();
    const ctx = context(fn, { fnSym: sym });
    if (sym.effects) {
      ctx.prefix = IR.local(fn.param("key", null));
      ctx.suffixes = [IR.local(fn.param("turns", null))];
    }
    // What a function made in place keeps comes first, then what it is given.
    for (const p of [...(sym.keeps ?? []), ...sym.params]) ctx.locals.set(p, fn.param(p.name, p.type));
    lowerBlock(sym.node.body, ctx);
    if (!ctx.block.term) ctx.block.term = { op: "return", value: null };
    return fn;
  }

  // One of the standard library's functions as a value (§9.10): a function that calls it with what it is given.
  function nativeOf(sym) {
    if (functions.has(sym)) return functions.get(sym);
    const fn = new IR.Fn(sym.name, { result: sym.result });
    fn.keyName = sym.name;
    functions.set(sym, fn);
    program.functions.push(fn);
    fn.entry = fn.block();
    const call = IR.native(sym.name, sym.params.map((p) => IR.local(fn.param(p.name, p.type))));
    const gives = sym.result && sym.result.t !== "none";
    if (!gives) fn.entry.stmts.push({ op: "eval", value: call, node: null });
    fn.entry.term = { op: "return", value: gives ? call : null };
    return fn;
  }

  // ----- statements

  function lowerBlock(statements, ctx) {
    for (const s of statements) lowerStatement(s, ctx);
  }

  function lowerStatement(s, ctx) {
    switch (s.kind) {
      case "ask":
        return lowerAsk(s, ctx);
      case "let":
      case "var": {
        // One declared in two branches is a place both write.
        const l = (s.symbol?.branchDeclared && ctx.locals.get(s.symbol)) || ctx.fn.local(s.name, s.symbol?.type);
        ctx.locals.set(s.symbol, l);
        // A var a function made in place shares is a new var each time its declaration runs (§9.11).
        emit(ctx, { op: "set", dst: l, fresh: !!s.symbol?.shared, value: s.value ? placeAs(expr(s.value, ctx), s.symbol?.type, s.value.type, s.value) : initial(s.symbol?.type), node: s });
        return;
      }
      case "assign":
        return lowerAssign(s, ctx);
      case "fill":
        emit(ctx, { op: "fill", box: expr(s.box, ctx), value: expr(s.value, ctx), node: s });
        return;
      case "tick":
        emit(ctx, { op: "tick", box: expr(s.box, ctx), cond: expr(s.condition, ctx), node: s });
        return;
      case "pick":
        emit(ctx, { op: "pick", box: expr(s.box, ctx), button: expr(s.button, ctx), cond: expr(s.condition, ctx), node: s });
        return;
      case "if":
        return lowerIf(s, ctx);
      case "match":
        return lowerMatch(s, ctx);
      case "try":
        return lowerTry(s, ctx);
      case "while":
        return lowerWhile(s, ctx);
      case "for":
        return lowerFor(s, ctx);
      case "for-each":
        return lowerEach(s, ctx);
      case "collect":
        return lowerCollect(s, ctx);
      case "return":
        if (!ctx.fnSym) terminate(ctx, { op: "halt", node: s });
        else terminate(ctx, { op: "return", value: s.value ? placeAs(expr(s.value, ctx), ctx.fnSym.result, s.value.type, s.value) : null, node: s });
        return;
      case "call-statement":
        if (s.call.kind === "call") emit(ctx, { op: "eval", value: expr(s.call, ctx), node: s });
        return;
      case "break":
        leaveTries(s, ctx);
        terminate(ctx, { op: "jump", to: ctx.loop.exit, node: s });
        return;
      case "continue":
        leaveTries(s, ctx);
        terminate(ctx, { op: "jump", to: ctx.loop.next, node: s });
        return;
      case "expect":
        return lowerExpect(s, ctx);
      default:
        throw new Error(`cannot lower ${s.kind}`);
    }
  }

  // A var's first value when it is declared without one: an empty list or record to fill, or empty.
  function initial(type) {
    if (type?.t === "list") return IR.list([], Number.isFinite(type.most) ? type.most : 1);
    if (type?.t === "map") return IR.native("map_of", []);
    // A record var without a value starts empty (§7.4); writing a field makes it (§7.5.1).
    return IR.constant(null);
  }

  function lowerAsk(s, ctx) {
    const names = s.target.names;
    const sym = s.target.symbol;
    let key;
    let dst;
    let answerType = sym?.type; // the type of the place the answer goes to
    const path = [];
    if (names.length === 1 && sym?.kind === "answer") {
      key = join(ctx.prefix, IR.constant(names[0]), suffix(ctx));
      // The same answer asked in another branch keeps one place, so what comes after reads either.
      dst = ctx.locals.get(sym) ?? ctx.fn.local(names[0], sym.type);
      ctx.locals.set(sym, dst);
    } else {
      const it = ctx.items.get(sym);
      const base = it ? it.base : join(ctx.prefix, IR.constant(names[0]));
      const rest = suffix(ctx, it ? it.suffixes : 0);
      key = join(base, IR.constant(names.length > 1 ? `.${names.slice(1).join(".")}` : ""), rest);
      dst = ctx.locals.get(sym);
      // The record on the way to the field is made when its place holds empty (§7.5.1).
      let type = sym.type;
      for (const name of names.slice(1)) {
        const i = type.decl.fields.findIndex((f) => f.name === name);
        path.push({ field: i, name, ensure: type.decl });
        type = type.decl.fields[i].type;
      }
      answerType = type;
      path.forEach((p, k) => {
        if (path[k + 1]?.ensure) p.ensureNext = path[k + 1].ensure;
      });
    }
    if (!dst) throw new Error(`no local for the answer ${names.join(".")}`);
    const set = s.set;
    const q = new IR.Question({
      name: names.join("."),
      type: s.question.form,
      options: set ? set.options.map((o) => ({ value: o.value, printed: knownText(ctx, o.printed, "an option's printed words"), node: o.node })) : [],
      set: set && !set.anonymous ? set.name : null,
      hasDefault: s.modifiers.some((m) => m.kind === "default"),
      check: null,
      node: s,
    });
    const def = s.modifiers.find((m) => m.kind === "default");
    // The default is placed as the answer's type (§3.6, §3.8): words for an any-of made the set, in its order.
    emit(ctx, { op: "ask", q, key, printed: expr(s.printed, ctx), dst, path, default: def ? placeAs(expr(def.value, ctx), answerType, def.value.type, def.value) : null, node: s });
    // §8.4.1 step 5: the checks, in the order written, after the answer is bound; none when it is empty.
    const checks = s.modifiers.filter((m) => m.kind === "check");
    if (checks.length) {
      let value = IR.local(dst);
      for (const p of path) value = IR.field(value, p.field, p.name);
      const run = ctx.fn.block();
      const after = ctx.fn.block();
      terminate(ctx, { op: "branch", cond: IR.native("is_empty", [value]), yes: after, no: run, node: s });
      ctx.block = run;
      for (const c of checks) emit(ctx, { op: "check", q, cond: expr(c.condition, ctx), message: expr(c.message, ctx), node: c });
      jumpTo(ctx, after, s);
    }
  }

  // An assignment (§7.5, §7.5.1): the place's positions worked out once, each as the path reaches it and checked
  // there, before the value; the records on the way made when a place holds empty. An augmented one keeps each
  // position in a temporary as it is worked out (`into`), and reads the place's current value through them.
  function lowerAssign(s, ctx) {
    const target = s.target;
    // The program's var, changed in a function: where the program holds it (§9.1).
    const root = (function rootOf(e) { return e.kind === "name" ? e : rootOf(e.target); })(target);
    const outer = ctx.fnSym && root.symbol?.program && !ctx.locals.has(root.symbol) ? root.symbol : null;
    const held = (dst) => (outer ? IR.outer(outer) : IR.local(dst));
    if (target.kind === "name") {
      const dst = ctx.locals.get(target.symbol);
      let value = expr(s.value, ctx);
      if (s.op) value = withAt(IR.binary(s.op, held(dst), value), placeOf(s, s.opSpan));
      emit(ctx, { op: "set", dst, outer, value: placeAs(value, target.symbol?.type, s.value.type, s.value), node: s });
      return;
    }
    const steps = [];
    let x = target;
    while (x.kind === "field" || x.kind === "index") {
      steps.unshift(x);
      x = x.target;
    }
    const dst = ctx.locals.get(x.symbol);
    // Each step's type, and each position, in order (§7.5.1 step 1).
    let type = x.symbol.type;
    const path = [];
    for (const st of steps) {
      if (st.kind === "field") {
        const entry = { field: st.fieldIndex, name: st.name };
        if (type?.t === "record") entry.ensure = type.decl;
        path.push(entry);
        type = type?.decl?.fields[st.fieldIndex]?.type;
      } else {
        const entry = { index: withAt(expr(st.index, ctx), placeOf(st)) };
        if (s.op) entry.into = ctx.fn.local("at", null);
        path.push(entry);
        type = type?.t === "map" ? type.value : type?.element;
      }
    }
    // Where the next step is a field, the step before may make a record of the field's holder.
    path.forEach((p, i) => {
      const next = path[i + 1];
      if (next?.field !== undefined && next.ensure) p.ensureNext = next.ensure;
    });
    let value = expr(s.value, ctx);
    if (s.op) {
      // The place's current value, read through the same temporaries.
      let read = held(dst);
      for (const p of path) read = p.field !== undefined ? IR.field(read, p.field, p.name) : IR.item(read, withAt(IR.local(p.into), p.index.at));
      value = withAt(IR.binary(s.op, read, value), placeOf(s, s.opSpan));
    }
    emit(ctx, { op: "store", dst, outer, path, value: placeAs(value, type, s.value.type, s.value), node: s });
  }

  // expect e / expect e faults "…" (§7.17): the test runner runs each as its own sub-run.
  function lowerExpect(s, ctx) {
    emit(ctx, { op: "expect", value: expr(s.value, ctx), fault: s.fault ? IR.constant(knownText(ctx, s.fault, "the fault a test expects")) : null, message: s.message ? expr(s.message, ctx) : null, node: s });
  }


  // A break or continue out of the tries the loop holds: each is over.
  function leaveTries(s, ctx) {
    for (let i = ctx.loop.tries ?? 0; i < (ctx.tries ?? 0); i++) emit(ctx, { op: "endtry", node: s });
  }

  // try { … } catch name { … } (§7.18): a fault in the try, or in what it calls, goes on at the catch, the
  // fault's words in the name.
  function lowerTry(s, ctx) {
    const body = ctx.fn.block();
    const handler = ctx.fn.block();
    const join = ctx.fn.block();
    const caught = ctx.fn.local(s.caught?.name ?? "fault", { t: "text" });
    if (s.caught?.symbol) ctx.locals.set(s.caught.symbol, caught);
    terminate(ctx, { op: "try", body, handler, dst: caught, node: s });
    ctx.block = body;
    ctx.tries = (ctx.tries ?? 0) + 1;
    lowerBlock(s.then, ctx);
    ctx.tries -= 1;
    if (!ctx.block.term) emit(ctx, { op: "endtry", node: s });
    jumpTo(ctx, join, s);
    ctx.block = handler;
    lowerBlock(s.otherwise, ctx);
    jumpTo(ctx, join, s);
  }

  function lowerIf(s, ctx) {
    const yes = ctx.fn.block();
    const no = ctx.fn.block();
    const join = ctx.fn.block();
    terminate(ctx, { op: "branch", cond: expr(s.condition, ctx), yes, no, node: s });
    ctx.block = yes;
    lowerBlock(s.then, ctx);
    jumpTo(ctx, join, s);
    ctx.block = no;
    lowerBlock(s.otherwise, ctx);
    jumpTo(ctx, join, s);
  }

  function lowerMatch(s, ctx) {
    const subject = ctx.fn.local("match", s.subject.type);
    emit(ctx, { op: "set", dst: subject, value: expr(s.subject, ctx), node: s });
    const join = ctx.fn.block();
    for (const arm of s.arms) {
      if (!arm.values) {
        lowerBlock(arm.body, ctx);
        break;
      }
      const cond = arm.values.map((v) => IR.binary("==", IR.local(subject), IR.constant(v.value))).reduce((a, b) => IR.binary("or", a, b));
      const yes = ctx.fn.block();
      const no = ctx.fn.block();
      terminate(ctx, { op: "branch", cond, yes, no, node: s });
      ctx.block = yes;
      lowerBlock(arm.body, ctx);
      jumpTo(ctx, join, arm);
      ctx.block = no;
    }
    jumpTo(ctx, join, s);
  }

  // A counted loop: its head tests the counter, its body runs, the counter goes up, back to the head. A loop
  // with effects gives each turn's questions the turn in their key: other_act[1].
  // while c { … } (§7.11.1): the condition before each turn. A loop that asks or writes boxes counts its turns, so
  // each turn's questions have their own keys (name[1], name[2], …).
  function lowerWhile(s, ctx) {
    const turn = s.unroll ? ctx.fn.local("while#turn", { t: "number" }) : null;
    if (turn) emit(ctx, { op: "set", dst: turn, value: IR.constant(V.num(1)), node: s });
    const head = ctx.fn.block();
    head.loopHead = true;
    const body = ctx.fn.block();
    const step = ctx.fn.block();
    const exit = ctx.fn.block();
    jumpTo(ctx, head, s);
    const at = child(ctx, { block: head });
    const cond = expr(s.condition, at);
    at.block.term = { op: "branch", cond, yes: body, no: exit, node: s };
    const inner = child(ctx, { block: body, loop: { exit, next: step, tries: ctx.tries ?? 0 } });
    if (turn) inner.suffixes.push(join(IR.constant("["), IR.local(turn), IR.constant("]")));
    lowerBlock(s.body, inner);
    jumpTo(inner, step, s);
    if (turn) emit(inner, { op: "set", dst: turn, value: IR.binary("+", IR.local(turn), IR.constant(V.num(1))), node: s });
    if (!inner.block.term) inner.block.term = { op: "jump", to: head, node: s };
    ctx.block = exit;
  }

  function lowerFor(s, ctx) {
    const counter = ctx.fn.local(s.counter, s.symbol.type);
    const last = ctx.fn.local(`${s.counter}.to`, s.symbol.type);
    // The bounds, once, from then to, each a whole number (§7.11: F004).
    emit(ctx, { op: "set", dst: counter, value: withAt(IR.native("loop_bound", [expr(s.from, ctx)]), placeOf(s.from, s.from.span)), node: s });
    emit(ctx, { op: "set", dst: last, value: withAt(IR.native("loop_bound", [expr(s.to, ctx)]), placeOf(s.to, s.to.span)), node: s });
    const head = ctx.fn.block();
    head.loopHead = true;
    const body = ctx.fn.block();
    const step = ctx.fn.block();
    const exit = ctx.fn.block();
    jumpTo(ctx, head, s);
    head.term = { op: "branch", cond: IR.binary("<=", IR.local(counter), IR.local(last)), yes: body, no: exit, node: s };
    const inner = child(ctx, { block: body, loop: { exit, next: step, tries: ctx.tries ?? 0 } });
    inner.locals.set(s.symbol, counter);
    if (s.unroll) inner.suffixes.push(join(IR.constant("["), IR.local(counter), IR.constant("]")));
    lowerBlock(s.body, inner);
    jumpTo(inner, step, s);
    emit(inner, { op: "set", dst: counter, value: IR.binary("+", IR.local(counter), IR.constant(V.num(1))), node: s });
    if (!inner.block.term) inner.block.term = { op: "jump", to: head, node: s };
    ctx.block = exit;
  }

  // The key an item of a list has, when the list is a name: reps, or inside an item, reps[2].children.
  function listKey(listExpr, ctx) {
    if (listExpr.kind !== "name") return null;
    const it = ctx.items.get(listExpr.symbol);
    return it ? it.base : join(ctx.prefix, IR.constant(listExpr.name));
  }

  // For each item of a list (or option of a set): its number counts from 1 to the list's length.
  function lowerEach(s, ctx) {
    // Over a map: its keys, in their order; with two names, each key and the value under it.
    const overMap = s.list.type?.t === "map";
    const mapLocal = overMap ? ctx.fn.local("map", s.list.type) : null;
    const listLocal = ctx.fn.local("each", overMap ? { t: "list", element: s.list.type.key, most: 2147483647 } : s.list.type);
    const k = ctx.fn.local(overMap ? "k" : s.index ?? "k", null);
    if (overMap) emit(ctx, { op: "set", dst: mapLocal, value: expr(s.list, ctx), node: s });
    emit(ctx, { op: "set", dst: listLocal, value: overMap ? IR.native("keys", [IR.local(mapLocal)]) : expr(s.list, ctx), node: s });
    emit(ctx, { op: "set", dst: k, value: IR.constant(V.num(1)), node: s });
    const head = ctx.fn.block();
    head.loopHead = true;
    const body = ctx.fn.block();
    const step = ctx.fn.block();
    const exit = ctx.fn.block();
    jumpTo(ctx, head, s);
    head.term = { op: "branch", cond: IR.binary("<=", IR.local(k), IR.native("count", [IR.local(listLocal)])), yes: body, no: exit, node: s };
    const inner = child(ctx, { block: body, loop: { exit, next: step, tries: ctx.tries ?? 0 } });
    const itemLocal = ctx.fn.local(s.item, s.itemSymbol.type);
    if (overMap && s.indexSymbol) {
      const keyLocal = ctx.fn.local(s.index, s.indexSymbol.type);
      emit(inner, { op: "set", dst: keyLocal, value: IR.item(IR.local(listLocal), IR.local(k)), node: s });
      emit(inner, { op: "set", dst: itemLocal, value: IR.item(IR.local(mapLocal), IR.local(keyLocal)), node: s });
      inner.locals.set(s.indexSymbol, keyLocal);
    } else {
      emit(inner, { op: "set", dst: itemLocal, value: IR.item(IR.local(listLocal), IR.local(k)), node: s });
      if (s.indexSymbol) inner.locals.set(s.indexSymbol, k);
    }
    inner.locals.set(s.itemSymbol, itemLocal);
    // An unrolled for each adds its turn, the item's number, to the keys inside it (§8.6.2).
    if (s.unroll) inner.suffixes.push(join(IR.constant("["), IR.local(k), IR.constant("]")));
    const base = overMap ? null : listKey(s.list, ctx);
    if (base) inner.items.set(s.itemSymbol, { base: join(base, IR.constant("["), IR.local(k), IR.constant("]")), suffixes: inner.suffixes.length });
    lowerBlock(s.body, inner);
    jumpTo(inner, step, s);
    emit(inner, { op: "set", dst: k, value: IR.binary("+", IR.local(k), IR.constant(V.num(1))), node: s });
    if (!inner.block.term) inner.block.term = { op: "jump", to: head, node: s };
    ctx.block = exit;
  }

  // Docassemble's gathering loop: (are there any?) then each turn asks one item and, short of the list's most,
  // whether there is another; a no ends it.
  function lowerCollect(s, ctx) {
    const listSym = s.listSymbol;
    const listLocal = ctx.locals.get(listSym);
    const type = listSym.type;
    const element = type.element;
    const base = listKey({ kind: "name", name: listSym.name, symbol: listSym }, ctx);
    const exit = ctx.fn.block();
    if (s.any) {
      const any = ctx.fn.local(`${listSym.name}.any`, null);
      const q = new IR.Question({ name: `${listSym.name}.any`, type: "yes-no", options: [], set: null, hasDefault: false, check: null, node: s, item: true });
      emit(ctx, { op: "ask", q, key: join(base, IR.constant("#any"), suffix(ctx)), printed: expr(s.any, ctx), dst: any, path: [], default: null, node: s });
      const first = ctx.fn.block();
      terminate(ctx, { op: "branch", cond: IR.local(any), yes: first, no: exit, node: s });
      ctx.block = first;
    }
    const k = ctx.fn.local(s.index ?? "k", null);
    emit(ctx, { op: "set", dst: k, value: IR.constant(V.num(1)), node: s });
    const head = ctx.fn.block();
    head.loopHead = true;
    jumpTo(ctx, head, s);
    const turn = child(ctx, { block: head });
    const itemLocal = ctx.fn.local(s.item, element);
    emit(turn, { op: "set", dst: itemLocal, value: initial(element), node: s });
    turn.locals.set(s.itemSymbol, itemLocal);
    if (s.indexSymbol) turn.locals.set(s.indexSymbol, k);
    // The item is a segment, list[n], carrying the turns of the loops since the segment before it (§8.6.2); what
    // is inside it starts its own turns. Its #another carries those turns at its end instead.
    const segment = join(base, IR.constant("["), IR.local(k), IR.constant("]"));
    const turns = suffix(ctx);
    const itemBase = join(segment, ...turns);
    turn.suffixes = [];
    turn.items.set(s.itemSymbol, { base: itemBase, suffixes: 0 });
    // Every other question in the turn, and every call that can reach one, is keyed after the item's segment:
    // kids[1].note, kids[1].who().age (§8.6.2).
    turn.prefix = join(itemBase, IR.constant("."));
    lowerBlock(s.body, turn);
    emit(turn, { op: "append", dst: listLocal, value: IR.local(itemLocal), node: s });
    // Short of the most: another?
    const ask = ctx.fn.block();
    terminate(turn, { op: "branch", cond: IR.binary("<", IR.local(k), IR.constant(V.num(type.most))), yes: ask, no: exit, node: s });
    turn.block = ask;
    const another = ctx.fn.local(`${listSym.name}.another`, null);
    const q = new IR.Question({ name: `${listSym.name}.another`, type: "yes-no", options: [], set: null, hasDefault: false, check: null, node: s, item: true });
    emit(turn, { op: "ask", q, key: join(segment, IR.constant("#another"), turns), printed: expr(s.another, ctx), dst: another, path: [], default: null, node: s });
    const next = ctx.fn.block();
    terminate(turn, { op: "branch", cond: IR.local(another), yes: next, no: exit, node: s });
    turn.block = next;
    emit(turn, { op: "set", dst: k, value: IR.binary("+", IR.local(k), IR.constant(V.num(1))), node: s });
    turn.block.term = { op: "jump", to: head, node: s };
    ctx.block = exit;
  }

  // ----- expressions

  // Where an operation that can fault stands (§16.3.1): its sign, its `[`, its function's name.
  function placeOf(e, span = e.opSpan ?? e.span) {
    return span ? { file: e.file?.name ?? "", line: span.line, column: span.col } : null;
  }
  function withAt(x, at) {
    return at ? { ...x, at } : x;
  }

  // A list value placed where a list type with most `most` is expected: widened (§3.7.2).
  function placeAs(x, type, from, node = null) {
    // A list of options placed where a set is expected becomes the set, in declaration order (§3.8).
    // The bare `empty` where a set is expected is the set with no options (§3.8): its key is {} (§8.6.3).
    if (type?.t === "options" && (from?.t === "list" || from?.t === "empty")) return IR.native("to_set", [x, IR.constant(V.list(type.set.options.map((o) => o.value), Math.max(1, type.set.options.length)))]);
    // Each level's most, `?` where it is known only as the program runs: there the value keeps the most it carries,
    // and the levels inside it are still widened (§3.9 rule 4).
    // The bare `empty` where a map goes is a map with no keys.
    if (type?.t === "map" && from?.t === "empty") return IR.native("map_of", []);
    const mostsOf = (t) => {
      const out = [];
      for (; t?.t === "list"; t = t.element) out.push(Number.isFinite(t.most) ? t.most : "?");
      while (out.at(-1) === "?") out.pop();
      return out;
    };
    const shape = mostsOf(type);
    // The bare `empty` where a list of no stated most goes is a list with no items, of most 0 (§3.7.3.1).
    if (!Number.isFinite(shape[0]) && type?.t === "list" && from?.t === "empty") return IR.constant(V.list([], 0));
    if (!shape.length) return x;
    if (mostsOf(from).join(",") === shape.join(",")) return x;
    // F017 stands at the expression placed (§16.3.1).
    return withAt(IR.native("widen", [x, IR.constant(shape.join(","))]), (node?.span ? placeOf(node, node.span) : null) ?? x.at ?? null);
  }

  // A function's name as a key writes it: after its library's use path when a library declares it (§8.6.2).
  function keyName(sym) {
    const f = sym.unit?.file?.name ?? "";
    if (!sym.unit?.library || sym.unit?.std) return sym.name;
    return `${f.replace(/^lib\//, "").replace(/\.stride$/, "")}:${sym.name}`;
  }

  function expr(e, ctx) {
    switch (e.kind) {
      case "number":
      case "yes-no":
        return IR.constant(e.value);
      case "empty":
        return IR.constant(null);
      case "plain-string":
        return IR.constant(e.value);
      case "string": {
        const parts = e.parts.map((p) => (typeof p === "string" ? IR.constant(p) : expr(p, ctx)));
        if (parts.length === 0) return IR.constant("");
        if (parts.length === 1 && parts[0].e === "const" && typeof parts[0].v === "string") return parts[0];
        return withAt(IR.concat(parts), placeOf(e, e.span));
      }
      case "lambda": {
        const fn = functionOf(e.symbol);
        return e.keeps.length ? IR.closure(fn, e.keeps.map((k) => (k.symbol.shared ? IR.cellref(ctx.locals.get(k.symbol)) : expr(k, ctx)))) : IR.fnref(fn);
      }
      case "name": {
        if (e.functionValue) return IR.fnref(e.functionValue.kind === "native" ? nativeOf(e.functionValue) : functionOf(e.functionValue));
        const sym = e.symbol;
        if (sym.kind === "const") return IR.constant(sym.value ?? null);
        // The program's own name, read in a function: where the program holds it (§9.1).
        if (ctx.fnSym && sym.program && !ctx.locals.has(sym)) return IR.outer(sym);
        const l = ctx.locals.get(sym);
        if (!l) {
          // A question asked in a branch that is not this one, or not asked yet on this path: it is empty here.
          const fresh = ctx.fn.local(sym.name, sym.type);
          ctx.locals.set(sym, fresh);
          return IR.local(fresh);
        }
        return IR.local(l);
      }
      case "unary":
        return withAt(IR.unary(e.op, expr(e.operand, ctx)), placeOf(e, e.span));
      case "is-empty": {
        const test = IR.native("is_empty", [expr(e.operand, ctx)]);
        return e.not ? IR.unary("not", test) : test;
      }
      case "binary": {
        let a = expr(e.a, ctx);
        let b = expr(e.b, ctx);
        // A set and a list of its option values: the list as a set (§3.6, §6.6).
        const asSet = (x, t) => IR.native("to_set", [x, IR.constant(V.list(t.set.options.map((o) => o.value), Math.max(1, t.set.options.length)))]);
        if (e.a.type?.t === "options" && e.b.type?.t === "list") b = asSet(b, e.a.type);
        if (e.b.type?.t === "options" && e.a.type?.t === "list") a = asSet(a, e.b.type);
        // Lists joined take the joined type: their items widened to it (§3.9, §6.5.1).
        if (e.op === "+" && e.type?.t === "list") return placeAs(withAt(IR.binary("+", a, b), placeOf(e)), e.type, null, e);
        return withAt(IR.binary(e.op, a, b), placeOf(e));
      }
      case "cond":
        return IR.cond(expr(e.condition, ctx), placeAs(expr(e.yes, ctx), e.type, e.yes.type, e.yes), placeAs(expr(e.no, ctx), e.type, e.no.type, e.no));
      case "field": {
        const read = withAt(IR.field(expr(e.target, ctx), e.fieldIndex, e.name), placeOf(e, e.target.span ? { line: e.span.line, col: e.span.col } : e.span));
        // A list field of an empty record is an empty list of the field's declared most, so its positions read
        // as any such list's do (§6.9.1, §3.7.1, §6.9.2).
        return e.type?.t === "list" && Number.isFinite(e.type.most) ? IR.native("field_list", [read, IR.constant(String(e.type.most))]) : read;
      }
      case "index":
        return withAt(IR.item(expr(e.target, ctx), expr(e.index, ctx)), placeOf(e));
      case "slice":
        return withAt(IR.slice(expr(e.target, ctx), expr(e.from, ctx), expr(e.to, ctx)), placeOf(e));
      case "comprehension": {
        // [e for each n, x in l if c]: its own loop, inside the expression (§6.12).
        const inner = child(ctx);
        const item = ctx.fn.local(e.item, e.itemSymbol.type);
        // Over a map with two names: each key and the value under it.
        const pairs = e.overMap && e.indexSymbol;
        const index = ctx.fn.local(pairs ? "n" : e.index ?? "n", null);
        const key = pairs ? ctx.fn.local(e.index, e.indexSymbol.type) : null;
        inner.locals.set(e.itemSymbol, item);
        if (e.indexSymbol) inner.locals.set(e.indexSymbol, pairs ? key : index);
        return {
          e: "comp",
          list: e.overMap && !pairs ? IR.native("keys", [expr(e.list, ctx)]) : expr(e.list, ctx),
          key,
          item,
          index,
          cond: e.condition ? expr(e.condition, inner) : null,
          value: expr(e.value, inner),
          // Its list's most (§3.7.5): known here, or, from a parameter without `most`, the list's own as it runs.
          most: Number.isFinite(e.type?.most) ? e.type.most : null,
        };
      }
      case "call": {
        // A call of a function a name holds (§9.10).
        if (e.valueCall) {
          const given = e.args.map((a, i) => placeAs(expr(a, ctx), e.valueType.params[i], a.type, a));
          return withAt(IR.callv([expr(e.target, ctx), join(ctx.prefix), join(suffix(ctx)), ...given]), placeOf(e, e.target.span));
        }
        const sym = e.callee;
        const params = sym.params ?? [];
        const bound = e.bound ?? e.args;
        // Every argument bound to its parameter (defaults filled in, §9.4.1), each placed as its parameter's type.
        const args = bound.map((a, i) => (a.kind === "default-of" ? IR.constant(a.param.defaultValue ?? null) : placeAs(expr(a, ctx), e.placedAs?.[i] ?? params[i]?.type, a.type, a)));
        // Arguments are worked out as written, left to right, whatever parameters they bind (§9.4.1).
        const written = (x) => e.args.findIndex((a) => a === x || a.value === x);
        const order = bound.map((_, i) => i).sort((i, j) => (written(bound[i]) < 0 ? Infinity : written(bound[i])) - (written(bound[j]) < 0 ? Infinity : written(bound[j])));
        const ordered = (x, offset = 0) => (order.some((k, i) => k !== i) ? { ...x, order: [...Array(offset).keys(), ...order.map((k) => k + offset)] } : x);
        const at = placeOf(e, e.target.span);
        if (sym.kind === "native") {
          if (sym.name === "sorted" && e.sortField !== undefined) return withAt(IR.native("sorted_by", [args[0], IR.constant(V.num(e.sortField)), args[1]]), at);
          // Words in quotes given to a set operation are made the set they name (§3.6).
          // Both of either's values placed as their join (§3.9): either(a, [n, n]) is a list of the larger most.
          if (e.joined) args.forEach((a, i) => (args[i] = placeAs(a, e.joined, bound[i]?.type, bound[i])));
          if (e.setOperand) args.forEach((a, i) => bound[i]?.type?.t === "list" && (args[i] = placeAs(a, e.setOperand, bound[i].type, bound[i])));
          return withAt(ordered(IR.native(sym.name, args)), at);
        }
        const fn = functionOf(sym);
        if (!sym.effects) return withAt(ordered(IR.call(fn, args)), at);
        // §8.6.2: a call that can reach questions adds its segment: the function's name, then the turns of the loops
        // around it; a second call of it there in the same run is name#2, a third name#3.
        const key = join(IR.native("call_key", [join(ctx.prefix, IR.constant(keyName(sym)), suffix(ctx))]), IR.constant("."));
        return withAt(ordered(IR.call(fn, [key, IR.constant(""), ...args]), 2), at);
      }
      case "map":
        return e.entries.reduce((m, x) => IR.native("map_put", [m, expr(x.key, ctx), expr(x.value, ctx)]), IR.native("map_of", []));
      case "list":
        // Each item widened to the literal's element type (§3.9).
        return IR.list(e.items.map((x) => placeAs(expr(x, ctx), e.type?.element, x.type, x)), Math.max(1, e.items.length));
      case "new": {
        const decl = e.recordSymbol.decl;
        const record = IR.record(decl, decl.fields.map((f) => {
          const given = e.fields.find((x) => x.name === f.name);
          return given ? placeAs(expr(given.value, ctx), f.type, given.value.type, given.value) : initial(f.type);
        }));
        // The fields given are worked out as written (§6.2), the others after.
        const at = (i) => e.fields.findIndex((x) => x.name === decl.fields[i].name);
        const order = decl.fields.map((_, i) => i).sort((i, j) => (at(i) < 0 ? Infinity : at(i)) - (at(j) < 0 ? Infinity : at(j)));
        return order.some((k, i) => k !== i) ? { ...record, order } : record;
      }
      default:
        throw new Error(`cannot lower ${e.kind}`);
    }
  }

  return program;
}
