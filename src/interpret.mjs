// An interpreter for the intermediate form: it runs a lowered program the way the virtual machine runs its
// bytecode, from the same values (runtime/values.mjs), operators (runtime/ops.mjs) and natives.
// Two uses:
//
//   - the debugger and --trace follow a program here, line by line, and the PDF check runs a pure function here
//     on known arguments;
//   - the conformance suite runs every test here and in the machine, and they must agree on
//     every question, box, print and fault (docs/spec.md §19.1): generated code that does not do what the
//     intermediate form says is a fault in the compiler, caught where it starts.
import { NATIVES, setToday, setPrinter, resetCalls } from "../runtime/natives.mjs";
import { binary, unary, truthy } from "../runtime/ops.mjs";
import { convert } from "../runtime/vm.mjs";
import { StrideFault, StrideRecord, StrideFunction, isEmpty, words, printed, copy, list, mostOf, set, whole, encode, dateFrom, num, expectation, emptyRecord } from "../runtime/values.mjs";

const DEPTH = 200;

// Runs `fn` with `args`. `answers` is { key: answer } as the machine takes them; `boxes` the PDF check's box map
// (full name -> { kind, on }) for the export value a tick writes. Gives { value, steps, writes, prints } with
// writes keyed by the box's full name, as the machine's boxValues gives them. A fault is thrown as a StrideFault
// with its logical stack in `trail`.
// A record type's field mosts, for the records made on the way to a field (§7.5.1).
const fieldMosts = (decl) => decl.fields.map((f) => (f.type?.t === "list" && Number.isFinite(f.type.most) ? f.type.most : null));

