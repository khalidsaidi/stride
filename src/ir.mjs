// The intermediate form: what the checked syntax tree is lowered into, the PDF check
// walks and the code generator turns into bytecode. Each function is a graph of basic blocks; a block is a list
// of statements and one terminator; statements hold expression trees.
//
//   Statements                                   Terminators
//     set dst = e                                  jump B
//     store dst.path = e        (field, item)      branch e ? B1 : B2
//     append dst <- e                              return [e]
//     ask q -> dst[.path] [default e]              halt
//     check q e                 (a check's condition, after its ask)
//     fill "box" = e | tick "box" when e | pick "box" "button" when e | skip "box"
//     eval e                    (a call kept for what it does)
//
//   Expressions
//     const v | local l | unary op a | binary op a b | concat [parts] | call F [args] | native name [args]
//     field a i | item a i | record decl [fields] | list [items]
//
// Every statement and terminator keeps the syntax node it came from (`node`), so a mistake or a fault can say
// which line.

export class Local {
  constructor(id, name, type) {
    this.id = id;
    this.name = name;
    this.type = type;
  }
}

export class Block {
  constructor(id) {
    this.id = id;
    this.stmts = [];
    this.term = null;
    this.loopHead = false; // the head of a counted loop: the only block a jump may go back to
  }

  // The blocks this one can go to.
  get successors() {
    const t = this.term;
    if (!t) return [];
    if (t.op === "jump") return [t.to];
    if (t.op === "branch") return t.yes === t.no ? [t.yes] : [t.yes, t.no];
    return [];
  }
}

export class Fn {
  constructor(name, { source = null, result = null, pure = false } = {}) {
    this.name = name; // as shown: main, upper_line, representative(2)
    this.source = source; // the function symbol, or null for main
    this.result = result;
    this.pure = pure;
    this.params = []; // Locals
    this.locals = []; // Locals, parameters first
    this.blocks = [];
    this.entry = null;
    this.nextLocal = 0;
    this.nextBlock = 0;
  }

  local(name, type) {
    const l = new Local(this.nextLocal++, name, type);
    this.locals.push(l);
    return l;
  }

  param(name, type) {
    const l = this.local(name, type);
    this.params.push(l);
    return l;
  }

  block() {
    const b = new Block(this.nextBlock++);
    this.blocks.push(b);
    return b;
  }

  // The blocks reachable from the entry, in reverse post-order (each block before its successors, but for loops).
  order() {
    const seen = new Set();
    const post = [];
    const visit = (b) => {
      seen.add(b);
      for (const s of b.successors) if (!seen.has(s)) visit(s);
      post.push(b);
    };
    if (this.entry) visit(this.entry);
    return post.reverse();
  }

  // Each block's predecessors, among the reachable ones.
  predecessors() {
    const preds = new Map(this.blocks.map((b) => [b, []]));
    for (const b of this.order()) for (const s of b.successors) preds.get(s).push(b);
    return preds;
  }
}

// A question as written in the program: one per ask (and per collect's "any?" and "another?"). The key it is
// asked under and the words printed for it are worked out as the program runs (the ask statement holds them as
// expressions): a question asked in a loop's turns, or in a function called from several places, has a key for
// each (other_act[1], representatives[2].name, line_2(2).name).
export class Question {
  constructor({ name, type, options, set, hasDefault, check, node, item }) {
    this.name = name; // its name in the program: name, r.name, representatives.another
    this.type = type; // text long-text number date phone email yes-no one-of any-of
    this.options = options; // [{ value, printed }] for one-of and any-of
    this.set = set; // the option set's name, or null for a question's own
    this.hasDefault = hasDefault;
    this.check = check; // the check's message, or null
    this.node = node; // the ask
    this.item = item ?? false; // the "any?" or "another?" of a collect
  }
}

// ----- expressions

export const constant = (v) => ({ e: "const", v });
export const local = (l) => ({ e: "local", l });
export const unary = (op, a) => ({ e: "unary", op, a });
export const binary = (op, a, b) => ({ e: "binary", op, a, b });
export const concat = (parts) => ({ e: "concat", parts });
export const call = (fn, args) => ({ e: "call", fn, args });
export const native = (name, args) => ({ e: "native", name, args });
export const field = (a, i, name) => ({ e: "field", a, i, name });
export const item = (a, i) => ({ e: "item", a, i });
export const record = (decl, fields) => ({ e: "record", decl, fields });
export const list = (items, most) => ({ e: "list", items, most });
export const cond = (c, yes, no) => ({ e: "cond", cond: c, yes, no });
export const slice = (a, from, to) => ({ e: "slice", a, from, to });
export const key = (a) => ({ e: "key", a });

export const isConst = (x) => x.e === "const";

// The expressions directly inside one.
export function children(x) {
  switch (x.e) {
    case "unary":
      return [x.a];
    case "binary":
      return [x.a, x.b];
    case "concat":
      return x.parts;
    case "call":
    case "native":
      return x.args;
    case "field":
      return [x.a];
    case "item":
      return [x.a, x.i];
    case "record":
      return x.fields;
    case "list":
      return x.items;
    case "cond":
      return [x.cond, x.yes, x.no];
    case "slice":
      return [x.a, x.from, x.to];
    case "key":
      return [x.a];
    case "comp":
      return [x.list, ...(x.cond ? [x.cond] : []), x.value];
    default:
      return [];
  }
}

