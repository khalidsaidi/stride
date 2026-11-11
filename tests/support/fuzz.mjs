// node scripts/fuzz.mjs (docs/spec.md §19.2): programs made at random, valid by construction, each with answers made
// at random, run in the machine. A crash, a fault that is the compiler's or the machine's own, or a mistake on a
// program the generator meant to be valid is a bug; each is reported with its seed, so `node scripts/fuzz.mjs 1 S` gives it again.
//
// The generator writes a program as a person would: an option set and a record, a few functions (pure ones that
// work numbers and words out, and one that asks), then a body of questions, lets, vars and their assignments, ifs,
// matches, loops over ranges and lists, collects, comprehensions and every kind of box write, each name used after it is
// declared and every answer and let read. Expressions are made by type, to a depth, from what is in scope.
//
// A run the machine exhausts (F014, F015) is passed over (§19.1.2).
import { compile } from "../../src/compile.mjs";
import { load, run, boxValues } from "../../runtime/vm.mjs";
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

const N = { t: "number" }, T = { t: "string" }, B = { t: "bool" }, D = { t: "date" }, O = { t: "option" }, S = { t: "set" }, R = { t: "record" };
const LN = { t: "list", of: "number" }, LT = { t: "list", of: "string" };
const same = (a, b) => a.t === b.t && a.of === b.of;
const typeWords = (t) => (t.t === "list" ? `list<${t.of}>` : t.t === "option" ? "colour" : t.t === "set" ? "set<colour>" : t.t === "record" ? "item" : t.t);

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
  // A name read where a value is needed (§6.3): an answer or a list's item may be null, so it is read with a
  // value for that; now and then as it is, which may fault (F023).
  const OTHERWISE = { number: ["0", "1", "2.5"], string: ['""', '"-"'], date: ["date_of(2000, 1, 1)"] };
  const val = (n) => (["answer", "item"].includes(n.kind) && OTHERWISE[n.type.t] && !r.chance(0.1) ? `(${use(n)} ?? ${r.pick(OTHERWISE[n.type.t])})` : use(n));
  // A list whose items are all there, for what puts them in order or computes with them.
  const whole = (n) => (n.type.of === "string" ? `filled(${use(n)})` : use(n));

  const functions = []; // { name, params: [types], result, asks }

  // ----- expressions by type

  function num(sc, d) {
    const vars = ofType(sc, N);
    const choices = [
      () => r.pick(["0", "1", "2", "3", "7", "10", "100", "2.5", "0.1", "0.25", "1000000", "99999999999999999999", "0.0000000000000000000000000000000001", "9999999999999999999999999999999999", "1234567890.123456789"]),
      () => `-${r.pick([1, 3, 0.5])}`,
    ];
    if (vars.length) choices.push(() => val(r.pick(vars)), () => val(r.pick(vars)));
    if (d > 0) {
      const sub = () => num(sc, d - 1);
      choices.push(
        () => `(${sub()} ${r.pick(["+", "-", "*"])} ${sub()})`,
        () => `(${sub()} ${r.pick(["/", "//", "%"])} ${r.chance(0.7) ? r.pick(["2", "3", "0.5", "-4"]) : sub()})`,
        () => `fact(whole(abs(either(${sub()}, 0))) % 6)`,
        () => `either(pick_one(${sub()}, ${sub()}), 0)`,
        () => `either(second(${r.chance(0.5) ? `[${sub()}]` : `[${sub()}, ${sub()}]`}), 0)`,
        () => `n_of([${sub()}, ${sub()}])`,
        () => `(${r.chance(0.5) ? "null" : `-${sub()}`} ?? 1)`,
        () => `(pick_one(${sub()}, null) ?? ${sub()})`,
        () => `round(${sub()}, ${r.int(0, 3)})`,
        () => `round(${sub()}, places: ${r.int(0, 3)})`,
        () => `round(${sub()})`,
        () => `${r.pick(["abs", "floor", "ceil", "whole"])}(${sub()})`,
        () => `${r.pick(["min", "max"])}(${sub()}, ${sub()})`,
        () => `length(${text(sc, d - 1)})`,
        () => `(number_of(${text(sc, d - 1)}) ?? ${r.int(0, 2)})`,
        () => `(if ${bool(sc, d - 1)} then ${sub()} else ${sub()})`,
        () => `days_between(${date(sc, d - 1)}, ${date(sc, d - 1)})`,
        () => `year(${date(sc, d - 1)})`,
      );
      const lists = all(sc).filter((n) => n.type.t === "list" && n.type.of === "number");
      if (lists.length) {
        const l = r.pick(lists);
        choices.push(
          () => `count(${use(l)})`,
          // An item read where the list holds it; now and then wherever, which may fault (F004).
          () => {
            const at = r.int(0, 2);
            return r.chance(0.9) ? `(if count(${use(l)}) > ${at} then ${use(l)}[${at}] else 0)` : `${use(l)}[${at}]`;
          },
          () => `either(smallest(${use(l)}), 0)`,
          () => `either(largest(${use(l)}), 0)`,
          () => `index_of(${use(l)}, ${sub()})`,
          () => `count(${use(l)}[${r.int(0, 1)}${r.pick(["..", "..<"])}${r.int(0, 3)}])`,
          () => `count(${use(l)}${r.pick([`[${r.int(0, 2)}..]`, `[..${r.int(0, 2)}]`, `[..<${r.int(0, 3)}]`])})`,
          () => `count(${use(l)} + [${sub()}])`,
        );
      }
      const recs = all(sc).filter((n) => n.type.t === "record");
      if (recs.length) choices.push(() => `${use(r.pick(recs))}.amount`);
      // What an answer can make fault as the program runs: a division by it, places, a width, a position.
      const answers = all(sc).filter((n) => n.type.t === "number" && (n.kind === "answer" || n.kind === "param"));
      if (answers.length) {
        const a = () => val(r.pick(answers));
        choices.push(
          () => `(${sub()} ${r.pick(["/", "//", "%"])} ${a()})`,
          () => `round(${sub()}, ${a()})`,
          () => `length(pad_left("x", ${a()}))`,
          () => `length(character("abc", ${a()}) ?? "")`,
          () => `year(add_days(date_of(2000, 1, 1), ${a()} * 1000000))`,
          () => `fact(${a()})`,
          () => `count([${a()}, 2][0${r.pick(["..", "..<"])}${a()}])`,
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
    if (vars.length) choices.push(() => val(r.pick(vars)), () => val(r.pick(vars)));
    if (d > 0) {
      const sub = () => text(sc, d - 1);
      choices.push(
        () => `(${sub()} + ${sub()})`,
        () => `"<{${sub()}}|{${num(sc, d - 1)}}>"`,
        () => `${r.pick(["upper", "lower", "trim", "title", "capitalize", "digits", "letters"])}(${sub()})`,
        () => `slice(${sub()}, ${r.int(0, 2)}, ${r.int(0, 4)})`,
        () => `replace(${sub()}, "a", ${sub()})`,
        () => `pad_left(${sub()}, ${r.int(0, 8)}, "*")`,
        () => `pad_left(${sub()}, ${r.int(0, 8)})`,
        () => `remove_prefix(${sub()}, "a")`,
        () => `(character(${sub()}, ${r.int(0, 3)}) ?? "")`,
        () => `(line(${sub()}, ${r.int(0, 1)}) ?? "no line")`,
        () => `string_of(${num(sc, d - 1)})`,
        () => `fixed(${num(sc, d - 1)}, ${r.int(0, 2)})`,
        () => `grouped(${num(sc, d - 1)})`,
        () => `format(${date(sc, d - 1)}, "${r.pick(["YYYY-MM-DD", "DD/MM/YY", "M-D"])}")`,
        () => `either(${sub()}, "none given")`,
        () => `(if ${bool(sc, d - 1)} then ${sub()} else ${sub()})`,
        () => `(word(${sub()}, ${r.int(0, 1)}) ?? "")`,
        () => `either(pick_one(${sub()}, ${sub()}), "")`,
      );
      const lists = all(sc).filter((n) => n.type.t === "list");
      if (lists.length) choices.push(() => `join(${use(r.pick(lists))}, "${r.pick([",", " ", ""])}")`, () => `join(${use(r.pick(lists))}, separator: "/")`, () => `join(sorted(${whole(r.pick(lists))}, descending: true))`);
      const tl = all(sc).filter((n) => n.type.t === "list" && n.type.of === "string");
      if (tl.length) choices.push(() => `either(first(${use(r.pick(tl))}), "-")`);
      const opts = ofType(sc, O);
      if (opts.length) choices.push(() => `string_of(${use(r.pick(opts))})`);
      const sets = ofType(sc, S);
      if (sets.length) {
        // A set not answered is null (§8.7): `?? []` makes it a set with no options.
        const chosen = () => `(${use(r.pick(sets))} ?? [])`;
        choices.push(() => `join(${chosen()})`);
        if (sets.length > 1 || r.chance(0.5)) choices.push(() => `join(${r.pick(["union", "intersection", "difference"])}(${chosen()}, ${chosen()}), ",")`);
        choices.push(() => `join(${r.pick(["union", "intersection", "difference"])}(${chosen()}, ["${r.pick(COLOURS)}"]), ",")`);
      }
      const recs = all(sc).filter((n) => n.type.t === "record");
      if (recs.length) choices.push(() => `${use(r.pick(recs))}.label`);
      const fns = functions.filter((f) => f.result === "string" && !f.asks && f.ready);
      if (fns.length) {
        const f = r.pick(fns);
        choices.push(() => `${f.name}(${f.params.map((p) => expr(sc, p, d - 1)).join(", ")})`);
      }
    }
    return r.pick(choices)();
  }

  function bool(sc, d) {
    const vars = ofType(sc, B);
    const choices = [() => r.pick(["true", "false"])];
    if (vars.length) choices.push(() => use(r.pick(vars)), () => use(r.pick(vars)));
    if (d > 0) {
      choices.push(
        () => `(${num(sc, d - 1)} ${r.pick(["<", "<=", ">", ">=", "==", "!="])} ${num(sc, d - 1)})`,
        () => `(${text(sc, d - 1)} ${r.pick(["==", "!=", "<"])} ${text(sc, d - 1)})`,
        () => `(${bool(sc, d - 1)} ${r.pick(["and", "or"])} ${bool(sc, d - 1)})`,
        () => `(not ${bool(sc, d - 1)})`,
        () => `(${expr(sc, r.pick([N, T, B, D]), d - 1)} ${r.chance(0.5) ? "!=" : "=="} null)`,
        () => `(${r.pick(["null", '""'])} ${r.pick(["==", "!="])} ${r.pick(["null", '""'])})`,
        () => `${r.pick(["contains", "starts_with", "ends_with"])}(${text(sc, d - 1)}, ${text(sc, d - 1)})`,
        () => `(${date(sc, d - 1)} < ${date(sc, d - 1)})`,
      );
      const sets = ofType(sc, S);
      if (sets.length) {
        choices.push(() => `("${r.pick(COLOURS)}" ${r.pick(["in", "not in"])} (${use(r.pick(sets))} ?? []))`);
        // A set compared with a list of its options, or with null (§6.6).
        const some = () => `[${COLOURS.filter(() => r.chance(0.5)).map((c) => `"${c}"`).join(", ")}]`;
        choices.push(() => `(${use(r.pick(sets))} ${r.pick(["==", "!="])} ${r.chance(0.2) ? "null" : some()})`);
      }
      const opts = ofType(sc, O);
      if (opts.length) choices.push(() => `(${use(r.pick(opts))} == "${r.pick(COLOURS)}")`);
      const lists = all(sc).filter((n) => n.type.t === "list" && n.type.of === "number");
      if (lists.length) choices.push(() => `(${num(sc, d - 1)} in ${use(r.pick(lists))})`);
      const recs = all(sc).filter((n) => n.type.t === "record");
      if (recs.length) choices.push(() => `${use(r.pick(recs))}.done`);
      // What an answer holds or not, whatever its type.
      const answers = all(sc).filter((n) => n.kind === "answer");
      if (answers.length) choices.push(() => `(${use(r.pick(answers))} ${r.chance(0.5) ? "!=" : "=="} null)`);
    }
    return r.pick(choices)();
  }

  function date(sc, d) {
    const vars = ofType(sc, D);
    const choices = [() => `date_of(${r.int(1990, 2030)}, ${r.int(1, 12)}, ${r.int(1, 28)})`];
    if (vars.length) choices.push(() => val(r.pick(vars)), () => val(r.pick(vars)));
    if (d > 0) choices.push(() => `add_days(${date(sc, d - 1)}, ${r.int(-400, 400)})`, () => `(if ${bool(sc, d - 1)} then ${date(sc, d - 1)} else ${date(sc, d - 1)})`);
    return r.pick(choices)();
  }

  function list(sc, type, d) {
    const vars = ofType(sc, type);
    const item = () => (type.of === "number" ? num(sc, d - 1) : text(sc, d - 1));
    const choices = [() => `[${Array.from({ length: r.int(0, 3) }, item).join(", ")}]`];
    if (vars.length) {
      const v = r.pick(vars);
      choices.push(() => use(v), () => `sorted(${whole(v)})`, () => `${r.pick(["reversed", "filled"])}(${use(v)})`);
      if (d > 0) {
        choices.push(() => `[${type.of === "number" ? "x * 2" : 'upper(x ?? "")'} for x in ${use(v)}]`);
        choices.push(() => `[${type.of === "number" ? "x + k" : "x + string_of(k)"} for k, x in ${whole(v)} if k ${r.pick([">", "<", "!="])} ${r.int(0, 1)}]`);
        if (type.of === "number") choices.push(() => `doubled(${use(v)})`);
      }
    }
    return r.pick(choices)();
  }

  function expr(sc, type, d) {
    switch (type.t) {
      case "number":
        return num(sc, d);
      case "string":
        return text(sc, d);
      case "bool":
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
    if (top && !ctx.inFunction) kinds.push("rows", "grow", "shared", "shared");
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
        // each other, so either may run.
        const g = box("G");
        const on = `${g.toLowerCase()}_on`;
        return [`${i}let ${on} = ${bool(sc, d)}`, `${i}pick "${g}" "x" when ${on}`, `${i}pick "${g}" "y" when not ${on}`];
      }
      case "leave":
        // break or continue under a condition: the loop's turns are what the run decides (§7.13).
        // On the counter, so it is not written out: one written out leaves what follows unreachable (S406).
        return [`${i}if (${ctx.inLoop.counter} == ${r.int(1, 3)}) and ${bool(sc, d)} {`, `${i}  ${r.pick(["break", "continue"])}`, `${i}}`];
      case "rows": {
        // A collect of records: each item's fields asked, then the list read field by field.
        const name = fresh("rows");
        const x = fresh("row");
        const out = [`${i}var ${name}: list<item>`, `${i}collect ${x} in ${name} "Another row?" {`, `${i}  ask ${x}.label: string "Label"`, `${i}  ask ${x}.amount: number "Amount"`, `${i}  ask ${x}.done: bool "Done"`, `${i}}`];
        out.push(`${i}for n, row in ${r.chance(0.5) ? ((by) => `sorted([x for x in ${name} if x.${by} != null], by: "${by}"${r.chance(0.5) ? ", descending: true" : ""})`)(r.pick(["label", "amount"])) : name} {`, `${i}  fill "${box("R")}_{n}" = row.label`, `${i}  print(row.amount)`, `${i}  print(row.done)`, `${i}}`);
        boxes.pop();
        return out;
      }
      case "grow": {
        // A list made longer by +.
        const name = fresh("grow");
        const more = fresh("grow");
        return [`${i}var ${name}: list<number> = [${num(sc, 1)}]`, `${i}${name}[1] = ${num(sc, 1)}`, `${i}let ${more}: list<number> = ${name} + [${num(sc, 1)}, ${num(sc, 1)}]`, `${i}print(${more})`, `${i}print(${more}[${r.pick(["0..2", "0..<3", "1..", "..<2"])}])`, `${i}print(${name})`];
      }
      case "shared": {
        // A list, a record and a map held by two names and given to a function that changes them (§3.4): changed
        // in place by the library and through a let, a parameter and a loop's item, then read through each name.
        const l = fresh("shared"), also = fresh("shared"), apart = fresh("shared"), rec = fresh("shared"), recs = fresh("shared"), m = fresh("shared");
        const out = [`${i}${r.pick(["let", "var"])} ${l}: list<number> = [${num(sc, 1)}, ${num(sc, 1)}]`, `${i}let ${also} = ${l}`, `${i}let ${apart} = copy(${l})`];
        out.push(`${i}let ${rec} = new item { label: ${text(sc, 1)}, amount: ${num(sc, 1)} }`, `${i}let ${recs} = [${rec}, new item { amount: ${num(sc, 1)} }]`, `${i}let ${m} = {"a": ${num(sc, 1)}}`);
        for (let k = r.int(2, 6); k > 0; k--) {
          out.push(i + r.pick([
            () => `append(${r.pick([l, also, apart])}, ${num(sc, 1)})`,
            () => `insert(${r.pick([l, also])}, ${r.int(0, 3)}, ${num(sc, 1)})`,
            () => `print(remove_at(${r.pick([l, also])}, ${r.int(0, 2)}))`,
            () => `${r.pick([l, also])} += [${num(sc, 1)}]`,
            () => `${also}[${r.int(0, 2)}] = ${num(sc, 1)}`,
            () => `change(${r.pick([l, also, apart])}, ${r.pick([rec, `${recs}[${r.int(0, 1)}]`])}, ${m})`,
            () => `for x in ${recs} { x.amount = ${num(sc, 1)} }`,
            () => `${rec}.label = ${text(sc, 1)}`,
            () => `${m}["${r.pick(["a", "b"])}"] = ${num(sc, 1)}`,
            () => `remove(${m}, "${r.pick(["a", "b", "k"])}")`,
            () => `clear(${r.pick([l, apart, m])})`,
            () => `for x in ${l} { append(${also}, x) }`,
          ])());
        }
        out.push(`${i}print(${l} == ${also})`, `${i}print(${apart})`, `${i}print(${recs})`, `${i}print(${m})`);
        return out;
      }
      case "loopfill":
        return [`${i}fill "${ctx.inLoop.box}_{${ctx.inLoop.counter}}_${++counter}" = ${expr(sc, r.pick([N, T]), d)}`];
      case "ask": {
        const type = r.pick(["string", "number", "bool", "date", "one_of", "any_of", "long_text", "phone", "email"]);
        const name = fresh("q");
        const t = { string: T, long_text: T, phone: { t: "phone" }, email: { t: "email" }, number: N, bool: B, date: D, one_of: O, any_of: S }[type];
        const what = type === "one_of" || type === "any_of" ? `${type} colour` : type;
        let line = `${i}ask ${name}: ${what} "${r.pick(["Name", "How many", "When", "Which"])} {${r.int(1, 9)}}?"`;
        if (r.chance(0.3) && ["string", "number", "date", "bool"].includes(type)) line += ` default ${expr(sc, t, 1)}`;
        const n = declare(sc, name, t, "answer");
        const out = [line];
        if (r.chance(0.3) && (type === "number" || type === "string")) out.push(`${i}  check ${name} == null or ${type === "number" ? `${name} > 0` : `length(${name}) < 20`} "Too ${type === "number" ? "small" : "long"}."`);
        // Into a box the way its type goes: a bool ticks one, a set's options are joined (§10).
        if (r.chance(0.5)) out.push(type === "bool" ? `${i}tick "${box("A")}" when ${use(n)}` : `${i}fill "${box("A")}" = ${type === "any_of" ? `join(${use(n)} ?? [])` : use(n)}`);
        return out;
      }
      case "let": {
        const type = r.pick([N, T, B, D, LN, LT]);
        const name = fresh("v");
        const line = `${i}let ${name}${type.t === "list" ? `: ${typeWords(type)}` : ""} = ${expr(sc, type, d)}`;
        declare(sc, name, type, "let");
        return [line];
      }
      case "var": {
        const type = r.pick([N, T, B, LN]);
        const name = fresh("m");
        const line = `${i}var ${name}: ${typeWords(type)} = ${expr(sc, type, d)}`;
        declare(sc, name, type, "var");
        return [line];
      }
      case "assign": {
        const v = r.pick(all(sc).filter((n) => n.kind === "var"));
        if (v.type.t === "record") return [`${i}${v.name}.label = ${text(sc, d)}`];
        if (v.type.t === "list") {
          // Known positions from 0 (one below is S360); a position past the count may fault as the program runs.
          const answers = all(sc).filter((n) => n.kind === "answer" && n.type.t === "number");
          const at = answers.length && r.chance(0.3) ? `whole(either(${use(r.pick(answers))}, 0))` : r.pick([0, 0, 1, 2]);
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
        const from = r.int(0, 2), to = r.int(0, 3), before = r.chance(0.5);
        const out = [`${i}for ${c} in ${from}${before ? "..<" : ".."}${to} {`, `${i}  fill "${loop.box}_{${c}}" = ${c}`];
        for (let k = from; before ? k < to : k <= to; k++) boxes.push(`${loop.box}_${k}`);
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
        const out = [`${i}for ${x} in ${use(l)} {`, `${i}  print(${x})`];
        inner.names[0].read = true;
        out.push(`${i}  print(${expr(inner, r.pick([N, T, B]), d)})`);
        out.push(`${i}}`);
        return out;
      }
      case "collect": {
        const name = fresh("people");
        const x = fresh("p");
        const extra = r.chance(0.5) ? [`${i}  ask ${x}_note: string "Note"`, `${i}  print(${x}_note)`] : [];
        const out = [`${i}var ${name}: list<string>`, `${i}collect ${x} in ${name}${r.chance(0.5) ? ` any "Any {${r.int(1, 3)}}?"` : ""} "Another?" {`, `${i}  ask ${x}: string "Who"`, ...extra, `${i}}`];
        declare(sc, name, LT, "collected");
        return out;
      }
      case "record": {
        const name = fresh("it");
        const out = [`${i}var ${name}: item = new item { label: ${text(sc, d)}, amount: ${num(sc, d)} }`];
        const n = declare(sc, name, R, "var");
        if (r.chance(0.5)) out.push(`${i}ask ${name}.done: bool "Done?"`);
        else out.push(`${i}${name}.done = ${bool(sc, d)}`);
        if (r.chance(0.5)) out.push(`${i}${name}.amount = ${num(sc, d)}`);
        if (r.chance(0.5)) out.push(`${i}${name}.tags[${r.int(0, 1)}] = ${text(sc, d)}`, `${i}print(${name}.tags)`);
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
  lines.push(`enum colour {`, ...COLOURS.map((c) => `  "${c}" "${c[0].toUpperCase()}${c.slice(1)}"`), `}`);
  lines.push("record item {", "  label: string", "  amount: number", "  done: bool", "  tags: list<string>", "}", "");
  // Helpers every program has: a loop with bounds worked out as it runs, a generic function, list
  // parameters. (A function calling itself is S401.)
  lines.push(
    "function fact(n: number) -> number {",
    "  var p = 1",
    "  for i in 1..n {",
    "    p *= i",
    "  }",
    "  return p",
    "}",
    "function pick_one<t>(a: t, b: t) -> t {",
    "  if a == null {",
    "    return b",
    "  }",
    "  return a",
    "}",
    "function n_of(xs: list<number>) -> number {",
    "  return count([x * 2 for x in xs if x != 0])",
    "}",
    "function second(xs: list<number>) -> number {",
    "  if count(xs) < 2 {",
    "    return null",
    "  }",
    "  return xs[1]",
    "}",
    "function doubled(xs: list<number>) -> list<number> {",
    "  var out: list<number>",
    "  for k, x in xs {",
    "    out[k] = x * 2",
    "  }",
    "  return out",
    "}",
    "",
  );
  // One that changes the list, the record and the map it is given (§3.4).
  lines.push("function change(l: list<number>, it: item, m: map<string, number>) {", "  append(l, count(l))", "  l[0] = 0", "  it.amount = count(l)", "  it.done = true", '  m["k"] = count(m)', "}", "");
  // Pure functions of numbers and words, and one that asks.
  for (let k = 0; k < r.int(1, 3); k++) {
    const name = fresh("f");
    const params = Array.from({ length: r.int(1, 3) }, () => r.pick([N, T, B]));
    const result = r.pick(["number", "string"]);
    const f = { name, params, result, asks: false, ready: false };
    const sc = scope();
    const ps = params.map((p, j) => declare(sc, `a${j}`, p, "param"));
    const body = [];
    if (r.chance(0.5)) {
      // A condition on a parameter: one written out would leave the last return unreachable (S406).
      body.push(`  if (string_of(${use(ps[0])}) == "1") or ${bool(sc, 2)} {`, `    return ${expr(sc, result === "number" ? N : T, 2)}`, `  }`);
    }
    body.push(`  return ${expr(sc, result === "number" ? N : T, 2)}`);
    // A parameter not read is no mistake; a function not called is only a warning.
    lines.push(`function ${name}(${ps.map((p) => `${p.name}: ${typeWords(p.type)}`).join(", ")}) -> ${result} {`, ...body, "}", "");
    f.ready = true;
    functions.push(f);
  }
  {
    const name = fresh("g");
    const sc = scope();
    const p = declare(sc, "n", N, "param");
    lines.push(`function ${name}(n: number) -> number {`, `  ask k: number "Value {n}"`, `  return either(k, 0) + ${use(p)}`, "}", "");
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
    case "bool":
      return r.pick(["yes", "no", true, false, "maybe"]);
    case "one_of":
      return r.pick([...COLOURS, "purple"]);
    case "any_of":
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
      const p = load(build.bytecode);
      const x = run(p, answers, { today });
      results.vm = { steps: x.steps, boxes: boxValues(p, x.writes), prints: x.prints, fault: x.fault };
      // A fault that is the compiler's or the machine's own (never a program's) is a bug.
      if (["F006", "F018", "F019"].includes(x.fault?.code)) return { seed, outcome: "bug", problem: `the machine stopped with ${x.fault.code}: ${x.fault.message}`, source, answers: { ...answers } };
    } catch (e) {
      return { seed, outcome: "bug", problem: `an engine crashed: ${e.stack}`, source, answers };
    }
    // A run the reference exhausts is passed over (§19.1.2).
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
  const counts = { agreed: 0, exhausted: 0, bug: 0 };
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
