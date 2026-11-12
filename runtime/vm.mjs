// The Stride virtual machine (docs/spec.md §13). It runs a compiled workflow (runtime/bytecode.mjs,
// version 11) on the answers a person has given so far, and gives the questions the run reaches, in order, what
// goes into each box, the words given to print, and a fault or none. It is a stack machine with call frames: each
// call gets its own locals; values are pushed, worked on and popped.
//
// It reaches nothing outside: no network, no storage, no page. The form page (runtime/runner.js) and the command
// line call it, and do what it says.
//
// Every run ends: jumps go forward but a loop's jump back to its head, no function reaches itself (the compiler
// refuses it), and the machine stops at 2,000,000 instructions (F014) and 200 frames (F015). The bytecode is
// checked when it is loaded and each function decoded once into a list of instructions, which is what runs.
import { OP, OP_BINARY, OPERANDS, load as loadBytecode, placeAt, disassemble, MAGIC, VERSION, BytecodeError } from "./bytecode.mjs";
import { NATIVES, setToday, setPrinter, setSteps, resetCalls } from "./natives.mjs";
import { D, StrideFault, StrideRecord, StrideError, StrideFunction, StrideMap, Cell, isNull, words, printed, copy, set, dateFrom, isNumber, isSet, whole, sliced, sliceBounds, readPosition, needed, outside, expectation, emptyRecord, StrideTuple } from "./values.mjs";
import { binary, unary, truthy } from "./ops.mjs";

export { MAGIC, VERSION, disassemble, BytecodeError, StrideFault };
export const stringOf = words;

// Instructions in one run: no limit, unless the host that runs the program sets one (the limit option, or
// STRIDE_LIMIT in the environment), as a host stops a script that runs too long (§15).
const hostLimit = () => Number(globalThis.process?.env?.STRIDE_LIMIT) || Infinity;
const DEPTH = 10_000; // frames, the program's own body the first (§15, §16.3.1)

// A compiled program from its bytes, with its natives found; every run uses it as it is.
export function load(bytes) {
  const p = loadBytecode(bytes);
  p.boxIndex = new Map(p.boxes.map((b, i) => [b.name, i]));
  p.linksOf = new Map();
  for (const l of p.links) p.linksOf.set(l.key, [...(p.linksOf.get(l.key) ?? []), l]);
  p.decoded = decode(p);
  p.nativeFns = p.natives.map(({ name, params }) => {
    const n = NATIVES[name];
    if (!n) throw new BytecodeError(`the program calls the native ${name}, which this machine does not have`);
    if (n.fn.length !== params) throw new BytecodeError(`the program calls ${name} with ${params} values, and this machine's takes ${n.fn.length}`);
    return n.fn;
  });
  p.recordNames = (type) => p.records.find((r) => r.name === type)?.fields ?? null;
  return p;
}

// A host's JavaScript number as words: its shortest round-trip decimal, written as Stride writes a number (no
// exponent, §3.3.5, §8.7); null for one that is no number (NaN, an infinity).
const jsNumberWords = (n) => {
  const p = D.parseAnswer(n);
  return p.value ? words(p.value) : null;
};

