// Stride's bytecode, version 10 (docs/spec.md §18): what the compiler writes (src/codegen.mjs) and the
// machine reads (runtime/vm.mjs). A file is "STRD", the version, then sections, each a tag, its length and
// its bytes, so a reader can skip a section it does not know:
//
//    1 texts      every text the program uses, once
//    2 numbers    every number constant, as its words (§3.3.5): exact, never a binary float
//    3 program    the form's id, the PDF's sha256, the prefix of its field names
//    4 boxes      each box the program writes: its name, how (fill, tick, pick), its export value
//    5 records    each record type: its name, its fields' names and what each starts as (null, a list, a map)
//    6 questions  each question as written: its name, type, option set, options, flags, line, file
//    7 natives    the natives the code calls: name and how many values each takes
//    8 functions  each function: name, file, parameters, its locals' names, where its code starts and ends, whether it takes its call's key
//    9 code       the instructions
//   10 places     the place (file, line, column) of every instruction that can fault or ask
//   11 links      for each question whose key is written out, the boxes its answer goes into
//
// Integers are unsigned LEB128 varints; a text is its UTF-8 length, then its bytes; jump addresses are 4 bytes,
// little-endian, counted from the start of the code.
import { D } from "./values.mjs";

export const MAGIC = "STRD";
export const VERSION = 10;

// What a field of a record made on the way to a field starts as (§7.5.1), by its number in the records section.
export const FIELD_STARTS = [null, "list", "map"];
export const SECTION = { TEXTS: 1, NUMBERS: 2, PROGRAM: 3, BOXES: 4, RECORDS: 5, QUESTIONS: 6, NATIVES: 7, FUNCTIONS: 8, CODE: 9, PLACES: 10, LINKS: 11 };

export const QUESTION_TYPES = ["string", "long_text", "number", "date", "phone", "email", "bool", "one_of", "any_of"];
export const WRITES = ["fill", "tick", "pick"];