// `watch`, when given, is told of each call, each statement before it runs, each return, each call of the
// library and each turn of a loop (`stride run --trace`, §17.7): { kind: "call", fn, args } | { kind: "line", fn,
// node, locals } | { kind: "return", fn, value } | { kind: "native", name, args, value } | { kind: "turn", fn,
// node, locals } | { kind: "print", text }: a line the run prints, as it prints it.
export function interpret(program, fn, args = [], { answers = {}, boxes = new Map(), limit = 2_000_000, depth = DEPTH, watch = null, onWrite = null } = {}) {
  const steps = [];
  const writes = new Map();
  const prints = [];
  const results = []; // a test file's expectations (§7.17.1), in order
  let count = 0;
  let quiet = false; // working out a loop's head, whose calls the trace does not show
  const calls = []; // { fn, call: place of its call } for each frame, outermost first
  let place = null; // the place of what runs now: { file, line, column }
  const recordNames = (type) => (program.records ?? []).find((r) => r.name === type)?.fields ?? null;
  setPrinter((v) => {
    const text = printed(v, recordNames);
    prints.push(text);
    watch?.({ kind: "print", text });
  });

  const placeOf = (node) => (node?.span?.line ? { file: node.file?.name ?? "", line: node.span.line, column: node.span.col } : place);
  const exprPlace = (x) => (x.at ? { file: x.at.file ?? "", line: x.at.line, column: x.at.column } : place);

  // The stack at a place: the place, then each frame's call.
  function trail(at) {
    const out = [];
    let here = at;
    for (let i = calls.length - 1; i >= 0; i--) {
      const f = calls[i];
      const pos = here ? { file: here.file, line: here.line, column: here.column } : { file: null, line: null, column: null };
      out.push({ function: f.fn.name, ...pos });
      here = f.call;
    }
    return out;
  }
  const fault = (code, message, at = place) => {
    const e = new StrideFault(code, message);
    e.trail = trail(at);
    throw e;
  };
  const guard = (f, at) => {
    try {
      return f();
    } catch (e) {
      if (e instanceof StrideFault && !e.trail) {
        e.trail = trail(at);
      }
      throw e;
    }
  };

  function call(f, values, callPlace) {
    if (calls.length >= depth) fault("F015", `calls go deeper than ${depth}`, callPlace);
    calls.push({ fn: f, call: callPlace });
    watch?.({ kind: "call", fn: f, args: values });
    try {
      const locals = new Map();
      f.params.forEach((p, i) => locals.set(p, copy(values[i] ?? null)));
      let block = f.entry;
      for (;;) {
        for (const s of block.stmts) {
          watch?.({ kind: "line", fn: f, node: s.node, op: s.op, dst: s.dst?.name, locals });
          statement(s, locals);
        }
        const t = block.term;
        // An if's, a match's and a return's line are statements of the program too (§17.7, §17.15).
        if (watch && t?.node && ["if", "match", "return"].includes(t.node.kind)) watch({ kind: "line", fn: f, node: t.node, op: t.op, locals });
        place = placeOf(t?.node) ?? place;
        if (++count > limit) fault("F014", `the workflow ran more than ${limit} instructions`);
        switch (t.op) {
          case "jump":
            block = t.to;
            break;
          case "branch": {
            const head = block;
            // A loop's head asks whether to go on (its counter against its bound, its items' count): the loop's own
            // work, not the program's calls.
            quiet = head.loopHead;
            block = truthy(expr(t.cond, locals)) ? t.yes : t.no;
            quiet = false;
            // A loop's head going into its body: a turn starts.
            if (watch && head.loopHead && block === t.yes && t.yes !== t.no) watch({ kind: "turn", fn: f, node: t.node, locals });
            break;
          }
          case "return": {
            const value = t.value ? expr(t.value, locals) : null;
            watch?.({ kind: "return", fn: f, value });
            return value;
          }
          case "halt":
            return null;
          default:
            throw new Error(`a block of ${f.name} has no end`);
        }
      }
    } finally {
      calls.pop();
    }
  }

  // A list position read (§6.9.2).
  function readPosition(l, i, at) {
    const n = whole(i);
    if (n === null || n < 1) fault("F004", `${isEmpty(i) ? "an empty position" : `position ${words(i)}`} is not a whole number of 1 or more`, at);
    return n;
  }

  // Walks a place's path for an assignment or an answer (§7.5.1): every step but the last a read; records made
  // where a place holds empty. Gives the container the last step changes.
  function walk(locals, dst, path) {
    let holder = locals.get(dst) ?? null;
    if (path.length && path[0].field !== undefined && isEmpty(holder) && path[0].ensure) {
      holder = emptyRecord(path[0].ensure.name, fieldMosts(path[0].ensure), path[0].ensure.fields.map((f) => f.name));
      locals.set(dst, holder);
    }
    for (let k = 0; k < path.length - 1; k++) {
      const step = path[k];
      const next = path[k + 1];
      if (step.field !== undefined) {
        if (!(holder instanceof StrideRecord)) fault("F006", "a field was set on something that is not a record");
        if (isEmpty(holder.fields[step.field]) && next.field !== undefined && step.ensureNext) holder.fields[step.field] = emptyRecord(step.ensureNext.name, fieldMosts(step.ensureNext), step.ensureNext.fields.map((f) => f.name));
        holder = holder.fields[step.field];
      } else {
        const i = expr(step.index, locals);
        if (step.into) locals.set(step.into, i);
        const at = exprPlace(step.index) ?? place;
        const n = readPosition(holder, i, at);
        if (n > holder.length) fault("F020", `there is no item ${n} to change: the list holds ${holder.length}`, at);
        if (isEmpty(holder[n - 1]) && next.field !== undefined && step.ensureNext) holder[n - 1] = emptyRecord(step.ensureNext.name, fieldMosts(step.ensureNext), step.ensureNext.fields.map((f) => f.name));
        holder = holder[n - 1];
      }
    }
    return holder;
  }

  function setLast(holder, last, value, locals) {
    if (last.field !== undefined) {
      if (!(holder instanceof StrideRecord)) fault("F006", "a field was set on something that is not a record");
      holder.fields[last.field] = copy(value);
      return;
    }
    const i = expr(last.index, locals);
    const n = whole(i);
    if (!Array.isArray(holder)) fault("F006", "an item was set on something that is not a list");
    if (n === null || n < 1 || n > holder.length + 1 || n > mostOf(holder)) fault("F005", `${isEmpty(i) ? "an empty position" : `position ${words(i)}`} cannot be set: the list holds ${holder.length} of at most ${mostOf(holder)}`, exprPlace(last.index));
    holder[n - 1] = copy(value);
  }

  function statement(s, locals) {
    place = placeOf(s.node) ?? place;
    if (++count > limit) fault("F014", `the workflow ran more than ${limit} instructions`);
    switch (s.op) {
      case "set":
        locals.set(s.dst, copy(expr(s.value, locals)));
        return;
      case "store": {
        // The place first, then the value (§7.5.1).
        const holder = walk(locals, s.dst, s.path);
        const last = s.path[s.path.length - 1];
        if (last.index !== undefined) {
          // The last position is checked as a place to set before the value is worked out.
          const i = expr(last.index, locals);
          if (last.into) locals.set(last.into, i);
          const n = whole(i);
          if (!Array.isArray(holder)) fault("F006", "an item was set on something that is not a list");
          if (n === null || n < 1 || n > holder.length + 1 || n > mostOf(holder)) fault("F005", `${isEmpty(i) ? "an empty position" : `position ${words(i)}`} cannot be set: the list holds ${holder.length} of at most ${mostOf(holder)}`, exprPlace(last.index));
          const v = expr(s.value, locals);
          holder[n - 1] = copy(v);
          return;
        }
        const v = expr(s.value, locals);
        setLast(holder, last, v, locals);
        return;
      }
      case "append": {
        const l = locals.get(s.dst);
        if (!Array.isArray(l)) fault("F006", "an item was added to something that is not a list");
        const v = expr(s.value, locals);
        if (l.length >= mostOf(l)) fault("F017", `the list already holds its most, ${mostOf(l)}`);
        l.push(copy(v));
        return;
      }
      case "ask": {
        const key = words(expr(s.key, locals));
        const shown = words(expr(s.printed, locals));
        const def = s.default ? expr(s.default, locals) : undefined;
        const has = Object.prototype.hasOwnProperty.call(answers, key);
        const given = has ? convert(s.q, answers[key]) : { value: undefined, unreadable: null };
        const value = has ? given.value : def !== undefined ? def : s.q.type === "any-of" ? set([], s.q.options.map((o) => o.value)) : null;
        steps.push({ key, printed: shown, value, default: def, answered: has, failed: [], unreadable: given.unreadable, question: s.q });
        if (!s.path.length) locals.set(s.dst, copy(value));
        else setLast(walk(locals, s.dst, s.path), s.path[s.path.length - 1], value, locals);
        return;
      }
      case "expect": {
        // Its own sub-run (§7.17.1): what it reaches, prints and writes is dropped; a fault stops only it.
        const saved = { calls: calls.length, prints: prints.length, steps: steps.length, writes: new Map(writes), place };
        let value = null, message = null, caught = null;
        try {
          value = expr(s.value, locals);
          if (s.message) message = expr(s.message, locals);
        } catch (e) {
          if (!(e instanceof StrideFault)) throw e;
          caught = e;
        }
        calls.length = saved.calls;
        prints.length = saved.prints;
        steps.length = saved.steps;
        writes.clear();
        for (const [k, v] of saved.writes) writes.set(k, v);
        place = saved.place;
        const at = placeOf(s.node);
        results.push({ line: at?.line ?? 0, ...expectation(s.fault ? s.fault.v : null, value, message, caught) });
        return;
      }
      case "check": {
        if (!truthy(expr(s.cond, locals))) {
          const message = words(expr(s.message, locals));
          const step = [...steps].reverse().find((x) => x.question === s.q);
          if (step) step.failed.push(message);
        }
        return;
      }
      case "fill": {
        const name = words(expr(s.box, locals));
        const w = words(expr(s.value, locals));
        onWrite?.(program.prefix + name, "fill", null);
        writes.set(boxAt(name), w);
        return;
      }
      case "tick": {
        const name = words(expr(s.box, locals));
        const on = truthy(expr(s.cond, locals));
        onWrite?.(program.prefix + name, "tick", null);
        const box = boxAt(name);
        writes.set(box, on ? boxes.get(box)?.on ?? "Yes" : "Off");
        return;
      }
      case "pick": {
        const name = words(expr(s.box, locals));
        const button = words(expr(s.button, locals));
        const cond = truthy(expr(s.cond, locals));
        onWrite?.(program.prefix + name, "pick", button);
        const box = boxAt(name);
        if (cond) writes.set(box, button);
        return;
      }
      case "eval":
        expr(s.value, locals);
        return;
      default:
        throw new Error(`cannot interpret ${s.op}`);
    }
  }

  // Parts worked out in the order the program wrote them (`order`: the part worked out first, then second, …), given
  // back in their places.
  function inOrder(x, parts, locals) {
    const out = new Array(parts.length);
    for (const i of x.order ?? parts.keys()) out[i] = expr(parts[i], locals);
    return out;
  }

  // A box by the name the program gives it: one of the form's, else F016 (as the machine, runtime/vm.mjs).
  const boxAt = (name) => {
    const full = program.prefix + name;
    if (boxes.size && !boxes.has(full)) fault("F016", `the program writes the box "${name}", which it does not know`);
    return full;
  };

  function expr(x, locals) {
    switch (x.e) {
      case "const":
        return copy(x.v);
      case "local":
        return locals.has(x.l) ? locals.get(x.l) : null;
      case "unary": {
        const a = expr(x.a, locals);
        return guard(() => unary(x.op, a), exprPlace(x));
      }
      case "binary": {
        const a = expr(x.a, locals);
        if (x.op === "and") return truthy(a) ? truthy(expr(x.b, locals)) : false;
        if (x.op === "or") return truthy(a) ? true : truthy(expr(x.b, locals));
        const b = expr(x.b, locals);
        return guard(() => binary(x.op, a, b), exprPlace(x)) ?? null;
      }
      case "concat": {
        const s = x.parts.map((p) => words(expr(p, locals))).join("");
        if ([...s].length > 100_000) fault("F012", "the words would be more than 100000 characters", exprPlace(x));
        return s;
      }
      case "cond":
        return truthy(expr(x.cond, locals)) ? expr(x.yes, locals) : expr(x.no, locals);
      case "call": {
        const values = inOrder(x, x.args, locals).map(copy);
        const at = exprPlace(x);
        return call(x.fn, values, at);
      }
      case "fnref":
        return new StrideFunction(x.fn.keyName ?? x.fn.name, x.fn);
      case "callv": {
        // A call of a function a value holds (§9.10), as the machine makes it.
        const [f, before, turns, ...given] = x.args.map((a) => expr(a, locals));
        const at = exprPlace(x);
        if (!(f instanceof StrideFunction)) fault("F022", "a function was called through a name that holds none", at);
        const args = f.target.keyed ? [`${NATIVES.call_key.fn(words(before) + f.name + words(turns))}.`, "", ...given.map(copy)] : given.map(copy);
        return call(f.target, args, at);
      }
      case "native": {
        const values = inOrder(x, x.args, locals);
        const value = guard(() => NATIVES[x.name].fn(...values), exprPlace(x)) ?? null;
        // The library's functions the program calls, for the trace; not the machine's own (a loop's bounds…).
        if (watch && !quiet && (!NATIVES[x.name].internal || x.name === "sorted_by")) watch({ kind: "native", name: x.name === "sorted_by" ? "sorted" : x.name, args: values, value });
        return value;
      }
      case "field": {
        const r = expr(x.a, locals);
        if (r === null || r === undefined) return null;
        if (!(r instanceof StrideRecord)) fault("F006", "a field was read on something that is not a record", exprPlace(x));
        return r.fields[x.i] ?? null;
      }
      case "item": {
        const l = expr(x.a, locals);
        const i = expr(x.i, locals);
        const n = readPosition(l, i, exprPlace(x));
        return l[n - 1] ?? null;
      }
      case "slice": {
        const l = expr(x.a, locals);
        const a = whole(expr(x.from, locals));
        const b = whole(expr(x.to, locals));
        if (a === null || b === null) fault("F004", "a slice's bounds are whole numbers", exprPlace(x));
        const from = Math.max(1, a);
        const to = Math.min(Array.isArray(l) ? l.length : 0, b);
        return list(from > to ? [] : l.slice(from - 1, to).map(copy), mostOf(l));
      }
      case "key":
        return encode(expr(x.a, locals), recordNames);
      case "comp": {
        const l = expr(x.list, locals);
        const items = Array.isArray(l) ? l : [];
        const out = [];
        for (let k = 0; k < items.length; k++) {
          locals.set(x.item, copy(items[k]));
          locals.set(x.index, num(k + 1));
          if (x.cond && !truthy(expr(x.cond, locals))) continue;
          out.push(copy(expr(x.value, locals)));
        }
        return list(out, x.most ?? mostOf(l));
      }
      case "record":
        return new StrideRecord(x.decl.name, inOrder(x, x.fields, locals).map(copy), x.decl.fields.map((f) => f.name));
      case "list":
        return list(x.items.map((i) => copy(expr(i, locals))), x.most ?? Math.max(1, x.items.length));
      default:
        throw new Error(`cannot interpret the expression ${x.e}`);
    }
  }

  try {
    const value = call(fn, args, null);
    return { value, steps, writes, prints, results };
  } catch (e) {
    // What the run reached before it stopped is the report's, as the machine's is.
    if (e && typeof e === "object") (e.steps = steps), (e.prints = prints), (e.results = results);
    throw e;
  } finally {
    setPrinter(null);
  }
}

// Runs a whole program on answers: what the machine's run gives, from the intermediate form. A fault is given
// back, as the machine gives it, not thrown; nothing the run wrote counts.
export function interpretProgram(program, answers, boxes, { today = null, limit = 2_000_000, watch = null, onWrite = null } = {}) {
  setToday(today);
  resetCalls();
  const collected = { steps: [], prints: [] };
  try {
    const r = interpret(program, program.main, [], { answers, boxes, limit, watch, onWrite });
    return { ...r, fault: null };
  } catch (e) {
    if (e instanceof StrideFault) {
      const t = e.trail ?? [];
      return { value: null, steps: e.steps ?? collected.steps, writes: new Map(), prints: e.prints ?? [], results: e.results ?? [], fault: { code: e.code, message: e.message, file: t[0]?.file ?? null, line: t[0]?.line ?? null, column: t[0]?.column ?? null, stack: t } };
    }
    return { value: null, steps: e?.steps ?? [], writes: new Map(), prints: e?.prints ?? [], fault: { code: "F019", message: `the machine stopped: ${e?.message}`, stack: [] } };
  } finally {
    setToday(null);
  }
}

export { dateFrom };