// The answer a person gave, as a value of its question's type (§8.7), with the reason when it does not convert.
// Gives { value, unreadable }. A JSON number from answers.json is a number to a number question, read exactly from
// its token, and its token as words to any other.
export function convert(question, raw) {
  if (raw === undefined || raw === null) return { value: null, unreadable: null };
  if (raw instanceof D.JsonNumber) {
    if (question.type === "number") {
      const p = D.parseJsonNumber(raw.token);
      return { value: p.value, unreadable: p.unreadable ?? null };
    }
    raw = raw.token;
  }
  if (question.type === "any_of" && Array.isArray(raw)) raw = raw.map((v) => (v instanceof D.JsonNumber ? v.token : v));
  switch (question.type) {
    case "string":
    case "long_text":
    case "phone":
    case "email": {
      // Words take words, or a JSON number as written (its exact token, kept by the host); anything else is not words.
      if (typeof raw !== "string" && typeof raw !== "number" && !isNumber(raw)) return { value: null, unreadable: "not words" };
      const s = typeof raw === "string" ? raw : typeof raw === "number" ? jsNumberWords(raw) : words(raw);
      if (s === null) return { value: null, unreadable: "not words" };
      return { value: s === "" ? null : s, unreadable: null };
    }
    case "number": {
      // Words or a JSON number; anything else is not a number.
      if (typeof raw !== "string" && typeof raw !== "number" && !isNumber(raw)) return { value: null, unreadable: "not a number" };
      const p = D.parseAnswer(raw);
      return { value: p.value, unreadable: p.unreadable ?? null };
    }
    case "date": {
      if (raw === "") return { value: null, unreadable: null };
      const d = dateFrom(typeof raw === "string" ? raw : null);
      return d ? { value: d, unreadable: null } : { value: null, unreadable: "not a date" };
    }
    case "bool":
      if (raw === "") return { value: null, unreadable: null };
      // true and false, as JSON or as words; a person's yes and no, in any letter case; a check box's on and Off.
      if (raw === true || raw === "true" || raw === "on" || (typeof raw === "string" && raw.toLowerCase() === "yes")) return { value: true, unreadable: null };
      if (raw === false || raw === "false" || raw === "Off" || (typeof raw === "string" && raw.toLowerCase() === "no")) return { value: false, unreadable: null };
      return { value: null, unreadable: "not true or false" };
    case "one_of": {
      if (raw === "") return { value: null, unreadable: null };
      // One value, given as words (or a JSON number as written); a list or anything else is not one of them.
      if (typeof raw !== "string" && typeof raw !== "number" && !isNumber(raw)) return { value: null, unreadable: "not one of the options" };
      const v = typeof raw === "number" ? jsNumberWords(raw) : typeof raw === "string" ? raw : words(raw);
      return v !== null && question.options.some((o) => o.value === v) ? { value: v, unreadable: null } : { value: null, unreadable: "not one of the options" };
    }
    case "any_of": {
      // A list of values (nothing chosen: no words, or an empty list); anything else is not among them.
      if (!Array.isArray(raw) && raw !== "") return { value: null, unreadable: "not among the options" };
      // Each member words or a JSON number as written; an empty one (null, "") adds no option; any other is stray.
      const members = Array.isArray(raw) ? raw.filter((v) => v !== null && v !== "") : [];
      const given = members.filter((v) => typeof v === "string" || (typeof v === "number" && jsNumberWords(v) !== null) || isNumber(v)).map((v) => (typeof v === "number" ? jsNumberWords(v) : typeof v === "string" ? v : words(v)));
      const wrong = members.length !== given.length;
      const order = question.options.map((o) => o.value);
      const out = set(given, order);
      const stray = wrong || given.some((v) => !order.includes(v));
      return { value: out, unreadable: stray ? "not among the options" : null };
    }
    default:
      return { value: null, unreadable: null };
  }
}