// The instructions. Operands: v a varint, a a 4-byte address.
export const OP = {
  HALT: 0,
  TEXT: 1, // v text: push it
  NUMBER: 2, // v number: push it
  TRUE: 3,
  FALSE: 4,
  NULL: 5,
  LOAD: 6, // v local: push its value
  STORE: 7, // v local: pop a value into the local
  POP: 8,
  DUP: 9,
  NEW_RECORD: 10, // v record type: push a record with every field null
  GET_FIELD: 11, // v field: pop a record, push its field (F023 of null; F006 of anything else that is no record)
  SET_FIELD: 12, // v field: pop a value, pop a record, set the field to the value
  NEW_LIST: 13, // v count: pop that many values, push a list of them
  GET_ITEM: 14, // pop a position, pop a list, push the item (§6.9.2: F004)
  SET_ITEM: 15, // pop a value, pop a position, pop a list, set the item (§7.5.1: F005)
  APPEND: 16, // v local: pop a value, append it to the list in the local
  ADD: 17,
  SUB: 18,
  MUL: 19,
  DIV: 20,
  EQ: 21,
  NE: 22,
  LT: 23,
  LE: 24,
  GT: 25,
  GE: 26,
  IN: 27,
  NOT_IN: 28,
  NEG: 29,
  NOT: 30,
  CONCAT: 31, // v count: pop that many values, push their words joined
  JUMP: 32, // a
  JUMP_IF_FALSE: 33, // a: pop a condition; jump when it is not true
  JUMP_IF_TRUE: 34, // a: pop a condition; jump when it is true
  LOOP: 36, // a: jump back to a loop's head
  CALL: 37, // v function, v count: pop the arguments, run the function, push what it gives
  RETURN: 38, // pop a value and give it back
  RETURN_NONE: 39,
  NATIVE: 40, // v native, v count
  ASK: 41, // v question: pop its printed words and its key, push its answer
  ASK_DEFAULT: 42, // v question: pop its default, its printed words and its key, push its answer
  CHECK_FAILED: 43, // v question: pop a message; the question's latest step records it as a failed check
  FILL: 44, // v box: pop a value, write its words
  TICK: 45, // v box: pop a condition; tick the box when it is true
  PICK: 46, // v box, v text: pop a condition; pick that button when it is true
  FILL_AT: 47, // pop a value and a box's name; write the value's words
  TICK_AT: 48, // pop a condition and a box's name; tick it when true
  PICK_AT: 49, // pop a condition, a button's name and a box's name; pick it when true
  FLOOR_DIV: 50,
  MOD: 51,
  GET_ITEM_THERE: 53, // pop a position, pop a list, push the item, which must be there (§7.5.1: F004, F020)
  ENSURE_RECORD: 54, // v local, v record type: a null local becomes a record of the type (§7.5.1)
  ENSURE_FIELD: 55, // v field, v record type: a null field of the record on top becomes a record
  ENSURE_ITEM: 56, // v record type: a null item at the position on top (of the list below it) becomes a record
  SLICE: 57, // pop b, pop a, pop a list: push its items a to b (§6.9.3)
  TO_BOOL: 59, // pop a value, push true when it is true, else false (§6.15.1)
  CHECK_SLOT: 60, // with a list and a position on top, fault F005 unless the item can be set there (§7.5.1)
  EXPECT: 61, // a after, v faults: a test file's expectation starts, its own sub-run (§7.17.1); a fault in it
  //            undoes the sub-run, is judged, and the run goes on at `after`. `faults` is 0 for a plain expect,
  //            else the index of the fault's code or words plus one
  LOAD_MAIN: 66, // v local: push the value of the program's own local (a function reading the program's name)
  KEEP: 67, // v count: pop that many values and a function value; push the function keeping them (§9.11)
  TRY: 68, // a catch, v local: a fault from here to TRY_DONE goes on at the catch, the error in the local (§7.18)
  THROW: 90, // pop an error, or the words of one, and raise it (§7.19)
  TRY_DONE: 69, // the try is over
  STORE_MAIN: 70, // v local: pop a value into the program's own local (a function changing the program's var)
  ENSURE_MAIN: 71, // v local, v record: ENSURE_RECORD on the program's own local
  CELL: 72, // v local: pop a value into a new shared var in the local (§9.11)
  LOAD_CELL: 73, // v local: push the local's shared var itself, for a function made in place to share
  FN: 64, // v function, v text: push the function as a value, by the name its questions' keys use
  CALL_VALUE: 65, // v count: pop that many values, the turns, the key and a function value; call it (§9.10)
  FROM: 63, // v question, v as given: the write that follows is made from that question's answer (as given, or not)
  POW: 80, // pop k, pop n: push n to the power k (§6.4.2)
  RANGE: 81, // pop b, pop a: push the range a..b (§6.17)
  RANGE_BEFORE: 82, // pop b, pop a: push the range a..<b
  EXPECT_DONE: 62, // v faults: pop the words (plain only) and the value, undo the sub-run, judge it
};

export const OP_NAME = Object.fromEntries(Object.entries(OP).map(([k, v]) => [v, k]));
export const OPERANDS = {
  [OP.TEXT]: "v", [OP.NUMBER]: "v", [OP.LOAD]: "v", [OP.STORE]: "v", [OP.NEW_RECORD]: "v", [OP.GET_FIELD]: "v",
  [OP.SET_FIELD]: "v", [OP.NEW_LIST]: "v", [OP.APPEND]: "v", [OP.CONCAT]: "v", [OP.JUMP]: "a", [OP.JUMP_IF_FALSE]: "a",
  [OP.JUMP_IF_TRUE]: "a", [OP.LOOP]: "a", [OP.CALL]: "vv", [OP.NATIVE]: "vv", [OP.ASK]: "v", [OP.ASK_DEFAULT]: "v",
  [OP.CHECK_FAILED]: "v", [OP.FILL]: "v", [OP.TICK]: "v", [OP.PICK]: "vv", [OP.ENSURE_RECORD]: "vv",
  [OP.ENSURE_FIELD]: "vv", [OP.ENSURE_ITEM]: "v", [OP.EXPECT]: "av", [OP.EXPECT_DONE]: "v", [OP.FROM]: "vv", [OP.FN]: "vv", [OP.CELL]: "v", [OP.LOAD_CELL]: "v", [OP.STORE_MAIN]: "v", [OP.ENSURE_MAIN]: "vv", [OP.TRY]: "av", [OP.KEEP]: "v", [OP.LOAD_MAIN]: "v", [OP.CALL_VALUE]: "v",
};

