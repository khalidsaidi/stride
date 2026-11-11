// Phase 8: generate the bytecode (runtime/bytecode.mjs, version 4) from the checked intermediate form. Each function's blocks are laid out in reverse post-order, so every jump goes forward but the
// jump back to a loop's head (LOOP); a jump to the block laid out next is left out. Constants are pooled; numbers
// are written as their words, exact. Every instruction that can fault or ask gets its place (file, line, column)
// in the place table.
import { BINARY_OPS, OP, QUESTION_TYPES, SECTION, VERSION, MAGIC, WRITES, Writer } from "../runtime/bytecode.mjs";
import { D, isNumber, isDate, isSet, list } from "../runtime/values.mjs";
import { NATIVES } from "../runtime/natives.mjs";
import * as IR from "./ir.mjs";

// `debug`, when given, is filled with what a debugger and the trace follow a run by (it is not written into the
// bytecode): for each function its intermediate form and the local each slot holds; the marks at instructions (a
// statement's start, a loop's turn); and the library calls that are a loop's own work.
export function generate(program, pdf, debug = null) {
  if (debug) Object.assign(debug, { fns: [], slots: [], marks: new Map(), quiet: new Set() });
  const texts = [];
  const textIndex = new Map();
  const T = (s) => {
    s = String(s ?? "");
    if (!textIndex.has(s)) textIndex.set(s, texts.push(s) - 1);
    return textIndex.get(s);
  };
  const numbers = []; // their words
  const numberIndex = new Map();
  const N = (n) => {
    const k = D.words(n);
    if (!numberIndex.has(k)) numberIndex.set(k, numbers.push(k) - 1);
    return numberIndex.get(k);
  };

  const fnIndex = new Map(program.functions.map((f, i) => [f, i]));
  const natives = [];
  const nativeIndex = (name) => (natives.includes(name) ? natives.indexOf(name) : natives.push(name) - 1);
  const records = [];
  const recordIndex = (decl) => {
    let i = records.findIndex((r) => r.decl === decl);
    if (i < 0) i = records.push({ decl, name: decl.name, fields: decl.fields.map((f) => f.name), mosts: decl.fields.map((f) => (f.type?.t === "list" && Number.isFinite(f.type.most) ? f.type.most : null)) }) - 1;
    return i;
  };
  // Every record type the program declares is in the records section, so the loader can tell that each field an
  // instruction names is one some record has (§18.3).
  for (const r of program.records) if (r.decl) recordIndex(r.decl);
  // Every question the program asks.
  const questions = [...pdf.questions];
  const known = new Map(questions.map((q, i) => [q, i]));
  const questionIndex = { has: (q) => known.has(q), get: (q) => (known.has(q) ? known.get(q) : (known.set(q, questions.push(q) - 1), questions.length - 1)) };
  const boxes = [...pdf.boxes.entries()].map(([name, b]) => ({ name, kind: b.kind, on: b.on }));
  const boxIndex = new Map(boxes.map((b, i) => [b.name, i]));

  const code = new Writer();
  const places = [];
  const functions = [];
  let mainSlots = null; // the program's own locals (the first function), for the functions that read them

  for (const fn of program.functions) {
    // Locals numbered parameters first, in the order they are passed.
    const slot = new Map();
    for (const p of fn.params) slot.set(p, slot.size);
    for (const l of fn.locals) if (!slot.has(l)) slot.set(l, slot.size);
    mainSlots ??= slot;
    const local = (l) => {
      if (!slot.has(l)) slot.set(l, slot.size);
      return slot.get(l);
    };

    // The function's instructions as a list first: { op, args, to (a label, for jumps), line }, with labels as
    // their own entries. The assembler then gives each its address.
    const ins = [];
    let place = null; // the place of the instructions emitted now: { file, line, column }
    let marks = []; // what starts at the next instruction: a statement, a loop's turn
    let quietHead = false; // working out a loop's head: its library calls are not the program's
    const emit = (op, ...args) => {
      const i = { op, args, place };
      if (marks.length) {
        i.marks = marks;
        marks = [];
      }
      if (quietHead && op === OP.NATIVE) i.quiet = true;
      ins.push(i);
      return i;
    };
    const from = (s) => (s.sources ?? []).forEach((x) => questionIndex.has(x.q) && emit(OP.FROM, questionIndex.get(x.q), x.direct ? 1 : 0));
    const label = () => ({ op: "label" });
    const placeLabel = (l) => ins.push(l);
    const jumpTo = (op, l) => {
      const i = emit(op);
      i.to = l;
    };
    // The place of what follows: a node's start, or an expression's own `at` (an operator's sign, a call's name).
    const placeOf = (span, file) => ({ file: file ?? "", line: span.line, column: span.col });
    const at = (node) => {
      if (node?.span?.line) place = placeOf(node.span, node.file?.name);
    };
    const atExpr = (x) => {
      if (x.at) place = { file: x.at.file ?? "", line: x.at.line, column: x.at.column };
    };

    function expr(x) {
      const saved = place;
      try {
        return expr1(x);
      } finally {
        place = saved;
      }
    }
    function expr1(x) {
      switch (x.e) {
        case "const":
          return value(x.v);
        case "local":
          return emit(OP.LOAD, local(x.l));
        case "unary":
          expr(x.a);
          atExpr(x);
          return emit(x.op === "-" ? OP.NEG : OP.NOT);
        case "binary":
          if (x.op === "and" || x.op === "or") {
            // Decided on the left when it can be: the right is not worked out; always yes or no (§6.15.1).
            const decided = label();
            const end = label();
            expr(x.a);
            jumpTo(x.op === "and" ? OP.JUMP_IF_FALSE : OP.JUMP_IF_TRUE, decided);
            expr(x.b);
            emit(OP.TO_BOOL);
            jumpTo(OP.JUMP, end);
            placeLabel(decided);
            emit(x.op === "and" ? OP.FALSE : OP.TRUE);
            return placeLabel(end);
          }
          expr(x.a);
          expr(x.b);
          atExpr(x);
          return emit(BINARY_OPS[x.op]);
        case "concat":
          for (const p of x.parts) expr(p);
          atExpr(x); // F012 stands at the words in quotes (§16.3.1)
          return emit(OP.CONCAT, x.parts.length);
        case "call":
          args(x);
          atExpr(x);
          return emit(OP.CALL, fnIndex.get(x.fn), x.args.length);
        case "outer": {
          // The program's local of that name, in the program's own frame; a name it never gave a value is empty.
          const l = program.outer?.get(x.sym);
          const k = l ? mainSlots.get(l) : undefined;
          return k === undefined ? emit(OP.EMPTY) : emit(OP.LOAD_MAIN, k);
        }
        case "closure":
          emit(OP.FN, fnIndex.get(x.fn), T(x.fn.keyName ?? x.fn.name));
          for (const k of x.kept) expr(k);
          return emit(OP.KEEP, x.kept.length);
        case "fnref":
          return emit(OP.FN, fnIndex.get(x.fn), T(x.fn.keyName ?? x.fn.name));
        case "callv":
          args(x);
          atExpr(x);
          return emit(OP.CALL_VALUE, x.args.length - 3);
        case "native":
          args(x);
          atExpr(x);
          return emit(OP.NATIVE, nativeIndex(x.name), x.args.length);
        case "field":
          expr(x.a);
          atExpr(x);
          return emit(OP.GET_FIELD, x.i);
        case "item":
          expr(x.a);
          expr(x.i);
          atExpr(x);
          return emit(OP.GET_ITEM);
        case "slice":
          expr(x.a);
          expr(x.from);
          expr(x.to);
          atExpr(x);
          return emit(OP.SLICE);
        case "comp": {
          // An inline loop (§6.12): the list once into a hidden local, the result built item by item.
          const src = local({ name: "comp.list" });
          const acc = local({ name: "comp.result" });
          const k = local(x.index);
          const item = local(x.item);
          const head = label();
          const skip = label();
          const end = label();
          expr(x.list);
          emit(OP.STORE, src);
          if (x.most !== null) emit(OP.NEW_LIST, 0, x.most);
          else (emit(OP.LOAD, src), emit(OP.NATIVE, nativeIndex("empty_like"), 1));
          emit(OP.STORE, acc);
          emit(OP.NUMBER, N(D.fromInt(1)));
          emit(OP.STORE, k);
          head.loopHead = true;
          placeLabel(head);
          emit(OP.LOAD, k);
          emit(OP.LOAD, src);
          emit(OP.NATIVE, nativeIndex("count"), 1).quiet = true; // the loop's own work, not a call of the program's
          emit(OP.LE);
          jumpTo(OP.JUMP_IF_FALSE, end);
          emit(OP.LOAD, src);
          emit(OP.LOAD, k);
          emit(OP.GET_ITEM);
          emit(OP.STORE, item);
          if (x.cond) {
            expr(x.cond);
            jumpTo(OP.JUMP_IF_FALSE, skip);
          }
          expr(x.value);
          emit(OP.APPEND, acc);
          placeLabel(skip);
          emit(OP.LOAD, k);
          emit(OP.NUMBER, N(D.fromInt(1)));
          emit(OP.ADD);
          emit(OP.STORE, k);
          jumpTo(OP.LOOP, head);
          placeLabel(end);
          return emit(OP.LOAD, acc);
        }
        case "cond": {
          const no = label();
          const end = label();
          expr(x.cond);
          jumpTo(OP.JUMP_IF_FALSE, no);
          expr(x.yes);
          jumpTo(OP.JUMP, end);
          placeLabel(no);
          expr(x.no);
          return placeLabel(end);
        }
        case "record":
          emit(OP.NEW_RECORD, recordIndex(x.decl));
          (x.order ?? [...x.fields.keys()]).forEach((i) => {
            const f = x.fields[i];
            if (f.e === "const" && f.v === null) return;
            emit(OP.DUP);
            expr(f);
            emit(OP.SET_FIELD, i);
          });
          return;
        case "list":
          for (const item of x.items) expr(item);
          return emit(OP.NEW_LIST, x.items.length, x.most ?? Math.max(1, x.items.length));
        default:
          throw new Error(`cannot generate the expression ${x.e}`);
      }
    }

    // A call's arguments onto the stack in their places, worked out in the order written (`order`, §9.4.1): when that
    // is another order, each into a local first.
    function args(x) {
      if (!x.order) return x.args.forEach(expr);
      const temps = x.args.map(() => local({ name: "" }));
      for (const i of x.order) (expr(x.args[i]), emit(OP.STORE, temps[i]));
      for (const t of temps) emit(OP.LOAD, t);
    }

    function value(v) {
      if (v === null || v === undefined) emit(OP.EMPTY);
      else if (v === true) emit(OP.TRUE);
      else if (v === false) emit(OP.FALSE);
      else if (isNumber(v)) emit(OP.NUMBER, N(v));
      else if (isDate(v)) (emit(OP.TEXT, T(v.iso)), emit(OP.NATIVE, nativeIndex("date_from_iso"), 1));
      else if (typeof v === "string") emit(OP.TEXT, T(v));
      else if (isSet(v)) {
        // A set keeps its options' declaration order (§3.8): its values, then the order, made a set.
        v.forEach(value);
        emit(OP.NEW_LIST, v.length, Math.max(1, v.length));
        value(list([...v.order], Math.max(1, v.order.length)));
        emit(OP.NATIVE, nativeIndex("to_set"), 2);
      } else if (Array.isArray(v)) {
        v.forEach(value);
        emit(OP.NEW_LIST, v.length, v.most ?? Math.max(1, v.length));
      } else throw new Error(`cannot generate the constant ${JSON.stringify(v)}`);
    }

    // To the place a path names (§7.5.1), leaving the record or list that holds its last step on the stack: every
    // step but the last a read — a position there checked (F004) and present (F020) — and a record made where a
    // place on the way holds empty.
    function navigate(dst, path) {
      if (path[0]?.field !== undefined && path[0].ensure) emit(OP.ENSURE_RECORD, local(dst), recordIndex(path[0].ensure));
      emit(OP.LOAD, local(dst));
      for (const p of path.slice(0, -1)) {
        if (p.field !== undefined) {
          if (p.ensureNext) emit(OP.ENSURE_FIELD, p.field, recordIndex(p.ensureNext));
          emit(OP.GET_FIELD, p.field);
        } else {
          pathPosition(p);
          atExpr(p.index);
          if (p.ensureNext) emit(OP.ENSURE_ITEM, recordIndex(p.ensureNext));
          emit(OP.GET_ITEM_THERE);
        }
      }
    }

    // A position of a path, worked out as the path reaches it, and kept in its temporary when it has one.
    function pathPosition(p) {
      expr(p.index);
      if (p.into) {
        emit(OP.DUP);
        emit(OP.STORE, local(p.into));
      }
    }

    // The last step: a position is checked as a place to set before the value is worked out (§7.5.1).
    function setLast(path, emitValue) {
      const last = path[path.length - 1];
      if (last.field !== undefined) {
        emitValue();
        emit(OP.SET_FIELD, last.field);
      } else {
        pathPosition(last);
        atExpr(last.index);
        emit(OP.CHECK_SLOT);
        emitValue();
        emit(OP.SET_ITEM);
      }
    }

    function statement(s) {
      at(s.node);
      switch (s.op) {
        case "endtry":
          return emit(OP.TRY_DONE);
        case "set":
          expr(s.value);
          return emit(OP.STORE, local(s.dst));
        case "store":
          navigate(s.dst, s.path);
          return setLast(s.path, () => expr(s.value));
        case "append":
          expr(s.value);
          return emit(OP.APPEND, local(s.dst));
        case "ask": {
          // Its key and printed words, worked out as the program runs, then its default.
          const ask = () => {
            expr(s.key);
            expr(s.printed);
            if (s.default) expr(s.default);
            emit(s.default ? OP.ASK_DEFAULT : OP.ASK, questionIndex.get(s.q));
          };
          if (!s.path.length) {
            ask();
            return emit(OP.STORE, local(s.dst));
          }
          // The answer first, then its place (§8.4.1): the default sees the record before the ask makes it.
          const answer = local({ name: "" });
          ask();
          emit(OP.STORE, answer);
          navigate(s.dst, s.path);
          return setLast(s.path, () => emit(OP.LOAD, answer));
        }
        case "expect": {
          // A test file's expectation (§7.17.1): a sub-run; after a fault the machine goes on at `after`.
          const after = label();
          const start = emit(OP.EXPECT, s.fault ? T(s.fault.v) + 1 : 0);
          start.to = after;
          expr(s.value);
          if (!s.fault) s.message ? expr(s.message) : emit(OP.EMPTY);
          emit(OP.EXPECT_DONE, s.fault ? 1 : 0);
          return placeLabel(after);
        }
        case "check": {
          // §8.4.1 step 5: the message is worked out only when the check fails.
          const passes = label();
          expr(s.cond);
          jumpTo(OP.JUMP_IF_TRUE, passes);
          expr(s.message);
          emit(OP.CHECK_FAILED, questionIndex.get(s.q));
          return placeLabel(passes);
        }
        // A box named by known words is written by its number; one whose name is worked out as the program runs
        // (Name{n} in a loop) by its name, found when it runs.
        // Before each write, the questions whose answers it is made of (form.mjs): the run says which box an
        // answer went into, for the page to show.
        case "fill":
          if (IR.isConst(s.box) && boxIndex.has(program.prefix + s.box.v)) return expr(s.value), from(s), emit(OP.FILL, boxIndex.get(program.prefix + s.box.v));
          expr(s.box);
          expr(s.value);
          from(s);
          return emit(OP.FILL_AT);
        case "tick":
          if (IR.isConst(s.box) && boxIndex.has(program.prefix + s.box.v)) return expr(s.cond), from(s), emit(OP.TICK, boxIndex.get(program.prefix + s.box.v));
          expr(s.box);
          expr(s.cond);
          from(s);
          return emit(OP.TICK_AT);
        case "pick":
          if (IR.isConst(s.box) && IR.isConst(s.button) && boxIndex.has(program.prefix + s.box.v)) return expr(s.cond), from(s), emit(OP.PICK, boxIndex.get(program.prefix + s.box.v), T(s.button.v));
          expr(s.box);
          expr(s.button);
          expr(s.cond);
          from(s);
          return emit(OP.PICK_AT);
        case "eval":
          expr(s.value);
          return emit(OP.POP);
        default:
          throw new Error(`cannot generate the statement ${s.op}`);
      }
    }

    const order = fn.order();
    const position = new Map(order.map((b, i) => [b, i]));
    const labels = new Map(order.map((b) => [b, label()]));
    const go = (from, to) => {
      if (position.get(to) === position.get(from) + 1) return;
      if (position.get(to) <= position.get(from)) {
        if (!to.loopHead) throw new Error(`a jump back to b${to.id} in ${fn.name}, which is not a loop's head`);
        jumpTo(OP.LOOP, labels.get(to));
      } else jumpTo(OP.JUMP, labels.get(to));
    };

    // A loop's head going into its body: a turn starts there.
    const turnAt = new Map();
    for (const b of order) if (b.loopHead && b.term?.op === "branch" && b.term.yes !== b.term.no) turnAt.set(b.term.yes, b.term.node);
    for (const b of order) {
      placeLabel(labels.get(b));
      if (b.loopHead) labels.get(b).loopHead = true;
      if (turnAt.has(b)) marks.push({ kind: "turn", node: turnAt.get(b) });
      for (const s of b.stmts) {
        marks.push({ kind: "line", node: s.node, op: s.op, dst: s.dst?.name });
        statement(s);
      }
      const t = b.term;
      // An if's, a match's and a return's line are statements of the program too (§17.7, §17.15).
      if (t?.node && ["if", "match", "return"].includes(t.node.kind)) marks.push({ kind: "line", node: t.node, op: t.op });
      at(t?.node);
      switch (t?.op) {
        case "try":
          emit(OP.TRY, local(t.dst)).to = labels.get(t.handler);
          go(b, t.body);
          break;
        case "jump":
          // What starts here and has no instruction yet (an if's end, an empty turn) is given one, so a debugger is
          // told of it on this way through only.
          if (debug && marks.length && position.get(t.to) === position.get(b) + 1) jumpTo(OP.JUMP, labels.get(t.to));
          else go(b, t.to);
          break;
        case "branch":
          quietHead = !!b.loopHead;
          expr(t.cond);
          quietHead = false;
          if (position.get(t.no) <= position.get(b)) {
            // The no side goes back to a loop's head: test the other way round.
            emit(OP.NOT);
            jumpTo(OP.JUMP_IF_FALSE, labels.get(t.yes));
            go(b, t.no);
          } else {
            jumpTo(OP.JUMP_IF_FALSE, labels.get(t.no));
            go(b, t.yes);
          }
          break;
        case "return":
          if (t.value) (expr(t.value), emit(OP.RETURN));
          else emit(OP.RETURN_NONE);
          break;
        case "halt":
          emit(OP.HALT);
          break;
        default:
          throw new Error(`block b${b.id} of ${fn.name} has no end`);
      }
    }

    // The assembler: each instruction's address (a jump's is always 4 bytes, so one pass gives them all), then
    // the bytes, with every jump to its label's address.
    const start = code.length;
    let address = start;
    for (const i of ins) {
      if (i.op === "label") {
        i.address = address;
        continue;
      }
      i.address = address;
      address += size(i);
    }
    for (const i of ins) {
      if (i.op === "label") continue;
      if (i.place) {
        const last = places[places.length - 1];
        const pl = i.place;
        if (!last || last.line !== pl.line || last.column !== pl.column || last.file !== pl.file) places.push({ address: i.address, ...pl });
      }
      if (debug && i.marks) debug.marks.set(i.address, i.marks);
      if (debug && i.quiet) debug.quiet.add(i.address);
      code.u8(i.op);
      if (i.to !== undefined) code.u32(i.to.address);
      for (const a of i.args) code.varint(a);
    }
    const names = [];
    for (const [l, k] of slot) names[k] = l.name ?? `t${k}`;
    if (debug) {
      debug.fns.push(fn);
      const bySlot = [];
      for (const [l, k] of slot) bySlot[k] = l;
      debug.slots.push(bySlot);
    }
    functions.push({ name: fn.name, file: fn.file ?? program.file ?? "", params: fn.params.length, localNames: names.map((n) => n ?? ""), start, end: code.length, keyed: !!fn.keyed });
  }

  // ----- the file

  for (const q of questions) T(q.name);
  for (const l of pdf.links) (T(l.key), T(pdf.keys.get(l.key)?.printed ?? ""));
  const out = new Writer();
  for (const c of MAGIC) out.u8(c.charCodeAt(0));
  out.u8(VERSION);
  const section = (tag, write) => {
    const s = new Writer();
    write(s);
    out.u8(tag);
    out.varint(s.length);
    out.raw(s.bytes);
  };
  // Every text is pooled before the text section is written.
  const fileT = (s) => T(s);
  T(program.form);
  T(program.pdf);
  T(program.prefix);
  for (const b of boxes) (T(b.name), b.on !== null && T(b.on));
  for (const r of records) (T(r.name), r.fields.forEach(T));
  for (const q of questions) {
    T(q.type);
    if (q.set) T(q.set);
    q.options.forEach((o) => (T(o.value), T(o.printed)));
    T(q.node?.file?.name ?? "");
  }
  natives.forEach(T);
  numbers.forEach(T);
  for (const f of functions) (T(f.name), T(f.file), f.localNames.forEach(T));
  for (const pl of places) T(pl.file);
  const opt = (s, v) => s.varint(v === null || v === undefined ? 0 : T(v) + 1);

  const pooled = texts.length;
  section(SECTION.TEXTS, (s) => (s.varint(texts.length), texts.forEach((x) => s.text(x))));
  section(SECTION.NUMBERS, (s) => (s.varint(numbers.length), numbers.forEach((x) => s.varint(T(x)))));
  section(SECTION.PROGRAM, (s) => (s.varint(T(program.form)), s.varint(T(program.pdf)), s.varint(T(program.prefix))));
  section(SECTION.BOXES, (s) => {
    s.varint(boxes.length);
    for (const b of boxes) (s.varint(T(b.name)), s.u8(WRITES.indexOf(b.kind)), opt(s, b.on));
  });
  section(SECTION.RECORDS, (s) => {
    s.varint(records.length);
    for (const r of records) (s.varint(T(r.name)), s.varint(r.fields.length), r.fields.forEach((f, i) => (s.varint(T(f)), s.varint(r.mosts[i] === null ? 0 : r.mosts[i] + 1))));
  });
  section(SECTION.QUESTIONS, (s) => {
    s.varint(questions.length);
    for (const q of questions) {
      s.varint(T(q.name));
      s.u8(QUESTION_TYPES.indexOf(q.type));
      opt(s, q.set);
      s.varint(q.options.length);
      for (const o of q.options) (s.varint(T(o.value)), s.varint(T(o.printed)));
      s.u8((q.hasDefault ? 1 : 0) | (q.item ? 2 : 0));
      s.varint(q.node?.span?.line ?? 0);
      s.varint(fileT(q.node?.file?.name ?? ""));
    }
  });
  section(SECTION.LINKS, (s) => {
    const links = pdf.links.filter((l) => boxIndex.has(l.box) && questionIndex.has(pdf.keys.get(l.key)?.q));
    s.varint(links.length);
    for (const l of links) {
      s.varint(T(l.key));
      s.varint(questionIndex.get(pdf.keys.get(l.key).q));
      s.varint(T(pdf.keys.get(l.key).printed ?? ""));
      s.varint(boxIndex.get(l.box));
      s.u8(l.direct ? 1 : 0);
      s.varint(l.direct && pdf.maxOf.get(l.key) && Number.isFinite(pdf.maxOf.get(l.key)) ? pdf.maxOf.get(l.key) : 0);
    }
  });
  section(SECTION.NATIVES, (s) => (s.varint(natives.length), natives.forEach((n) => (s.varint(T(n)), s.varint(NATIVES[n].fn.length)))));
  section(SECTION.FUNCTIONS, (s) => {
    s.varint(functions.length);
    for (const f of functions) {
      s.varint(T(f.name));
      s.varint(T(f.file));
      s.varint(f.params);
      s.varint(f.localNames.length);
      f.localNames.forEach((n) => s.varint(T(n)));
      s.varint(f.start);
      s.varint(f.end);
      s.u8(f.keyed ? 1 : 0);
    }
  });
  section(SECTION.CODE, (s) => (s.varint(code.length), s.raw(code.bytes)));
  section(SECTION.PLACES, (s) => {
    s.varint(places.length);
    let last = 0;
    for (const pl of places) {
      s.varint(pl.address - last);
      last = pl.address;
      s.varint(T(pl.file));
      s.varint(pl.line);
      s.varint(pl.column);
    }
  });
  if (texts.length !== pooled) throw new Error("a text was pooled after the text section was written");
  return out.done();
}

// ----- instructions

const varintSize = (n) => {
  let size = 1;
  while (n >= 128) {
    n = Math.floor(n / 128);
    size++;
  }
  return size;
};
const size = (i) => 1 + (i.to !== undefined ? 4 : 0) + i.args.reduce((n, a) => n + varintSize(a), 0);