// Runs the program. `answers` is { question key: answer }. Gives:
//   steps   each question the run reaches, in order: { question, index, key, printed, value, default, failed (the
//           failed checks' messages, in order), unreadable (null or the reason), answered }
//   writes  for each box the run writes (by its index in program.boxes): { kind, value }
//   prints  the words given to print, in order
//   fault   null, or { code, message, file, line, column, stack: [{ function, file, line, column }] } (innermost
//           first): the run stopped, and nothing it wrote counts (§13.4)
// `today` fixes the date today() gives for this run.
// `watch`, with the compiler's `debug` (what it kept of the source beside the bytecode), is told of the run as a
// debugger and the trace follow it: each call ({ kind: "call", fn, args }), each statement before it runs
// ({ kind: "line", fn, node, op, dst, locals }), each turn of a loop, each call of the library, each return and
// each print. `open`: a box the program names that the form does not list is taken as one of the form's
// (`onWrite` is told of each), for a program checked without its form.
export function run(p, answers = {}, { limit = hostLimit(), depth = DEPTH, trace, today = null, watch = null, debug = null, open = false, onWrite = null } = {}) {
  setToday(today);
  resetCalls();
  const prints = [];
  setPrinter((values) => {
    // The values of one print, each as it is shown alone, one space between them (§14.5).
    const text = values.map((v) => printed(v, p.recordNames)).join(" ");
    prints.push(text);
    watch?.({ kind: "print", text });
  });
  try {
    const r = execute(p, answers, limit, depth, trace, prints, debug ? watch : null, debug, open, onWrite);
    return { ...r, prints };
  } finally {
    setToday(null);
    setPrinter(null);
    setSteps(null);
  }
}