export const BINARY_OPS = { "+": OP.ADD, "-": OP.SUB, "*": OP.MUL, "/": OP.DIV, "//": OP.FLOOR_DIV, "%": OP.MOD, "**": OP.POW, "..": OP.RANGE, "..<": OP.RANGE_BEFORE, "==": OP.EQ, "!=": OP.NE, "<": OP.LT, "<=": OP.LE, ">": OP.GT, ">=": OP.GE, in: OP.IN, "not in": OP.NOT_IN };
export const OP_BINARY = Object.fromEntries(Object.entries(BINARY_OPS).map(([k, v]) => [v, k]));

// ----- writing

export class Writer {
  constructor() {
    this.bytes = [];
  }

  u8(b) {
    this.bytes.push(b & 0xff);
  }

  varint(n) {
    if (!Number.isInteger(n) || n < 0) throw new Error(`not a varint: ${n}`);
    do {
      let b = n % 128;
      n = Math.floor(n / 128);
      if (n) b |= 0x80;
      this.bytes.push(b);
    } while (n);
  }

  u32(n) {
    for (let i = 0; i < 4; i++) this.bytes.push((n >>> (8 * i)) & 0xff);
  }

  text(s) {
    const b = new TextEncoder().encode(s);
    this.varint(b.length);
    for (const x of b) this.bytes.push(x);
  }

  raw(bytes) {
    for (const x of bytes) this.bytes.push(x);
  }

  get length() {
    return this.bytes.length;
  }

  done() {
    return new Uint8Array(this.bytes);
  }
}

// ----- reading

