// node scripts/fuzz.mjs (docs/spec.md §19.2): programs made at random, valid by construction, each with answers made
// at random, run in the machine and the intermediate form's interpreter, and through the PDF
// check. A crash, a disagreement between the two (§19.1), or a mistake on a program the generator meant to be
// valid is a bug; each is reported with its seed, so `node scripts/fuzz.mjs 1 S` gives it again.
//
// The generator writes a program as a person would: an option set and a record, a few functions (pure ones that
// work numbers and words out, and one that asks), then a body of questions, lets, vars and their assignments, ifs,
// matches, loops, for eaches, collects, comprehensions and every kind of box write, each name used after it is
// declared and every answer and let read. Expressions are made by type, to a depth, from what is in scope.
//
// A program a check stops at its budget (S602, §15.1) is counted apart, not a bug. A run the machine exhausts
// (F014, F015) is not compared (§19.1.1).
import { compile } from "./compile.mjs";
import { load, run, boxValues } from "../runtime/vm.mjs";
import { interpretProgram } from "./interpret.mjs";
import { autoHeader } from "./selftest.mjs";

const PDF = "0".repeat(64);

// mulberry32: a small seeded generator, so every program can be made again from its seed.
function random(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  return { next, int, pick: (l) => l[int(0, l.length - 1)], chance: (p) => next() < p };
}

const N = { t: "number" }, T = { t: "text" }, B = { t: "yes-no" }, D = { t: "date" }, O = { t: "option" }, S = { t: "set" }, R = { t: "record" };
const LN = (most) => ({ t: "list", of: "number", most });
const LT = (most) => ({ t: "list", of: "text", most });
const same = (a, b) => a.t === b.t && a.of === b.of && a.most === b.most;
const typeWords = (t) => (t.t === "list" ? `list of ${t.of} most ${t.most}` : t.t === "option" ? "option of colour" : t.t === "set" ? "set of colour" : t.t === "record" ? "item" : t.t);

const COLOURS = ["red", "green", "blue"];
const WORDS = ["", "a", "Ada", "  x  ", "a,b,c", "Straße", "ς", "ſ", "İa", "12", "1 234.5", "\\u{1F600}", "line\\none", "quote \\\" in", "\\{brace\\}"];