function execute(p, answers, limit, depth, trace, prints, watch, debug, open, onWrite) {
  const steps = [];
  setSteps(steps);
  const writes = new Map();
  const results = []; // a test file's expectations (§7.17.1), in order
  const subruns = []; // the expectations running now: what to undo, and where to go on after a fault
  const stack = [];
  const frames = [];
  let count = 0;
  let current = null;

  const frame = (index, args) => {
    const fn = p.functions[index];
    const locals = new Array(fn.locals).fill(null);
    for (let i = 0; i < args.length; i++) locals[i] = args[i];
    return { fn, index, locals, code: p.decoded[index], ip: 0 };
  };
  // A frame's locals as a debugger reads them: each local that has a value, with the value it holds now.
  const view = (f) => ({
    *[Symbol.iterator]() {
      const slots = debug.slots[f.index];
      for (let k = 0; k < slots.length; k++) if (slots[k] && (f.locals[k] !== null || f.given?.has(k))) yield [slots[k], f.locals[k] instanceof Cell ? f.locals[k].v : f.locals[k]];
    },
  });
  const entered = (f, args) => {
    if (!watch) return;
    f.given = new Set(args.map((_, k) => k));
    watch({ kind: "call", fn: debug.fns[f.index], args });
  };
  frames.push(frame(0, []));
  entered(frames[0], []);

  // The frame at an address: its function and its place.
  const logical = (fn, address) => {
    const place = placeAt(p, address);
    // A program without its places section (§18.1): the frame has its function and no source place.
    if (!place) return [{ function: fn.name, file: null, line: null, column: null }];
    return [{ function: fn.name, file: place.file, line: place.line, column: place.column }];
  };
  const stackTrail = (address) => {
    const out = [];
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i];
      const at = i === frames.length - 1 ? address : f.code[Math.max(0, f.ip - 1)]?.at ?? f.fn.start;
      out.push(...logical(f.fn, at));
    }
    return out;
  };
  const faultOf = (code, message, address) => {
    const trail = stackTrail(address);
    return { code, message, file: trail[0]?.file ?? null, line: trail[0]?.line ?? null, column: trail[0]?.column ?? null, stack: trail };
  };
  const fault = (code, message) => {
    throw new StrideFault(code, message);
  };

  // Which box each answer went into, as the run found it: the writes made of a question's answer, by its key.
  const links = [];
  const lastKey = [];
  const pending = [];
  const linked = (box) => {
    for (const [q, direct] of pending) if (lastKey[q] !== undefined) links.push({ key: lastKey[q], box, direct: !!direct });
    pending.length = 0;
  };

  const boxAt = (name, kind, button = null) => {
    const full = p.prefix + words(name);
    let i = p.boxIndex.get(full);
    onWrite?.(full, kind, button);
    if (i === undefined && open) {
      i = p.boxes.push({ name: full, kind, on: kind === "tick" ? "Yes" : null }) - 1;
      p.boxIndex.set(full, i);
    }
    if (i === undefined) fault("F016", `the program writes the box "${words(name)}", which it does not know`);
    return i;
  };
  // A position an item is set at (§7.5): in a list that is there (F023), from 0 to the number of items (F005).
  const setPosition = (l, i) => {
    if (isNull(l)) needed("a list is", "what an item is set in");
    if (isNull(i)) needed("a number is", "the position an item is set at");
    const n = whole(i);
    if (!Array.isArray(l)) fault("F006", "an item was set on something that is not a list");
    if (n === null || n < 0 || n > l.length) fault("F005", `position ${words(i)} cannot be set: the list holds ${l.length}`);
    return n;
  };
  const record = (r) => {
    if (r === null || r === undefined) return null;
    if (!(r instanceof StrideRecord)) fault("F006", "a field was read or set on something that is not a record");
    return r;
  };

  // A sub-run undone: the frames, stack, words printed, questions reached and boxes written as they were, and the
  // file's names holding what they held.
  const undo = (h) => {
    frames.length = h.frames;
    frames[0].locals = h.locals;
    stack.length = h.stack;
    prints.length = h.prints;
    steps.length = h.steps;
    writes.clear();
    for (const [k, v] of h.writes) writes.set(k, v);
  };
  const judge = (h, value, message, fault) => {
    const place = placeAt(p, h.at);
    results.push({ line: place?.line ?? 0, ...expectation(h.faults, value, message, fault) });
  };

  for (;;) try {
    for (;;) {
      const f = frames[frames.length - 1];
      const ins = f.code[f.ip++];
      current = ins.at;
      if (++count > limit) throw Object.assign(new StrideFault("F014", `the workflow ran more than ${limit} instructions`), { limit: true });
      const op = ins.op;
      if (trace) trace({ fn: f.fn, at: ins.at, op, stack, locals: f.locals });
      if (watch) for (const m of debug.marks.get(ins.at) ?? []) watch({ ...m, fn: debug.fns[f.index], locals: view(f) });
      const pop = () => stack.pop();
      switch (op) {
        case OP.HALT:
          return { steps, writes, results, links, fault: null };
        case OP.TEXT:
          stack.push(p.texts[ins.a]);
          break;
        case OP.NUMBER:
          stack.push(p.numbers[ins.a]);
          break;
        case OP.TRUE:
          stack.push(true);
          break;
        case OP.FALSE:
          stack.push(false);
          break;
        case OP.NULL:
          stack.push(null);
          break;
        case OP.LOAD:
          stack.push(f.locals[ins.a] instanceof Cell ? f.locals[ins.a].v : f.locals[ins.a]);
          break;
        case OP.CELL:
          f.locals[ins.a] = new Cell(pop());
          f.given?.add(ins.a);
          break;
        case OP.LOAD_CELL:
          stack.push(f.locals[ins.a]);
          break;
        case OP.STORE:
          if (f.locals[ins.a] instanceof Cell) {
            f.locals[ins.a].v = pop();
            break;
          }
          f.locals[ins.a] = pop();
          f.given?.add(ins.a);
          break;
        case OP.POP:
          pop();
          break;
        case OP.DUP:
          stack.push(stack[stack.length - 1]);
          break;
        case OP.NEW_RECORD: {
          const r = p.records[ins.a];
          stack.push(new StrideRecord(r.name, new Array(r.fields.length).fill(null), r.fields));
          break;
        }
        case OP.GET_FIELD: {
          const r = record(pop());
          if (!r) needed("a record is", "what a field is read of");
          if (ins.a >= r.fields.length) fault("F019", `field ${ins.a} of a record of ${r.fields.length} fields`);
          stack.push(r.fields[ins.a] ?? null);
          break;
        }
        case OP.SET_FIELD: {
          const v = pop();
          const r = record(pop());
          if (!r) needed("a record is", "what a field is set in");
          if (ins.a >= r.fields.length) fault("F019", `field ${ins.a} of a record of ${r.fields.length} fields`);
          r.fields[ins.a] = v;
          break;
        }
        case OP.NEW_LIST:
          stack.push(stack.splice(stack.length - ins.a, ins.a));
          break;
        case OP.GET_ITEM: {
          const i = pop();
          const l = pop();
          if (l instanceof StrideMap) {
            stack.push(l.get(i));
            break;
          }
          if (l instanceof StrideTuple) {
            stack.push(l.items[whole(i)] ?? null);
            break;
          }
          const n = readPosition(l, i);
          const items = typeof l === "string" ? [...l] : l;
          if (n >= items.length) fault("F004", outside(i, items.length, typeof l === "string"));
          stack.push(items[n] ?? null);
          break;
        }
        case OP.GET_ITEM_THERE: {
          const i = pop();
          const l = pop();
          if (l instanceof StrideMap) {
            if (!l.has(i)) fault("F020", `there is nothing under the key ${words(i)} to change`);
            stack.push(l.get(i));
            break;
          }
          const n = readPosition(l, i);
          if (n >= l.length) fault("F020", `there is no item ${n} to change: the list holds ${l.length}`);
          stack.push(l[n]);
          break;
        }
        case OP.SET_ITEM: {
          const v = pop();
          const i = pop();
          const l = pop();
          if (l instanceof StrideMap) {
            l.set(i, v);
            break;
          }
          l[setPosition(l, i)] = v;
          break;
        }
        case OP.CHECK_SLOT: {
          const i = stack[stack.length - 1];
          const l = stack[stack.length - 2];
          if (l instanceof StrideMap) {
            if (isNull(i)) needed("a key is", "the key a value is put under");
            break;
          }
          setPosition(l, i);
          break;
        }
        case OP.ENSURE_RECORD: {
          if (f.locals[ins.a] instanceof Cell) {
            if (isNull(f.locals[ins.a].v)) f.locals[ins.a].v = emptyRecord(p.records[ins.b].name, p.records[ins.b].starts, p.records[ins.b].fields);
          } else if (isNull(f.locals[ins.a])) {
            const r = p.records[ins.b];
            f.locals[ins.a] = emptyRecord(r.name, r.starts, r.fields);
          }
          break;
        }
        case OP.ENSURE_FIELD: {
          const r = record(stack[stack.length - 1]);
          if (r && isNull(r.fields[ins.a])) {
            const t = p.records[ins.b];
            r.fields[ins.a] = emptyRecord(t.name, t.starts, t.fields);
          }
          break;
        }
        case OP.ENSURE_ITEM: {
          const i = stack[stack.length - 1];
          const l = stack[stack.length - 2];
          if (l instanceof StrideMap) {
            // A record under a key not there yet is made, as a record var's is (§7.5.1).
            if (isNull(l.get(i))) {
              const t = p.records[ins.a];
              l.set(i, emptyRecord(t.name, t.starts, t.fields));
            }
            break;
          }
          const n = readPosition(l, i);
          if (n >= l.length) fault("F020", `there is no item ${n} to change: the list holds ${l.length}`);
          if (isNull(l[n])) {
            const t = p.records[ins.a];
            l[n] = emptyRecord(t.name, t.starts, t.fields);
          }
          break;
        }
        case OP.APPEND: {
          const v = pop();
          const l = f.locals[ins.a] instanceof Cell ? f.locals[ins.a].v : f.locals[ins.a];
          if (isNull(l)) needed("a list is", "what an item is added to");
          if (!Array.isArray(l)) fault("F006", "an item was added to something that is not a list");
          l.push(v);
          break;
        }
        case OP.SLICE: {
          const b = pop();
          const a = pop();
          const l = pop();
          const [x, y] = sliceBounds(l, a, b);
          stack.push(typeof l === "string" ? sliced([...l], x, y).join("") : sliced(l, x, y));
          break;
        }
        case OP.TO_BOOL:
          stack.push(truthy(pop()));
          break;
        case OP.NEG:
        case OP.NOT:
          stack.push(unary(op === OP.NEG ? "-" : "not", pop()));
          break;
        case OP.CONCAT: {
          const s = stack.splice(stack.length - ins.a, ins.a).map(words).join("");
          stack.push(s);
          break;
        }
        case OP.JUMP:
        case OP.LOOP:
          f.ip = ins.a;
          break;
        case OP.JUMP_IF_FALSE:
          if (!truthy(pop())) f.ip = ins.a;
          break;
        case OP.JUMP_IF_TRUE:
          if (truthy(pop())) f.ip = ins.a;
          break;
        case OP.CALL: {
          const args = stack.splice(stack.length - ins.b, ins.b);
          if (frames.length >= depth) fault("F015", `calls go deeper than ${depth}`);
          frames.push(frame(ins.a, args));
          entered(frames.at(-1), args);
          break;
        }
        case OP.STORE_MAIN:
          frames[0].locals[ins.a] = pop();
          frames[0].given?.add(ins.a);
          break;
        case OP.ENSURE_MAIN: {
          if (isNull(frames[0].locals[ins.a])) {
            const r = p.records[ins.b];
            frames[0].locals[ins.a] = emptyRecord(r.name, r.starts, r.fields);
          }
          break;
        }
        case OP.LOAD_MAIN:
          stack.push((frames[0].locals[ins.a] instanceof Cell ? frames[0].locals[ins.a].v : frames[0].locals[ins.a]) ?? null);
          break;
        case OP.FN:
          stack.push(new StrideFunction(p.texts[ins.b], ins.a));
          break;
        case OP.KEEP: {
          const kept = stack.splice(stack.length - ins.a, ins.a);
          const made = pop();
          stack.push(new StrideFunction(made.name, made.target, kept));
          break;
        }
        case OP.CALL_VALUE: {
          // A call of a function a value holds (§9.10): one that asks is given the key of this call (§8.6.2).
          let given = stack.splice(stack.length - ins.a, ins.a);
          const turns = words(pop()), before = words(pop()), f = pop();
          if (!(f instanceof StrideFunction)) fault("F022", "a function was called through a name that holds none");
          if (f.kept.length) given = [...f.kept, ...given];
          const args = p.functions[f.target].keyed ? [`${NATIVES.call_key.fn(before + f.name + turns)}.`, "", ...given] : given;
          if (frames.length >= depth) fault("F015", `calls go deeper than ${depth}`);
          frames.push(frame(f.target, args));
          entered(frames.at(-1), args);
          break;
        }
        case OP.RETURN:
        case OP.RETURN_NONE: {
          const v = op === OP.RETURN ? pop() : null;
          if (watch) watch({ kind: "return", fn: debug.fns[f.index], value: v, locals: view(f) });
          // A return out of a try: the try is over.
          while (subruns.length && subruns.at(-1).catch !== undefined && subruns.at(-1).frames === frames.length) subruns.pop();
          frames.pop();
          if (!frames.length) return { steps, writes, results, links, fault: null };
          stack.push(v);
          break;
        }
        case OP.NATIVE: {
          const args = stack.splice(stack.length - ins.b, ins.b);
          // The library's functions the program calls, for the trace; not the machine's own (a loop's bounds…).
          const name = watch && !debug.quiet.has(ins.at) ? p.natives[ins.a].name : null;
          const told = name && (!NATIVES[name].internal || name === "sorted_by");
          // What it was given, as it is before the call: the function may change a list or a map (§3.4).
          const given = told ? args.map((x) => copy(x)) : null;
          const value = p.nativeFns[ins.a](...args) ?? null;
          stack.push(value);
          if (told) watch({ kind: "native", name: name === "sorted_by" ? "sorted" : name, args: given, value });
          break;
        }
        case OP.ASK:
        case OP.ASK_DEFAULT: {
          // §8.4.1: the key, the printed words and the default were worked out already; now the answer.
          const q = p.questions[ins.a];
          const def = op === OP.ASK_DEFAULT ? pop() : undefined;
          const shown = words(pop());
          const key = words(pop());
          const has = Object.prototype.hasOwnProperty.call(answers, key);
          const given = has ? convert(q, answers[key]) : { value: undefined, unreadable: null };
          // The default only when the answers do not hold the key at all.
          // A words answer is never words of no characters: it is null; an any_of answer is never null: nothing
          // chosen is the set of no options (§8.7).
          const held = has ? given.value : def ?? null;
          const value = q.type === "any_of" ? held ?? set([], q.options.map((o) => o.value)) : held === "" ? null : held;
          steps.push({ question: q, index: ins.a, key, printed: shown, value, default: def, answered: has, failed: [], unreadable: given.unreadable });
          lastKey[ins.a] = key;
          stack.push(value);
          break;
        }
        case OP.FROM:
          pending.push([ins.a, ins.b]);
          break;
        case OP.CHECK_FAILED: {
          const message = words(pop());
          const step = [...steps].reverse().find((x) => x.index === ins.a);
          if (step) step.failed.push(message);
          break;
        }
        case OP.TRY:
          subruns.push({ frames: frames.length, stack: stack.length, catch: ins.a, into: ins.b });
          break;
        case OP.TRY_DONE:
          subruns.pop();
          break;
        case OP.THROW: {
          // An error is raised as the fault it holds: one that was caught, with the place it was caught from.
          const v = pop();
          if (v instanceof StrideError) throw Object.assign(new StrideFault(v.code, v.message), { origin: v.origin });
          fault("F013", words(v));
          break;
        }
        case OP.EXPECT: {
          // The sub-run works on its own copy of everything the file's names hold (§7.17.1): what it changes in a
          // list, a record or a map is dropped with it.
          const held = frames[0].locals;
          const made = new Map();
          subruns.push({ frames: frames.length, stack: stack.length, prints: prints.length, steps: steps.length, writes: new Map(writes), locals: held, at: ins.at, after: ins.a, faults: ins.b ? p.texts[ins.b - 1] : null });
          frames[0].locals = held.map((v) => copy(v, made, true));
          break;
        }
        case OP.EXPECT_DONE: {
          const message = ins.a ? null : pop();
          const value = pop();
          const h = subruns.pop();
          undo(h);
          judge(h, value, message, null);
          break;
        }
        case OP.FILL:
          writes.set(ins.a, { kind: "fill", value: words(pop()) });
          linked(ins.a);
          break;
        case OP.TICK: {
          const on = truthy(pop());
          writes.set(ins.a, { kind: "tick", value: on ? p.boxes[ins.a].on ?? "Yes" : "Off", on });
          linked(ins.a);
          break;
        }
        case OP.PICK:
          if (truthy(pop())) writes.set(ins.a, { kind: "pick", value: p.texts[ins.b] });
          linked(ins.a);
          break;
        case OP.FILL_AT: {
          const v = pop();
          const b = boxAt(pop(), "fill");
          writes.set(b, { kind: "fill", value: words(v) });
          linked(b);
          break;
        }
        case OP.TICK_AT: {
          const on = truthy(pop());
          const name = pop();
          // A box left unticked that the form does not have is nothing to untick (§10.3).
          if (!on && !open && !p.boxIndex.has(p.prefix + words(name))) break;
          const b = boxAt(name, "tick");
          writes.set(b, { kind: "tick", value: on ? p.boxes[b].on ?? "Yes" : "Off", on });
          linked(b);
          break;
        }
        case OP.PICK_AT: {
          const cond = truthy(pop());
          const button = words(pop());
          const b = boxAt(pop(), "pick", button);
          if (cond) writes.set(b, { kind: "pick", value: button });
          linked(b);
          break;
        }
        default:
          if (OP_BINARY[op]) {
            const b = pop();
            const a = pop();
            stack.push(binary(OP_BINARY[op], a, b) ?? null);
            break;
          }
          fault("F019", `unknown instruction ${op}`);
      }
    }
  } catch (e) {
    const f = e instanceof StrideFault ? e.origin ?? faultOf(e.code, e.message, current) : faultOf("F019", `the machine stopped: ${e.message}`, current);
    // A fault in an expectation stops only it (§7.17.1): undone, judged, and the file goes on after it.
    // A fault in a try goes on at its catch (§7.18); running too long is not one a program catches.
    if (e instanceof StrideFault && e.limit) while (subruns.at(-1)?.catch !== undefined) subruns.pop();
    if (subruns.length && e instanceof StrideFault && subruns.at(-1).catch !== undefined) {
      const h = subruns.pop();
      while (frames.length > h.frames) {
        const gone = frames.pop();
        if (watch) watch({ kind: "return", fn: debug.fns[gone.index], value: null, locals: view(gone) });
      }
      stack.length = h.stack;
      frames[frames.length - 1].locals[h.into] = new StrideError(e.code, e.message, f);
      frames[frames.length - 1].ip = h.catch;
      continue;
    }
    if (subruns.length && e instanceof StrideFault) {
      const h = subruns.pop();
      undo(h);
      judge(h, null, null, f);
      frames[frames.length - 1].ip = h.after;
      continue;
    }
    // A fault stops the run, and nothing it wrote counts (§13.4).
    return { steps, writes: new Map(), results, links, fault: f };
  }
}