export class Reader {
  constructor(bytes, at = 0, end = bytes.length) {
    this.bytes = bytes;
    this.at = at;
    this.end = end;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  need(n) {
    if (this.at + n > this.end) throw new BytecodeError(`the file ends too early (at byte ${this.at})`);
  }

  u8() {
    this.need(1);
    return this.bytes[this.at++];
  }

  varint() {
    let n = 0;
    let shift = 0;
    for (;;) {
      const b = this.u8();
      n += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return n;
      shift += 7;
      if (shift > 49) throw new BytecodeError("a number in the file is too long");
    }
  }

  u32() {
    this.need(4);
    const v = this.view.getUint32(this.at, true);
    this.at += 4;
    return v;
  }

  text() {
    const n = this.varint();
    this.need(n);
    const s = new TextDecoder().decode(this.bytes.subarray(this.at, this.at + n));
    this.at += n;
    return s;
  }

  slice(n) {
    this.need(n);
    const b = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return b;
  }
}

export class BytecodeError extends Error {}

// A compiled program, from its bytes: everything in it, ready for the machine.
export function load(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const r = new Reader(bytes);
  const magic = String.fromCharCode(r.u8(), r.u8(), r.u8(), r.u8());
  if (magic !== MAGIC) throw new BytecodeError("this is not a compiled Stride program");
  const version = r.u8();
  if (version !== VERSION) throw new BytecodeError(`this program is Stride bytecode version ${version}; this machine runs version ${VERSION}`);
  const p = { version, texts: [], numbers: [], form: "", pdf: "", prefix: "", boxes: [], records: [], questions: [], natives: [], functions: [], code: new Uint8Array(0), places: [], links: [] };
  const t = (s) => {
    const i = s.varint();
    if (i >= p.texts.length) throw new BytecodeError(`a text index ${i} is out of range`);
    return p.texts[i];
  };
  const opt = (s) => {
    const i = s.varint();
    if (i > p.texts.length) throw new BytecodeError(`a text index ${i - 1} is out of range`);
    return i === 0 ? null : p.texts[i - 1];
  };
  const one = (s, list, what) => {
    const i = s.u8();
    if (i >= list.length) throw new BytecodeError(`${what} ${i} is not one this machine knows`);
    return list[i];
  };
  // Each section once; the program and its code always there; places may be left out (§18.1). Sections come in
  // any order: the texts the others name are read first.
  const seen = new Set();
  const sections = [];
  while (r.at < r.end) {
    const tag = r.u8();
    if (seen.has(tag)) throw new BytecodeError(`section ${tag} comes twice`);
    seen.add(tag);
    const length = r.varint();
    r.need(length);
    sections.push([tag, new Reader(bytes, r.at, r.at + length)]);
    r.at += length;
  }
  sections.sort(([a], [b]) => (b === SECTION.TEXTS) - (a === SECTION.TEXTS));
  for (const [tag, s] of sections) {
    const list = (one) => Array.from({ length: s.varint() }, one);
    switch (tag) {
      case SECTION.TEXTS:
        p.texts = list(() => s.text());
        break;
      case SECTION.NUMBERS:
        p.numbers = list(() => {
          const w = t(s);
          try {
            return D.fromWords(w);
          } catch {
            throw new BytecodeError(`"${w}" is not a number's words`);
          }
        });
        break;
      case SECTION.PROGRAM:
        p.form = t(s);
        p.pdf = t(s);
        p.prefix = t(s);
        break;
      case SECTION.BOXES:
        p.boxes = list(() => ({ name: t(s), kind: one(s, WRITES, "the way of writing a box"), on: opt(s) }));
        break;
      case SECTION.RECORDS:
        // Each field: its name, then what it starts as in a record made on the way to a field (§7.5.1): 1 a list
        // with no items, 2 a map with no keys, 0 null.
        p.records = list(() => {
          const r = { name: t(s), fields: [], starts: [] };
          for (let k = s.varint(); k > 0; k--) {
            r.fields.push(t(s));
            r.starts.push(one(s, FIELD_STARTS, "what a field starts as"));
          }
          return r;
        });
        break;
      case SECTION.QUESTIONS:
        p.questions = list(() => {
          const q = { name: t(s), type: one(s, QUESTION_TYPES, "the question type"), set: opt(s) };
          q.options = list(() => ({ value: t(s), printed: t(s) }));
          const flags = s.u8();
          q.hasDefault = !!(flags & 1);
          q.item = !!(flags & 2);
          q.line = s.varint();
          q.file = t(s);
          return q;
        });
        break;
      case SECTION.LINKS:
        p.links = list(() => ({ key: t(s), question: s.varint(), printed: t(s), box: s.varint(), direct: !!s.u8(), max: s.varint() || null }));
        break;
      case SECTION.NATIVES:
        p.natives = list(() => ({ name: t(s), params: s.varint() }));
        break;
      case SECTION.FUNCTIONS:
        p.functions = list(() => ({ name: t(s), file: t(s), params: s.varint(), localNames: list(() => t(s)), start: s.varint(), end: s.varint(), flags: s.u8() })).map((f) => ({ ...f, keyed: !!(f.flags & 1) }));
        for (const f of p.functions) f.locals = f.localNames.length;
        break;
      case SECTION.CODE:
        p.code = s.slice(s.varint());
        break;
      case SECTION.PLACES: {
        let address = 0;
        const place = () => ({ file: t(s), line: s.varint(), column: s.varint() });
        p.places = list(() => {
          address += s.varint();
          return { address, ...place() };
        });
        break;
      }
      default:
        s.at = s.end; // a later version's section: skipped
    }
    if (s.at !== s.end) throw new BytecodeError(`section ${tag} holds ${s.end - s.at} bytes more than it says`);
  }
  for (const [tag, name] of [[SECTION.PROGRAM, "program"], [SECTION.CODE, "code"]]) if (!seen.has(tag)) throw new BytecodeError(`the ${name} section is missing`);
  verify(p);
  return p;
}

// What the machine trusts about a program, checked once when it is loaded (§18.3): every instruction known and
// complete, every operand in range (a native's argument count its native's), every jump onto an instruction of its
// own function, forward (a LOOP backward), every function ending, the stack's height the same where paths meet.
export function verify(p) {
  const widest = Math.max(0, ...p.records.map((r) => r.fields.length)); // the most fields any record type holds
  if (!p.functions.length) throw new BytecodeError("the program has no functions");
  for (const [i, fn] of p.functions.entries()) {
    if (fn.start > fn.end || fn.end > p.code.length) throw new BytecodeError(`function ${fn.name}'s code is out of range`);
    if (fn.locals < fn.params) throw new BytecodeError(`function ${fn.name} has fewer locals than parameters`);
    const starts = new Set();
    const jumps = [];
    const r = new Reader(p.code, fn.start, fn.end);
    let last = null;
    while (r.at < fn.end) {
      const at = r.at;
      starts.add(at);
      const op = r.u8();
      if (OP_NAME[op] === undefined) throw new BytecodeError(`unknown instruction ${op} at ${at} in ${fn.name}`);
      const kinds = OPERANDS[op] ?? "";
      const args = [...kinds].map((k) => (k === "a" ? r.u32() : r.varint()));
      const check = (ok, what) => {
        if (!ok) throw new BytecodeError(`${OP_NAME[op]} at ${at} in ${fn.name}: ${what} out of range`);
      };
      switch (op) {
        case OP.TEXT:
          check(args[0] < p.texts.length, "text");
          break;
        case OP.NUMBER:
          check(args[0] < p.numbers.length, "number");
          break;
        case OP.LOAD:
        case OP.CELL:
        case OP.LOAD_CELL:
        case OP.STORE:
        case OP.APPEND:
          check(args[0] < fn.locals, "local");
          break;
        case OP.ENSURE_RECORD:
          check(args[0] < fn.locals, "local");
          check(args[1] < p.records.length, "record type");
          break;
        case OP.NEW_RECORD:
        case OP.ENSURE_ITEM:
          check(args[0] < p.records.length, "record type");
          break;
        case OP.ENSURE_FIELD:
          check(args[0] < widest, "field");
          check(args[1] < p.records.length, "record type");
          break;
        // A field is one some record has: below the most fields any record type holds. An error has two (§3.11).
        case OP.GET_FIELD:
          check(args[0] < Math.max(widest, 2), "field");
          break;
        case OP.SET_FIELD:
          check(args[0] < widest, "field");
          break;
        case OP.FN:
          check(args[0] < p.functions.length, "function");
          break;
        case OP.LOAD_MAIN: case OP.STORE_MAIN: case OP.ENSURE_MAIN:
          check(args[0] < p.functions[0].localNames.length, "the program's local");
          if (op === OP.ENSURE_MAIN) check(args[1] < p.records.length, "record");
          break;
        case OP.CALL:
          check(args[0] < p.functions.length, "function");
          check(args[1] === p.functions[args[0]].params, "argument count");
          break;
        case OP.NATIVE:
          check(args[0] < p.natives.length, "native");
          check(args[1] === p.natives[args[0]].params, "argument count");
          break;
        case OP.ASK:
        case OP.ASK_DEFAULT:
        case OP.CHECK_FAILED:
        case OP.FROM:
          check(args[0] < p.questions.length, "question");
          break;
        case OP.FILL:
        case OP.TICK:
          check(args[0] < p.boxes.length, "box");
          break;
        case OP.PICK:
          check(args[0] < p.boxes.length, "box");
          check(args[1] < p.texts.length, "button");
          break;
        case OP.TRY:
          check(args[1] < fn.localNames.length, "local");
          break;
        case OP.EXPECT:
          check(args[1] <= p.texts.length, "fault words");
          check(i === 0, "function");
          break;
        case OP.EXPECT_DONE:
          check(args[0] <= 1, "kind");
          break;
        default:
          break;
      }
      if (kinds[0] === "a") jumps.push({ at, op, to: args[0] });
      last = op;
    }
    if (r.at !== fn.end) throw new BytecodeError(`function ${fn.name}'s last instruction runs past its end`);
    verifyStack(p, fn);
    if (![OP.HALT, OP.RETURN, OP.RETURN_NONE, OP.LOOP, OP.JUMP, OP.THROW].includes(last)) throw new BytecodeError(`function ${fn.name} does not end with a return`);
    if (i === 0 && fn.params !== 0) throw new BytecodeError("the main function takes no parameters");
    for (const j of jumps) {
      if (!starts.has(j.to) && j.to !== fn.end) throw new BytecodeError(`${OP_NAME[j.op]} at ${j.at} in ${fn.name} jumps to ${j.to}, which is not an instruction of the function`);
      if (j.op === OP.LOOP ? j.to >= j.at : j.to <= j.at) throw new BytecodeError(`${OP_NAME[j.op]} at ${j.at} in ${fn.name} jumps the wrong way`);
    }
  }
  for (const l of p.links) if (l.box >= p.boxes.length || l.question >= p.questions.length) throw new BytecodeError(`the link for ${l.key} is out of range`);
}

// How many values an instruction takes from the stack and gives back, given its operands.
function stackEffect(op, args) {
  switch (op) {
    case OP.TEXT: case OP.NUMBER: case OP.TRUE: case OP.FALSE: case OP.NULL: case OP.LOAD: case OP.LOAD_CELL: case OP.NEW_RECORD:
      return [0, 1];
    case OP.ASK:
      return [2, 1];
    case OP.ASK_DEFAULT:
      return [3, 1];
    case OP.FILL_AT: case OP.TICK_AT:
      return [2, 0];
    case OP.PICK_AT:
      return [3, 0];
    case OP.DUP:
      return [1, 2];
    case OP.STORE: case OP.CELL: case OP.POP: case OP.APPEND: case OP.JUMP_IF_FALSE: case OP.JUMP_IF_TRUE: case OP.CHECK_FAILED: case OP.FILL: case OP.TICK: case OP.PICK: case OP.RETURN: case OP.THROW:
      return [1, 0];
    case OP.GET_FIELD: case OP.NEG: case OP.NOT: case OP.TO_BOOL:
      return [1, 1];
    case OP.ENSURE_FIELD:
      return [1, 1];
    case OP.ENSURE_ITEM: case OP.CHECK_SLOT:
      return [2, 2];
    case OP.STORE_MAIN:
      return [1, 0];
    case OP.ENSURE_MAIN: case OP.ENSURE_RECORD: case OP.EXPECT: case OP.FROM: case OP.TRY: case OP.TRY_DONE:
      return [0, 0];
    case OP.EXPECT_DONE:
      return [args[0] ? 1 : 2, 0];
    case OP.SET_FIELD:
      return [2, 0];
    case OP.GET_ITEM: case OP.GET_ITEM_THERE:
      return [2, 1];
    case OP.SET_ITEM:
      return [3, 0];
    case OP.SLICE:
      return [3, 1];
    case OP.NEW_LIST: case OP.CONCAT:
      return [args[0], 1];
    case OP.CALL: case OP.NATIVE:
      return [args[1], 1];
    case OP.FN: case OP.LOAD_MAIN:
      return [0, 1];
    case OP.CALL_VALUE:
      return [args[0] + 3, 1];
    case OP.KEEP:
      return [args[0] + 1, 1];
    case OP.HALT: case OP.RETURN_NONE: case OP.JUMP: case OP.LOOP:
      return [0, 0];
    default:
      if (OP_BINARY[op]) return [2, 1];
      throw new BytecodeError(`unknown instruction ${op}`);
  }
}

// The stack's height before every instruction of a function, worked out along every path: never below what an
// instruction takes, the same wherever two paths meet. The machine can then run without checking the stack.
function verifyStack(p, fn) {
  const height = new Map([[fn.start, 0]]);
  const work = [fn.start];
  const decode = (at) => {
    const r = new Reader(p.code, at, fn.end);
    const op = r.u8();
    const args = [...(OPERANDS[op] ?? "")].map((k) => (k === "a" ? r.u32() : r.varint()));
    return { op, args, next: r.at };
  };
  const reach = (at, h, from) => {
    if (at === fn.end) throw new BytecodeError(`in ${fn.name}, the instruction at ${from} runs off the end of the function`);
    if (!height.has(at)) {
      height.set(at, h);
      work.push(at);
    } else if (height.get(at) !== h) throw new BytecodeError(`in ${fn.name}, two paths meet at ${at} with ${height.get(at)} and ${h} values on the stack`);
  };
  let deepest = 0;
  while (work.length) {
    const at = work.pop();
    const h = height.get(at);
    const { op, args, next } = decode(at);
    const [take, give] = stackEffect(op, args);
    if (h < take) throw new BytecodeError(`in ${fn.name}, ${OP_NAME[op]} at ${at} takes ${take} values and the stack holds ${h}`);
    const after = h - take + give;
    deepest = Math.max(deepest, after);
    switch (op) {
      case OP.RETURN: case OP.RETURN_NONE:
        if (after !== 0) throw new BytecodeError(`in ${fn.name}, ${OP_NAME[op]} at ${at} leaves ${after} values on the stack`);
        break;
      case OP.HALT:
        if (after !== 0) throw new BytecodeError(`in ${fn.name}, HALT at ${at} leaves ${after} values on the stack`);
        break;
      case OP.THROW:
        break;
      case OP.JUMP: case OP.LOOP:
        reach(args[0], after, at);
        break;
      case OP.JUMP_IF_FALSE: case OP.JUMP_IF_TRUE: case OP.EXPECT: case OP.TRY:
        reach(args[0], after, at);
        reach(next, after, at);
        break;
      default:
        reach(next, after, at);
    }
  }
  if (deepest > 10_000) throw new BytecodeError(`${fn.name} needs a stack ${deepest} deep`);
  fn.maxStack = deepest;
}

// A program written by hand, as bytes: for the machine's own tests (§19.3), which give it exactly the bytecode no
// compiler would. `functions` are { name, params, locals, code: [[op, …operands]] }, the first the program's body;
// texts, numbers (their words), natives ({ name, params }), boxes ({ name, kind, on }) and records ({ name, fields }) as the sections
// hold them. The machine loads it like any other program: read, then verified.
export function assemble({ texts = [], numbers = [], natives = [], boxes = [], records = [], functions, form = "t", pdf = "", prefix = "" }) {
  const pool = [...texts];
  const T = (x) => (pool.includes(x) ? pool.indexOf(x) : pool.push(x) - 1);
  [form, pdf, prefix, ...numbers, ...natives.map((n) => n.name), ...boxes.flatMap((b) => [b.name, b.on ?? ""]), ...records.flatMap((r) => [r.name, ...r.fields])].forEach(T);
  const code = new Writer();
  const fns = functions.map((f) => {
    const start = code.length;
    for (const [op, ...args] of f.code) {
      code.u8(op);
      [...(OPERANDS[op] ?? "")].forEach((k, i) => (k === "a" ? code.u32(start + args[i]) : code.varint(args[i])));
    }
    const names = Array.from({ length: f.locals ?? f.params ?? 0 }, (_, i) => `l${i}`);
    names.forEach(T);
    T(f.name);
    return { ...f, start, end: code.length, names };
  });
  const out = new Writer();
  for (const c of MAGIC) out.u8(c.charCodeAt(0));
  out.u8(VERSION);
  const section = (tag, write) => {
    const w = new Writer();
    write(w);
    out.u8(tag);
    out.varint(w.length);
    out.raw(w.bytes);
  };
  section(SECTION.TEXTS, (w) => (w.varint(pool.length), pool.forEach((x) => w.text(x))));
  section(SECTION.NUMBERS, (w) => (w.varint(numbers.length), numbers.forEach((n) => w.varint(T(n)))));
  section(SECTION.PROGRAM, (w) => (w.varint(T(form)), w.varint(T(pdf)), w.varint(T(prefix))));
  section(SECTION.BOXES, (w) => (w.varint(boxes.length), boxes.forEach((b) => (w.varint(T(b.name)), w.u8(WRITES.indexOf(b.kind)), w.varint(b.on ? T(b.on) + 1 : 0)))));
  section(SECTION.RECORDS, (w) => (w.varint(records.length), records.forEach((r) => (w.varint(T(r.name)), w.varint(r.fields.length), r.fields.forEach((f, i) => (w.varint(T(f)), w.u8(Math.max(0, FIELD_STARTS.indexOf(r.starts?.[i] ?? null)))))))));
  section(SECTION.NATIVES, (w) => (w.varint(natives.length), natives.forEach((n) => (w.varint(T(n.name)), w.varint(n.params)))));
  section(SECTION.FUNCTIONS, (w) => {
    w.varint(fns.length);
    for (const f of fns) (w.varint(T(f.name)), w.varint(T("")), w.varint(f.params ?? 0), w.varint(f.names.length), f.names.forEach((n) => w.varint(T(n))), w.varint(f.start), w.varint(f.end), w.u8(0));
  });
  section(SECTION.CODE, (w) => (w.varint(code.length), w.raw(code.bytes)));
  return new Uint8Array(out.bytes);
}
// The place of an instruction, from the place table: the last entry at or before the address.
export function placeAt(p, address) {
  let lo = 0, hi = p.places.length - 1, found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (p.places[mid].address <= address) (found = p.places[mid]), (lo = mid + 1);
    else hi = mid - 1;
  }
  return found;
}