export function generate(seed) {
  const r = random(seed);
  const lines = [];
  let counter = 0;
  const fresh = (p) => `${p}${++counter}`;
  const boxes = [];
  const box = (p) => {
    const b = fresh(p);
    boxes.push(b);
    return b;
  };

  // A scope: the names a statement can read, with their types and kinds; `reads` marks each read.
  const scope = (parent = null) => ({ parent, names: [] });
  const all = (sc) => (sc ? [...sc.names, ...all(sc.parent)] : []);
  const declare = (sc, name, type, kind) => {
    const n = { name, type, kind, read: false };
    sc.names.push(n);
    return n;
  };
  const ofType = (sc, type) => all(sc).filter((n) => same(n.type, type));
  const use = (n) => ((n.read = true), n.name);

  const functions = []; // { name, params: [types], result, asks }

  // ----- expressions by type

  function num(sc, d) {
    const vars = ofType(sc, N);
    const choices = [
      () => r.pick(["0", "1", "2", "3", "7", "10", "100", "2.5", "0.1", "0.25", "1000000", "99999999999999999999", "0.0000000000000000000000000000000001", "9999999999999999999999999999999999", "1234567890.123456789"]),
      () => `-${r.pick([1, 3, 0.5])}`,
    ];
    if (vars.length) choices.push(() => use(r.pick(vars)), () => use(r.pick(vars)));
    if (d > 0) {
      const sub = () => num(sc, d - 1);
      choices.push(
        () => `(${sub()} ${r.pick(["+", "-", "*"])} ${sub()})`,
        () => `(${sub()} ${r.pick(["/", "//", "%"])} ${r.chance(0.7) ? r.pick(["2", "3", "0.5", "-4"]) : sub()})`,
        () => `fact(whole(abs(either(${sub()}, 0))) % 6)`,
        () => `either(pick_one(${sub()}, ${sub()}), 0)`,
        () => `either(second(${r.chance(0.5) ? `[${sub()}]` : `[${sub()}, ${sub()}]`}), 0)`,
        () => `n_of([${sub()}, ${sub()}])`,
        () => `either(-${r.chance(0.5) ? "empty" : sub()}, 1)`,
        () => `round(${sub()}, ${r.int(0, 3)})`,
        () => `round(${sub()}, places: ${r.int(0, 3)})`,
        () => `round(${sub()})`,
        () => `${r.pick(["abs", "floor", "ceil", "whole"])}(${sub()})`,
        () => `${r.pick(["min", "max"])}(${sub()}, ${sub()})`,
        () => `length(${text(sc, d - 1)})`,
        () => `number_of(${text(sc, d - 1)})`,
        () => `(if ${bool(sc, d - 1)} then ${sub()} else ${sub()})`,
        () => `days_between(${date(sc, d - 1)}, ${date(sc, d - 1)})`,
        () => `year(${date(sc, d - 1)})`,
      );
      const lists = all(sc).filter((n) => n.type.t === "list" && n.type.of === "number");
      if (lists.length) {
        const l = r.pick(lists);
        choices.push(
          () => `count(${use(l)})`,
          () => `${use(l)}[${r.int(1, l.type.most)}]`,
          () => `either(smallest(${use(l)}), 0)`,
          () => `either(largest(${use(l)}), 0)`,
          () => `index_of(${use(l)}, ${sub()})`,
          () => `count(${use(l)}[${r.int(1, 2)}..${r.int(1, 3)}])`,
          () => `count(${use(l)} + [${sub()}])`,
        );
      }
      const recs = all(sc).filter((n) => n.type.t === "record");
      if (recs.length) choices.push(() => `${use(r.pick(recs))}.amount`);
      // What an answer can make fault as the program runs: a division by it, places, a width, a position.
      const answers = all(sc).filter((n) => n.type.t === "number" && (n.kind === "answer" || n.kind === "param"));
      if (answers.length) {
        const a = () => use(r.pick(answers));
        choices.push(
          () => `(${sub()} ${r.pick(["/", "//", "%"])} ${a()})`,
          () => `round(${sub()}, ${a()})`,
          () => `length(pad_left("x", ${a()}))`,
          () => `length(character("abc", ${a()}))`,
          () => `year(add_days(date_of(2000, 1, 1), ${a()} * 1000000))`,
          () => `fact(${a()})`,
          () => `count([${a()}, 2][1..${a()}])`,
        );
      }
      const fns = functions.filter((f) => f.result === "number" && !f.asks && f.ready);
      if (fns.length) {
        const f = r.pick(fns);
        choices.push(() => `${f.name}(${f.params.map((p) => expr(sc, p, d - 1)).join(", ")})`);
      }
    }
    return r.pick(choices)();
  }

  function text(sc, d) {
    const vars = ofType(sc, T);
    const choices = [() => `"${r.pick(WORDS)}"`];
    if (vars.length) choices.push(() => use(r.pick(vars)), () => use(r.pick(vars)));
    if (d > 0) {
      const sub = () => text(sc, d - 1);
      choices.push(
        () => `(${sub()} + ${sub()})`,
        () => `"<{${sub()}}|{${num(sc, d - 1)}}>"`,
        () => `${r.pick(["upper", "lower", "trim", "title", "capitalize", "digits", "letters"])}(${sub()})`,
        () => `slice(${sub()}, ${r.int(1, 3)}, ${r.int(1, 5)})`,
        () => `replace(${sub()}, "a", ${sub()})`,
        () => `pad_left(${sub()}, ${r.int(0, 8)}, "*")`,
        () => `pad_left(${sub()}, ${r.int(0, 8)})`,
        () => `remove_prefix(${sub()}, "a")`,
        () => `character(${sub()}, ${r.int(1, 4)})`,
        () => `line(${sub()}, ${r.int(1, 2)})`,
        () => `text_of(${num(sc, d - 1)})`,
        () => `fixed(${num(sc, d - 1)}, ${r.int(0, 2)})`,
        () => `grouped(${num(sc, d - 1)})`,
        () => `format(${date(sc, d - 1)}, "${r.pick(["YYYY-MM-DD", "DD/MM/YY", "M-D"])}")`,
        () => `either(${sub()}, "none given")`,
        () => `(if ${bool(sc, d - 1)} then ${sub()} else ${sub()})`,
        () => `word(${sub()}, ${r.int(1, 2)})`,
        () => `either(pick_one(${sub()}, ${sub()}), "")`,
      );
      const lists = all(sc).filter((n) => n.type.t === "list");
      if (lists.length) choices.push(() => `join(${use(r.pick(lists))}, "${r.pick([",", " ", ""])}")`, () => `join(${use(r.pick(lists))}, separator: "/")`, () => `join(sorted(${use(r.pick(lists))}, descending: yes))`);
      const tl = all(sc).filter((n) => n.type.t === "list" && n.type.of === "text");
      if (tl.length) choices.push(() => `either(first(${use(r.pick(tl))}), "-")`);
      const opts = ofType(sc, O);
      if (opts.length) choices.push(() => `text_of(${use(r.pick(opts))})`);
      const sets = ofType(sc, S);
      if (sets.length) {
        choices.push(() => `join(${use(r.pick(sets))})`);
        if (sets.length > 1 || r.chance(0.5)) choices.push(() => `join(${r.pick(["union", "intersection", "difference"])}(${use(r.pick(sets))}, ${use(r.pick(sets))}), ",")`);
        choices.push(() => `join(${r.pick(["union", "intersection", "difference"])}(${use(r.pick(sets))}, ["${r.pick(COLOURS)}"]), ",")`);
      }
      const recs = all(sc).filter((n) => n.type.t === "record");
      if (recs.length) choices.push(() => `${use(r.pick(recs))}.label`);
      const fns = functions.filter((f) => f.result === "text" && !f.asks && f.ready);
      if (fns.length) {
        const f = r.pick(fns);
        choices.push(() => `${f.name}(${f.params.map((p) => expr(sc, p, d - 1)).join(", ")})`);
      }
    }
    return r.pick(choices)();
  }

  function bool(sc, d) {
    const vars = ofType(sc, B);
    const choices = [() => r.pick(["yes", "no"])];
    if (vars.length) choices.push(() => use(r.pick(vars)), () => use(r.pick(vars)));
    if (d > 0) {
      choices.push(
        () => `(${num(sc, d - 1)} ${r.pick(["<", "<=", ">", ">=", "==", "!="])} ${num(sc, d - 1)})`,
        () => `(${text(sc, d - 1)} ${r.pick(["==", "!=", "<"])} ${text(sc, d - 1)})`,
        () => `(${bool(sc, d - 1)} ${r.pick(["and", "or"])} ${bool(sc, d - 1)})`,
        () => `(not ${bool(sc, d - 1)})`,
        () => `(${expr(sc, r.pick([N, T, B, D]), d - 1)} is ${r.chance(0.5) ? "not " : ""}empty)`,
        () => `${r.pick(["contains", "starts_with", "ends_with"])}(${text(sc, d - 1)}, ${text(sc, d - 1)})`,
        () => `(${date(sc, d - 1)} < ${date(sc, d - 1)})`,
      );
      const sets = ofType(sc, S);
      if (sets.length) {
        choices.push(() => `("${r.pick(COLOURS)}" ${r.pick(["in", "not in"])} ${use(r.pick(sets))})`);
        // A set compared with a list of its options, or with empty (§6.6).
        const some = () => `[${COLOURS.filter(() => r.chance(0.5)).map((c) => `"${c}"`).join(", ")}]`;
        choices.push(() => `(${use(r.pick(sets))} ${r.pick(["==", "!="])} ${r.chance(0.2) ? "empty" : some()})`);
      }
      const opts = ofType(sc, O);
      if (opts.length) choices.push(() => `(${use(r.pick(opts))} == "${r.pick(COLOURS)}")`);
      const lists = all(sc).filter((n) => n.type.t === "list" && n.type.of === "number");
      if (lists.length) choices.push(() => `(${num(sc, d - 1)} in ${use(r.pick(lists))})`);
      const recs = all(sc).filter((n) => n.type.t === "record");
      if (recs.length) choices.push(() => `${use(r.pick(recs))}.done`);
    }
    return r.pick(choices)();
  }

  function date(sc, d) {
    const vars = ofType(sc, D);
    const choices = [() => `date_of(${r.int(1990, 2030)}, ${r.int(1, 12)}, ${r.int(1, 28)})`];
    if (vars.length) choices.push(() => use(r.pick(vars)), () => use(r.pick(vars)));
    if (d > 0) choices.push(() => `add_days(${date(sc, d - 1)}, ${r.int(-400, 400)})`, () => `(if ${bool(sc, d - 1)} then ${date(sc, d - 1)} else ${date(sc, d - 1)})`);
    return r.pick(choices)();
  }

  function list(sc, type, d) {
    const vars = ofType(sc, type);
    const item = () => (type.of === "number" ? num(sc, d - 1) : text(sc, d - 1));
    const choices = [() => `[${Array.from({ length: r.int(0, type.most) }, item).join(", ")}]`];
    if (vars.length) {
      const v = r.pick(vars);
      choices.push(() => use(v), () => `${r.pick(["sorted", "reversed", "filled"])}(${use(v)})`);
      if (d > 0) {
        choices.push(() => `[${type.of === "number" ? "x * 2" : "upper(x)"} for each x in ${use(v)}]`);
        choices.push(() => `[${type.of === "number" ? "x + k" : "x + text_of(k)"} for each k, x in ${use(v)} if k ${r.pick([">", "<", "!="])} ${r.int(1, 2)}]`);
        if (type.of === "number") choices.push(() => `doubled(${use(v)})`);
      }
    }
    // A literal with no items is a list of most 0, placed anywhere (§3.7); only literals and same-typed names here.
    return r.pick(choices)();
  }

  function expr(sc, type, d) {
    switch (type.t) {
      case "number":
        return num(sc, d);
      case "text":
        return text(sc, d);
      case "yes-no":
        return bool(sc, d);
      case "date":
        return date(sc, d);
      case "list":
        return list(sc, type, d);
      default:
        throw new Error(`no expression of ${type.t}`);
    }
  }

  // ----- statements

  const ind = (n) => "  ".repeat(n);
  // Every name a block declared is read before the block ends, so no answer, let or var goes unused.
  function readAll(sc, depth, out) {
    for (const n of sc.names) if (!n.read && n.kind !== "counter") out.push(`${ind(depth)}print(${use(n)})`);
  }

  function block(sc, depth, budget, { inLoop = null, inFunction = false } = {}) {
    const out = [];
    for (let k = 0; k < budget; k++) out.push(...statement(sc, depth, { inLoop, inFunction }));
    return out;
  }

  function statement(sc, depth, ctx) {
    const i = ind(depth);
    const d = r.int(1, 3);
    const top = depth === (ctx.inFunction ? 1 : 0) && !ctx.inLoop;
    const kinds = ["print", "fill", "if"];
    if (top) kinds.push("ask", "ask", "let", "let", "var", "for", "each", "collect", "match", "record", "call");
    if (all(sc).some((n) => n.kind === "var")) kinds.push("assign", "assign");
    if (ctx.inLoop) kinds.push("loopfill", "loopfill", "leave");
    if (top && !ctx.inFunction) kinds.push("skip", "rows", "grow");
    const kind = r.pick(kinds);
    switch (kind) {
      case "print":
        return [`${i}print(${expr(sc, r.pick([N, T, B, D]), d)})`];
      case "fill": {
        if (ctx.inLoop || ctx.inFunction) return [`${i}print(${text(sc, d)})`];
        const w = r.int(0, 2);
        if (w === 0) return [`${i}fill "${box("F")}" = ${expr(sc, r.pick([N, T, D]), d)}`];
        if (w === 1) return [`${i}tick "${box("C")}" when ${bool(sc, d)}`];
        // One radio group is picked at most once on a path (§10.4.2): its buttons on conditions that exclude
        // each other, which the PDF check follows both ways (§10.4.1).
        const g = box("G");
        const on = `${g.toLowerCase()}_on`;
        return [`${i}let ${on} = ${bool(sc, d)}`, `${i}pick "${g}" "x" when ${on}`, `${i}pick "${g}" "y" when not ${on}`];
      }
      case "leave":
        // break or continue under a condition: the loop's turns are what the run decides (§7.13).
        // On the counter, so it is not known before the form opens: a known one leaves what follows unreachable (S406).
        return [`${i}if (${ctx.inLoop.counter} == ${r.int(1, 3)}) and ${bool(sc, d)} {`, `${i}  ${r.pick(["break", "continue"])}`, `${i}}`];
      case "skip":
        return [`${i}skip "${box("K")}" because "${r.pick(["not used", "the office fills it"])}"`];
      case "rows": {
        // A collect of records: each item's fields asked, then the list read field by field.
        const name = fresh("rows");
        const x = fresh("row");
        const out = [`${i}var ${name}: list of item most ${r.int(1, 3)}`, `${i}collect ${x} in ${name} "Another row?" {`, `${i}  ask ${x}.label: text "Label"`, `${i}  ask ${x}.amount: number "Amount"`, `${i}  ask ${x}.done: yes-no "Done"`, `${i}}`];
        out.push(`${i}for each n, row in ${r.chance(0.5) ? `sorted(${name}, by: "${r.pick(["label", "amount"])}"${r.chance(0.5) ? ", descending: yes" : ""})` : name} {`, `${i}  fill "${box("R")}_{n}" = row.label`, `${i}  print(row.amount)`, `${i}  print(row.done)`, `${i}}`);
        boxes.pop();
        return out;
      }
      case "grow": {
        // A list made longer by +: the sum's most is the two mosts added (§3.7.5), placed where that fits.
        const name = fresh("grow");
        const more = fresh("grow");
        return [`${i}var ${name}: list of number most 4 = [${num(sc, 1)}]`, `${i}${name}[2] = ${num(sc, 1)}`, `${i}let ${more}: list of number most 6 = ${name} + [${num(sc, 1)}, ${num(sc, 1)}]`, `${i}print(${more})`, `${i}print(${more}[1..3])`, `${i}print(${name})`];
      }
      case "loopfill":
        return [`${i}fill "${ctx.inLoop.box}_{${ctx.inLoop.counter}}_${++counter}" = ${expr(sc, r.pick([N, T]), d)}`];
      case "ask": {
        const type = r.pick(["text", "number", "yes-no", "date", "one-of", "any-of", "long-text", "phone", "email"]);
        const name = fresh("q");
        const t = { text: T, "long-text": T, phone: { t: "phone" }, email: { t: "email" }, number: N, "yes-no": B, date: D, "one-of": O, "any-of": S }[type];
        const what = type === "one-of" || type === "any-of" ? `${type} colour` : type;
        let line = `${i}ask ${name}: ${what} "${r.pick(["Name", "How many", "When", "Which"])} {${r.int(1, 9)}}?"`;
        if (r.chance(0.3) && ["text", "number", "date", "yes-no"].includes(type)) line += ` default ${expr(sc, t, 1)}`;
        const n = declare(sc, name, t, "answer");
        const out = [line];
        if (r.chance(0.3) && (type === "number" || type === "text")) out.push(`${i}  check ${name} is empty or ${type === "number" ? `${name} > 0` : `length(${name}) < 20`} "Too ${type === "number" ? "small" : "long"}."`);
        // Into a box the way its type goes: a yes-no ticks one, a set's options are joined (§10).
        if (r.chance(0.5)) out.push(type === "yes-no" ? `${i}tick "${box("A")}" when ${use(n)}` : `${i}fill "${box("A")}" = ${type === "any-of" ? `join(${use(n)})` : use(n)}`);
        return out;
      }
      case "let": {
        const type = r.pick([N, T, B, D, LN(3), LT(2)]);
        const name = fresh("v");
        const line = `${i}let ${name}${type.t === "list" ? `: ${typeWords(type)}` : ""} = ${expr(sc, type, d)}`;
        declare(sc, name, type, "let");
        return [line];
      }
      case "var": {
        const type = r.pick([N, T, B, LN(3)]);
        const name = fresh("m");
        const line = `${i}var ${name}: ${typeWords(type)} = ${expr(sc, type, d)}`;
        declare(sc, name, type, "var");
        return [line];
      }
      case "assign": {
        const v = r.pick(all(sc).filter((n) => n.kind === "var"));
        if (v.type.t === "record") return [`${i}${v.name}.label = ${text(sc, d)}`];
        if (v.type.t === "list") {
          // Known positions within the most (one outside is S360); a worked-out one may fault as the program runs.
          const answers = all(sc).filter((n) => n.kind === "answer" && n.type.t === "number");
          const at = answers.length && r.chance(0.3) ? `whole(either(${use(r.pick(answers))}, 1))` : r.int(1, v.type.most);
          return [`${i}${v.name}[${at}] = ${num(sc, d)}`];
        }
        if (v.type.t === "number" && r.chance(0.5)) return [`${i}${v.name} ${r.pick(["+=", "-=", "*="])} ${num(sc, d)}`];
        return [`${i}${v.name} = ${expr(sc, v.type, d)}`];
      }
      case "if": {
        const out = [`${i}if ${bool(sc, d)} {`];
        out.push(...block(scope(sc), depth + 1, r.int(1, 2), ctx));
        if (r.chance(0.5)) {
          out.push(`${i}} else {`);
          out.push(...block(scope(sc), depth + 1, r.int(1, 2), ctx));
        }
        out.push(`${i}}`);
        return out;
      }
      case "match": {
        const opts = ofType(sc, O);
        const texts = ofType(sc, T);
        if (texts.length && (r.chance(0.4) || !opts.length)) {
          // A match on words: the arms are words in quotes (§7.10).
          const t = r.pick(texts);
          const out = [`${i}match ${use(t)} {`];
          for (const w of ["a", "Ada", ""].slice(0, r.int(1, 3))) out.push(`${i}  "${w}" => {`, ...block(scope(sc), depth + 2, 1, ctx), `${i}  }`);
          out.push(`${i}  else => {`, ...block(scope(sc), depth + 2, 1, ctx), `${i}  }`, `${i}}`);
          return out;
        }
        if (!opts.length) return [];
        const o = r.pick(opts);
        const out = [`${i}match ${use(o)} {`];
        for (const c of COLOURS.slice(0, r.int(1, 3))) out.push(`${i}  "${c}" => {`, ...block(scope(sc), depth + 2, 1, ctx), `${i}  }`);
        if (r.chance(0.5)) out.push(`${i}  else => {`, ...block(scope(sc), depth + 2, 1, ctx), `${i}  }`);
        out.push(`${i}}`);
        return out;
      }
      case "for": {
        const c = fresh("i");
        const inner = scope(sc);
        declare(inner, c, N, "counter");
        const loop = { counter: c, box: box("L") };
        boxes.pop();
        const from = r.int(1, 2), to = r.int(0, 3);
        const out = [`${i}for ${c} in ${from}..${to} {`, `${i}  fill "${loop.box}_{${c}}" = ${c}`];
        for (let k = from; k <= to; k++) boxes.push(`${loop.box}_${k}`);
        if (r.chance(0.4)) {
          const q = fresh("q");
          out.push(`${i}  ask ${q}: number "Turn {${c}}"`, `${i}  print(${q})`);
        }
        out.push(...block(inner, depth + 1, r.int(1, 2), { ...ctx, inLoop: loop }));
        out.push(`${i}}`);
        return out;
      }
      case "each": {
        const lists = all(sc).filter((n) => n.type.t === "list");
        if (!lists.length) return [];
        const l = r.pick(lists);
        const inner = scope(sc);
        const x = fresh("x");
        declare(inner, x, l.type.of === "number" ? N : T, "item");
        const out = [`${i}for each ${x} in ${use(l)} {`, `${i}  print(${x})`];
        inner.names[0].read = true;
        out.push(`${i}  print(${expr(inner, r.pick([N, T, B]), d)})`);
        out.push(`${i}}`);
        return out;
      }
      case "collect": {
        const name = fresh("people");
        const most = r.int(1, 3);
        const x = fresh("p");
        const extra = r.chance(0.5) ? [`${i}  ask ${x}_note: text "Note"`, `${i}  print(${x}_note)`] : [];
        const out = [`${i}var ${name}: list of text most ${most}`, `${i}collect ${x} in ${name}${r.chance(0.5) ? ` any "Any {${r.int(1, 3)}}?"` : ""} "Another?" {`, `${i}  ask ${x}: text "Who"`, ...extra, `${i}}`];
        declare(sc, name, LT(most), "collected");
        return out;
      }
      case "record": {
        const name = fresh("it");
        const out = [`${i}var ${name}: item = new item { label: ${text(sc, d)}, amount: ${num(sc, d)} }`];
        const n = declare(sc, name, R, "var");
        if (r.chance(0.5)) out.push(`${i}ask ${name}.done: yes-no "Done?"`);
        else out.push(`${i}${name}.done = ${bool(sc, d)}`);
        if (r.chance(0.5)) out.push(`${i}${name}.amount = ${num(sc, d)}`);
        if (r.chance(0.5)) out.push(`${i}${name}.tags[${r.int(1, 2)}] = ${text(sc, d)}`, `${i}print(${name}.tags)`);
        out.push(`${i}print(${use(n)})`, `${i}print(${name}.done)`);
        return out;
      }
      case "call": {
        const asking = functions.filter((f) => f.asks && f.ready);
        if (!asking.length) return [];
        // Its question is keyed by its known-only argument: each call its own, or the question is asked twice.
        const f = r.pick(asking);
        f.calls = (f.calls ?? 0) + 1;
        return [`${i}print(${f.name}(${f.calls}))`];
      }
      default:
        return [];
    }
  }

  // ----- the program

  lines.push("form fuzz", `pdf ${PDF}`, "");
  lines.push(`options colour {`, ...COLOURS.map((c) => `  "${c}" "${c[0].toUpperCase()}${c.slice(1)}"`), `}`);
  lines.push("record item {", "  label: text", "  amount: number", "  done: yes-no", "  tags: list of text most 2", "}", "");
  // Helpers every program has: a loop with bounds worked out as it runs, a generic function, list parameters
  // whose most comes with the argument. (A function calling itself is S401.)
  lines.push(
    "define fact(n: number) -> number {",
    "  var p = 1",
    "  for i in 1..n {",
    "    p *= i",
    "  }",
    "  return p",
    "}",
    "define pick_one<t>(a: t, b: t) -> t {",
    "  if a is empty {",
    "    return b",
    "  }",
    "  return a",
    "}",
    "define n_of(xs: list of number) -> number {",
    "  return count([x * 2 for each x in xs if x != 0])",
    "}",
    "define second(xs: list of number) -> number {",
    "  return xs[2]",
    "}",
    "define doubled(xs: list of number most 3) -> list of number most 3 {",
    "  var out: list of number most 3",
    "  for each k, x in xs {",
    "    out[k] = x * 2",
    "  }",
    "  return out",
    "}",
    "",
  );
  // Pure functions of numbers and words, and one that asks.
  for (let k = 0; k < r.int(1, 3); k++) {
    const name = fresh("f");
    const params = Array.from({ length: r.int(1, 3) }, () => r.pick([N, T, B]));
    const result = r.pick(["number", "text"]);
    const f = { name, params, result, asks: false, ready: false };
    const sc = scope();
    const ps = params.map((p, j) => declare(sc, `a${j}`, p, "param"));
    const body = [];
    if (r.chance(0.5)) {
      // A condition on a parameter: one known before the form opens would leave the last return unreachable (S406).
      body.push(`  if (text_of(${use(ps[0])}) == "1") or ${bool(sc, 2)} {`, `    return ${expr(sc, result === "number" ? N : T, 2)}`, `  }`);
    }
    body.push(`  return ${expr(sc, result === "number" ? N : T, 2)}`);
    // A parameter not read is no mistake; a function not called is only a warning.
    lines.push(`define ${name}(${ps.map((p) => `${p.name}: ${typeWords(p.type)}`).join(", ")}) -> ${result} {`, ...body, "}", "");
    f.ready = true;
    functions.push(f);
  }
  {
    const name = fresh("g");
    const sc = scope();
    const p = declare(sc, "n", N, "param");
    lines.push(`define ${name}(n: number) -> number {`, `  ask k: number "Value {n}"`, `  return either(k, 0) + ${use(p)}`, "}", "");
    functions.push({ name, params: [N], result: "number", asks: true, ready: true });
  }
  const main = scope();
  lines.push(...block(main, 0, r.int(4, 12)));
  readAll(main, 0, lines);
  return { source: lines.join("\n") + "\n", boxes };
}