// Each function's code decoded once, when the program is loaded: a list of instructions { op, a, b, at }, a jump's
// target the number of the instruction it goes to. The machine then runs the list, never the bytes.
function decode(p) {
  return p.functions.map((fn) => {
    const ins = [];
    const index = new Map();
    let pc = fn.start;
    const code = p.code;
    const varint = () => {
      let n = 0, shift = 0, b;
      do {
        b = code[pc++];
        n += (b & 0x7f) * 2 ** shift;
        shift += 7;
      } while (b & 0x80);
      return n;
    };
    while (pc < fn.end) {
      const at = pc;
      const op = code[pc++];
      const kinds = OPERANDS[op] ?? "";
      const args = [];
      for (const k of kinds) {
        if (k === "a") {
          args.push((code[pc] | (code[pc + 1] << 8) | (code[pc + 2] << 16) | (code[pc + 3] << 24)) >>> 0);
          pc += 4;
        } else args.push(varint());
      }
      index.set(at, ins.length);
      ins.push({ op, a: args[0], b: args[1], at, jump: kinds[0] === "a" });
    }
    for (const i of ins) if (i.jump) i.a = index.get(i.a) ?? ins.length;
    return ins;
  });
}

// What each box the program can write holds after a run: the run's writes, and for every other box the program
// knows, empty ("" for words, "Off" for a check box or a radio group). Keyed by the box's full field name.
export function boxValues(p, writes) {
  const out = {};
  p.boxes.forEach((b, i) => {
    const w = writes.get(i);
    out[b.name] = w ? w.value : b.kind === "fill" ? "" : "Off";
  });
  return out;
}

// A fault as §16.3 shows it: its code and words, where it stands, and the calls that led there.
export function faultWords(f) {
  const at = (x) => (x.line ? `${x.function}, ${x.file}:${x.line}:${x.column}` : x.function); // no place: §18.1
  const stack = f.stack?.length ? f.stack : [{ function: "main", file: f.file, line: f.line, column: f.column }];
  return [`error ${f.code}: ${f.message}`, `  at ${at(stack[0])}`, ...stack.slice(1).map((x) => `  called from ${at(x)}`)].join("\n");
}