// The program's instructions in readable form: function by function, each instruction with its address, name,
// operands, what they name, and its place where it changes.
export function disassemble(p) {
  const out = [];
  out.push(`form ${p.form}  pdf ${p.pdf.slice(0, 16)}…  prefix ${JSON.stringify(p.prefix)}`);
  out.push(`${p.texts.length} texts, ${p.numbers.length} numbers, ${p.boxes.length} boxes, ${p.questions.length} questions, ${p.functions.length} functions, ${p.code.length} bytes of code`);
  for (const [i, fn] of p.functions.entries()) {
    out.push("");
    out.push(`function ${i} ${fn.name} (${fn.params} parameters; locals ${fn.localNames.join(", ") || "none"})`);
    const r = new Reader(p.code, fn.start, fn.end);
    let lastPlace = null;
    while (r.at < fn.end) {
      const at = r.at;
      const place = placeAt(p, at);
      if (place && place !== lastPlace && place.address === at) {
        out.push(`        ; ${place.file}:${place.line}:${place.column}`);
        lastPlace = place;
      }
      const op = r.u8();
      const kinds = OPERANDS[op] ?? "";
      const args = [...kinds].map((k) => (k === "a" ? r.u32() : r.varint()));
      out.push(`  ${String(at).padStart(5)}  ${(OP_NAME[op] ?? `?${op}`).padEnd(18)} ${args.join(" ").padEnd(8)} ${note(p, fn, op, args)}`.trimEnd());
    }
  }
  return out.join("\n");
}

function note(p, fn, op, args) {
  switch (op) {
    case OP.TEXT:
      return JSON.stringify(p.texts[args[0]]);
    case OP.NUMBER:
      return D.words(p.numbers[args[0]]);
    case OP.LOAD:
    case OP.STORE:
    case OP.APPEND:
      return fn.localNames[args[0]] ?? "";
    case OP.NEW_RECORD:
      return p.records[args[0]]?.name ?? "";
    case OP.CALL:
      return p.functions[args[0]]?.name ?? "";
    case OP.NATIVE:
      return p.natives[args[0]]?.name ?? "";
    case OP.ASK:
    case OP.ASK_DEFAULT:
    case OP.CHECK_FAILED:
    case OP.FROM:
      return `${p.questions[args[0]]?.name} (${p.questions[args[0]]?.type})`;
    case OP.FILL:
    case OP.TICK:
      return p.boxes[args[0]]?.name ?? "";
    case OP.PICK:
      return `${p.boxes[args[0]]?.name} = ${JSON.stringify(p.texts[args[1]])}`;
    default:
      return "";
  }
}