// Answers for the questions a run reaches: made at random by type, sometimes not answered, sometimes nonsense.
function answerFor(r, step) {
  if (r.chance(0.15)) return undefined;
  if (r.chance(0.05)) return r.pick(["", "???", "1e5", "0x10", "2024-02-30"]);
  switch (step.question.type) {
    case "number":
      return r.pick(["0", "1", "-2", "3.5", "1,000", "12345678901234567890.25", "0.000001", "abc", ""]);
    case "date":
      return r.pick(["2024-02-29", "2023-02-29", "1999-12-31", "0001-01-01", "9999-12-31", "31/12/2020"]);
    case "yes-no":
      return r.pick(["yes", "no", true, false, "maybe"]);
    case "one-of":
      return r.pick([...COLOURS, "purple"]);
    case "any-of":
      return r.pick([[], ["red"], ["blue", "red"], ["green", "purple"]]);
    default:
      return r.pick(WORDS.map((w) => w.replace(/\\u\{1F600\}/, "😀").replace(/\\n/, "\n").replace(/\\"/, '"')));
  }
}

const view = (x) =>
  JSON.stringify({
    steps: x.steps.map((s) => ({ key: s.key, printed: s.printed, value: s.value, default: s.default, failed: s.failed, unreadable: s.unreadable ?? null })),
    boxes: Object.fromEntries(Object.entries(x.boxes).filter(([, v]) => v !== "" && v !== "Off").sort(([a], [b]) => (a < b ? -1 : 1))),
    prints: x.prints,
    fault: x.fault ? { code: x.fault.code, message: x.fault.message, file: x.fault.file, line: x.fault.line, column: x.fault.column, stack: x.fault.stack.map((f) => `${f.function} ${f.file}:${f.line}:${f.column}`) } : null,
  });

// One program made from `seed`, run on answers grown over a few runs. Gives { seed, outcome, problem?, source }.
export function fuzzOne(seed) {
  let made;
  try {
    made = generate(seed);
  } catch (e) {
    return { seed, outcome: "bug", problem: `the generator broke: ${e.stack}` };
  }
  const { source } = made;
  let header, build;
  try {
    header = autoHeader(source, "fuzz.stride");
    build = compile(source, "fuzz.stride", { header });
  } catch (e) {
    return { seed, outcome: "bug", problem: `the compiler crashed: ${e.stack}`, source };
  }
  const mistakes = build.diagnostics.sorted().filter((d) => d.severity === "error");
  if (mistakes.length) {
    // A check stopped at its budget proves nothing either way, whatever it found before it stopped (§15.1).
    if (mistakes.some((m) => m.code === "S602")) return { seed, outcome: "budget", source };
    return { seed, outcome: "bug", problem: `a mistake on a program meant to be valid: ${mistakes.slice(0, 3).map((m) => `${m.line}:${m.column} ${m.code} ${m.message}`).join("; ")}`, source };
  }

  const r = random(seed ^ 0x5eed);
  const today = "2026-11-07";
  const answers = {};
  let compared = 0;
  const faults = [];
  for (let round = 0; round < 4; round++) {
    const results = {};
    try {
      // The boxes these answers reach are the form's for this run (a name worked out as the program runs).
      build = compile(source, "fuzz.stride", { header: autoHeader(source, "fuzz.stride", {}, [answers]) });
      for (const [mode, b] of [["vm", build], ["ir", build]]) {
        if (mode.startsWith("vm")) {
          const p = load(b.bytecode);
          const x = run(p, answers, { today });
          results[mode] = { steps: x.steps, boxes: boxValues(p, x.writes), prints: x.prints, fault: x.fault };
        } else {
          const x = interpretProgram(b.program, answers, b.boxes, { today });
          const boxes = {};
          for (const [k, w] of x.writes) boxes[k] = w;
          results[mode] = { steps: x.steps, boxes, prints: x.prints, fault: x.fault };
        }
      }
    } catch (e) {
      return { seed, outcome: "bug", problem: `an engine crashed: ${e.stack}`, source, answers };
    }
    // A run the reference exhausts is not compared (§19.1.1).
    if (["F014", "F015"].includes(results.vm.fault?.code)) return { seed, outcome: "exhausted", source };
    const ref = view(results.vm);
    for (const [mode, x] of Object.entries(results)) {
      if (view(x) !== ref) return { seed, outcome: "bug", problem: `${mode} and vm disagree:\n  ${view(x)}\n  ${ref}`, source, answers: { ...answers } };
    }
    compared++;
    faults.push(results.vm.fault?.code ?? null);
    // Answers for the questions this run reached that have none yet; the next run may reach more.
    let added = false;
    for (const s of results.vm.steps) {
      if (s.key in answers) continue;
      const a = answerFor(r, s);
      if (a !== undefined) answers[s.key] = a;
      added = true;
    }
    if (!added) break;
  }
  return { seed, outcome: "agreed", runs: compared, faults, source };
}

export function fuzz({ runs = 100, seed = 1 } = {}) {
  const counts = { agreed: 0, budget: 0, exhausted: 0, bug: 0 };
  const bugs = [];
  const faults = {}; // runs compared, by the fault they stopped on: how much of the machine's checking was met
  let compared = 0;
  for (let k = 0; k < runs; k++) {
    const out = fuzzOne(seed + k);
    counts[out.outcome]++;
    if (out.outcome === "bug") bugs.push(out);
    for (const f of out.faults ?? []) (compared++, (faults[f ?? "none"] = (faults[f ?? "none"] ?? 0) + 1));
  }
  return { counts, bugs, faults, compared };
}