// Every expression a statement or terminator holds.
export function expressionsOf(s) {
  switch (s.op) {
    case "set":
    case "append":
    case "eval":
      return [s.value];
    case "store":
      return [...s.path.filter((p) => p.index).map((p) => p.index), s.value];
    case "ask":
      return [s.key, s.printed, ...(s.default ? [s.default] : []), ...s.path.filter((p) => p.index).map((p) => p.index)];
    case "check":
      return [s.cond, s.message];
    case "expect":
      return [s.value, ...(s.fault ? [s.fault] : []), ...(s.message ? [s.message] : [])];
    case "fill":
      return [s.box, s.value];
    case "tick":
      return [s.box, s.cond];
    case "pick":
      return [s.box, s.button, s.cond];
    case "skip":
      return [s.box];
    case "branch":
      return [s.cond];
    case "return":
      return s.value ? [s.value] : [];
    default:
      return [];
  }
}

// ----- printing, for `stride asm --ir` and for reading the compiler's work

export function showExpr(x) {
  switch (x.e) {
    case "const":
      return x.v === null ? "empty" : typeof x.v === "string" ? JSON.stringify(x.v) : String(x.v?.iso ?? x.v);
    case "local":
      return `%${x.l.name}`;
    case "unary":
      return `(${x.op} ${showExpr(x.a)})`;
    case "binary":
      return `(${showExpr(x.a)} ${x.op} ${showExpr(x.b)})`;
    case "concat":
      return `concat(${x.parts.map(showExpr).join(", ")})`;
    case "call":
      return `${x.fn.name}(${x.args.map(showExpr).join(", ")})`;
    case "native":
      return `native ${x.name}(${x.args.map(showExpr).join(", ")})`;
    case "field":
      return `${showExpr(x.a)}.${x.name}`;
    case "item":
      return `${showExpr(x.a)}[${showExpr(x.i)}]`;
    case "record":
      return `new ${x.decl.name} { ${x.fields.map(showExpr).join(", ")} }`;
    case "list":
      return `[${x.items.map(showExpr).join(", ")}]`;
    case "cond":
      return `(if ${showExpr(x.cond)} then ${showExpr(x.yes)} else ${showExpr(x.no)})`;
    case "slice":
      return `${showExpr(x.a)}[${showExpr(x.from)}..${showExpr(x.to)}]`;
    case "key":
      return `key(${showExpr(x.a)})`;
    case "comp":
      return `[${showExpr(x.value)} for each %${x.index.name}, %${x.item.name} in ${showExpr(x.list)}${x.cond ? ` if ${showExpr(x.cond)}` : ""}]`;
    default:
      return `?${x.e}`;
  }
}

const showPath = (path) => path.map((p) => (p.field !== undefined ? `.${p.name}` : `[${showExpr(p.index)}]`)).join("");

export function showStatement(s) {
  switch (s.op) {
    case "set":
      return `%${s.dst.name} = ${showExpr(s.value)}`;
    case "store":
      return `%${s.dst.name}${showPath(s.path)} = ${showExpr(s.value)}`;
    case "append":
      return `%${s.dst.name} <- ${showExpr(s.value)}`;
    case "ask":
      return `ask ${showExpr(s.key)} (${s.q.type}, ${showExpr(s.printed)}) -> %${s.dst.name}${showPath(s.path)}${s.default ? ` default ${showExpr(s.default)}` : ""}`;
    case "check":
      return `check ${s.q.name} ${showExpr(s.cond)} else ${showExpr(s.message)}`;
    case "fill":
      return `fill ${showExpr(s.box)} = ${showExpr(s.value)}`;
    case "tick":
      return `tick ${showExpr(s.box)} when ${showExpr(s.cond)}`;
    case "pick":
      return `pick ${showExpr(s.box)} ${showExpr(s.button)} when ${showExpr(s.cond)}`;
    case "skip":
      return `skip ${showExpr(s.box)}`;
    case "eval":
      return showExpr(s.value);
    case "jump":
      return `jump b${s.to.id}`;
    case "branch":
      return `branch ${showExpr(s.cond)} ? b${s.yes.id} : b${s.no.id}`;
    case "return":
      return s.value ? `return ${showExpr(s.value)}` : "return";
    case "halt":
      return "halt";
    default:
      return `?${s.op}`;
  }
}

export function showFunction(fn) {
  const out = [`function ${fn.name}(${fn.params.map((p) => `%${p.name}`).join(", ")})${fn.pure ? " pure" : ""}`];
  for (const b of fn.order()) {
    out.push(`  b${b.id}:${b.loopHead ? "  (loop)" : ""}`);
    for (const s of b.stmts) out.push(`    ${showStatement(s)}`);
    if (b.term) out.push(`    ${showStatement(b.term)}`);
  }
  return out.join("\n");
}
