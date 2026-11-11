// Phase 4: check types. Every expression gets its type (`.type`) and every statement is checked against what
// it may do:
//
//   - an operator gets operands it works on: + adds numbers or joins words, < compares numbers or dates, and/or
//     take bools, `in` asks a set of options or a list;
//   - an option is compared only with one of its own values ("sign" in acts, kind == "individual");
//   - a call has as many arguments as its function has parameters, each of the parameter's type;
//   - a box is filled with words, a number, a date or an option; ticked or picked on a bool;
//   - an answer is never given another value, nor a let, a constant, a parameter or a counter;
//   - a function gives a value of its declared type, and one with no result gives none;
//   - a list is collected once, into a var, and holds records or plain values.
//
// What depends on the order things happen in (a name read before it can have a value) is the flow check's
// (flow.mjs).
import * as V from "../runtime/values.mjs";
import { KIND, didYouMean, either } from "./source.mjs";
import { NATIVES } from "../runtime/natives.mjs";
import * as T from "./types.mjs";
import { evaluate, knownPlaced } from "./constant.mjs";
import * as D from "../runtime/decimal.mjs";
import { what } from "./resolve.mjs";

export function check(resolved, diagnostics) {
  const err = (code, node, message, notes) => diagnostics.add(KIND.TYPE, node?.file ?? null, node?.span ?? null, message, notes, code);
  const collected = new Map(); // list symbol -> the collect statement that fills it
  const askedFields = new Map(); // `${sym.id}.${field}` -> the ask that answers that field of that var
  // An asked field of the var at `path` or inside it ("" for the whole var): { path, ask }, or null.
  const askedUnder = (sym, path) => {
    const head = `${sym.id}.`;
    for (const [k, ask] of askedFields) {
      if (!k.startsWith(head)) continue;
      const p = k.slice(head.length);
      if (path === "" || p === path || p.startsWith(`${path}.`)) return { path: p, ask };
    }
    return null;
  };

  // The standard library's functions that `sorted`, `any` and `all` are when given a function (§14.4.3): each is
  // shown by the name it is called by.
  const stdNames = resolved.units.find((r) => r.unit.std)?.scope.names;
  const GIVEN_A_FUNCTION = { sorted_by_key: "sorted", sorted_by_compare: "sorted", any_where: "any", all_where: "all" };
  const givenAFunction = {};
  for (const [declared, shown] of Object.entries(GIVEN_A_FUNCTION)) {
    const sym = stdNames?.get(declared);
    if (sym?.kind !== "function") continue;
    givenAFunction[declared] = sym;
    sym.name = shown;
  }

  // ----- declarations

  for (const r of resolved.units) {
    for (const sym of r.natives) {
      if (!NATIVES[sym.name]) err("S301", sym.node, `the machine has no native called ${sym.name} (runtime/natives.mjs)${didYouMean(sym.name, Object.keys(NATIVES))}`);
      else if (NATIVES[sym.name].fn.length !== sym.params.length) err("S302", sym.node, `the native ${sym.name} takes ${NATIVES[sym.name].fn.length} values in the machine, and is declared with ${sym.params.length}`);
    }
    for (const sym of r.natives) checkDefaults(sym);
    for (const sym of r.consts) constType(sym);
  }
  // A record's field with a default (§5.1.1): of the field's type, and worked out by the compiler.
  const fieldDefaults = () => {
    for (const r of resolved.units) {
      for (const rec of r.records) {
        for (const f of rec.decl.fields) {
          const d = f.node.default;
          if (!d) continue;
          const t = expr(d, { fn: null, unit: r.unit }, { want: f.type });
          if (!fitsAt(d, t, f.type)) {
            err("S762", d, `${rec.name}'s ${f.name} is ${T.describe(f.type)}, and its default is ${T.describe(t)}`);
            continue;
          }
          optionLiteral(d, f.type);
          if (T.isError(t)) continue;
          const v = evaluate(d);
          if (v === undefined) (f.hasDefault = true), (f.defaultExpr = d); // worked out at each `new` that leaves it out
          else if (false) err("S763", d, `a field's default is worked out by the compiler, from words, numbers and constants${faultIn(d) ? `; this one faults: ${faultIn(d).knownFault.message}` : `; ${rec.name}'s ${f.name} depends on something that is not`}`);
          else {
            f.hasDefault = true;
            f.defaultValue = knownPlaced(d, f.type);
          }
        }
      }
    }
  };

  // The operation inside an expression whose working out faulted, when one did (constant.mjs marks it).
  function faultIn(e) {
    if (!e || typeof e !== "object") return null;
    if (e.knownFault) return e;
    for (const x of [e.a, e.b, e.operand, e.target, e.index, e.condition, e.yes, e.no, e.from, e.to, ...(e.args ?? []), ...(e.items ?? []), ...(e.parts ?? []).filter((p) => typeof p !== "string")]) {
      const f = faultIn(x);
      if (f) return f;
    }
    return null;
  }

  function constType(sym) {
    if (sym.type) return sym.type;
    if (sym.checking) {
      err("S303", sym.node, `the constant ${sym.name} is made of itself`);
      return (sym.type = T.ERROR);
    }
    sym.checking = true;
    const type = expr(sym.node.value, { fn: null });
    sym.checking = false;
    // Made of itself: S303 says so, and nothing more is said of it.
    if (sym.type && T.isError(sym.type)) return sym.type;
    const value = evaluate(sym.node.value);
    if (T.isError(type)) {
      // Made of a constant already reported (S303): nothing more to say.
    } else if (value === undefined && outOfRange(sym.node.value)) err("S009", sym.node.value, `the constant ${sym.name} is 10^34 or more; numbers stay below 10^34`);
    else if (value === undefined && faultIn(sym.node.value)) {
      // Made of known values, and its working out faults: a fault certain before the form opens (§11.3.1), which the
      // flow phase reports (§11.3.5).
      sym.fault = faultIn(sym.node.value);
    } else if (value === undefined) err("S304", sym.node.value, `a constant's value is worked out by the compiler, from words, numbers and other constants; ${sym.name} depends on something that is not`);
    else {
      sym.value = value;
      sym.known = true;
    }
    if (sym.declaredType && !fitsAt(sym.node.value, type, sym.declaredType)) err("S305", sym.node.value, `${sym.name} is declared ${T.describe(sym.declaredType)}, and its value is ${T.describe(type)}`);
    else if (sym.declaredType) optionLiteral(sym.node.value, sym.declaredType);
    sym.type = sym.declaredType ?? type;
    if (["record"].includes(sym.type.t)) err("S306", sym.node, `a constant is words, a number, a date, true or false, a set, or a list of them; ${sym.name} is ${T.describe(sym.type)}`);
    return sym.type;
  }

  // Whether a constant's number expression, worked out exactly (§3.3), reaches 10^34 (S009, §11.3.5).
  function outOfRange(e) {
    const value = (x) => {
      if (x.kind === "number") return D.fromWords(String(x.raw ?? x.value));
      if (x.kind === "unary" && x.op === "-") return D.neg(value(x.operand));
      if (x.kind === "name" && x.symbol?.kind === "const") return value(x.symbol.node.value);
      if (x.kind === "binary" && ["+", "-", "*", "/"].includes(x.op)) {
        const a = value(x.a), b = value(x.b);
        return { "+": D.add, "-": D.sub, "*": D.mul, "/": D.div }[x.op](a, b);
      }
      throw new Error("not a number expression");
    };
    try {
      value(e);
      return false;
    } catch (err) {
      return err instanceof D.NumberFault && err.code === "F003";
    }
  }

  // A label on a record's declaration (§16.2): its first line, where its name stands.
  function declaredHere(decl) {
    const n = decl.node;
    if (!n?.span) return [];
    // The label underlines the record's name where it is declared (§16.2).
    const at = n.file.line(n.span.line).indexOf(`record ${decl.name}`);
    const col = at < 0 ? n.span.col : at + 1 + "record ".length;
    return [{ file: n.file, span: { ...n.span, col, endLine: n.span.line, endCol: col + [...decl.name].length }, message: `${decl.name} is declared here` }];
  }

  // ----- bodies

  fieldDefaults();
  for (const r of resolved.units) {
    // The program first: a function it calls is checked at the call, and may read the names defined before it.
    if (!r.unit.library) block(r.main, { fn: null, unit: r.unit, main: true });
    for (const sym of r.functions) checkFunction(sym, r.unit);
  }

  // A type no value tells: the bare null, or a list of such at any depth (§6.11, S328, S344).
  function untold(t) {
    return t?.t === "null" || ((t?.t === "list" || t?.t === "set") && untold(t.element));
  }

  // A function's body, once; a function whose result is worked out from its returns is checked before the first
  // call that needs its result (no function reaches itself, so this ends; the flow check reports one that does).
  function checkFunction(sym, unit = sym.unit) {
    if (sym.checked || sym.checking) return;
    sym.checking = true;
    // A short function nothing gave types to (§9.12): S760 where it stands says so.
    for (const p of sym.params) if (!p.type) p.type = T.ERROR;
    checkDefaults(sym);
    const ctx = { fn: sym, unit, returns: [] };
    block(sym.node.body, ctx);
    if (sym.inferResult) {
      let result = T.NONE;
      for (const { type, node } of ctx.returns) {
        if (T.isError(type) || type.t === "none") continue;
        if (result.t === "none" || result.t === "null") result = type;
        else if (T.fits(type, result)) continue;
        else if (T.fits(result, type)) result = type;
        else err("S343", node, `${sym.name} gives ${T.describe(result)} on one path and ${T.describe(type)} here; one function gives one type (or write it: -> type)`);
      }
      if (untold(result)) {
        err("S344", sym.node, `${sym.name} returns only null, so its type cannot be worked out; write it: -> string`);
        result = T.ERROR;
      }
      sym.result = result;
      sym.type = { t: "function", params: sym.params.map((p) => p.type), result };
    }
    sym.checking = false;
    sym.checked = true;
  }

  // Parameters with defaults come last; each default is worked out by the compiler and is of its parameter's type
  // (§9.2).
  function checkDefaults(sym) {
    let optional = false;
    for (const p of sym.params ?? []) {
      const d = p.node.default;
      if (!d) {
        if (optional) err("S392", p.node, `${p.name} has no default, and comes after a parameter with one; defaults come last`);
        continue;
      }
      optional = true;
      const t = expr(d, { fn: null, defaultOf: sym });
      // A default for a parameter of a type parameter is one more candidate at each call that leaves it out
      // (§9.5.1), checked there; any other default fits its parameter here.
      if (!T.hasTypevar(p.type) && !fitsAt(d, t, p.type)) err("S367", d, `${p.name} is ${T.describe(p.type)}, and its default is ${T.describe(t)}`);
      const v = evaluate(d);
      // Made of known values, and its working out faults: S413 at the operation, in the flow phase (§11.3.3, §11.3.5).
      if (v === undefined && faultIn(d)) p.fault = faultIn(d);
      else if (v === undefined) p.defaultExpr = d; // worked out at each call that leaves it out (§9.2)
      else {
        // Placed as the parameter's type, as an argument is (§9.2): words for a set become the set.
        p.defaultValue = T.hasTypevar(p.type) ? v : knownPlaced(d, p.type);
      }
    }
  }

  function block(statements, ctx) {
    for (const s of statements) statement(s, ctx);
  }

  function statement(s, ctx) {
    switch (s.kind) {
      case "ask":
        return ask(s, ctx);
      case "let":
      case "var":
        return binding(s, ctx);
      case "fill": {
        text(s.box, ctx, "a box's name");
        const type = expr(s.value, ctx);
        if (!T.fillable(type)) {
          if (type.t === "bool") err("S307", s.value, `fill writes words or a number; a bool goes into a check box with tick "box" when …`);
          else if (type.t === "options") err("S308", s.value, `${describeExpr(s.value)} holds several options; fill one box with join(${describeExpr(s.value)}, ", "), or tick a box for each option`);
          else if (type.t === "none") {
            // A call to a function with no result has said so already.
          }
          else err("S309", s.value, `fill writes words, a number, a date or an option into a box, not ${T.describe(type)}`);
        }
        return;
      }
      case "tick":
        text(s.box, ctx, "a box's name");
        return condition(s.condition, ctx, "tick … when");
      case "pick":
        text(s.box, ctx, "a box's name");
        text(s.button, ctx, "a button's name");
        return condition(s.condition, ctx, "pick … when");
      case "if":
        condition(s.condition, ctx, "if");
        block(s.then, ctx);
        return block(s.otherwise, ctx);
      case "match":
        return match(s, ctx);
      case "try":
        block(s.then, ctx);
        block(s.otherwise, ctx);
        return block(s.final ?? [], ctx);
      case "throw": {
        // What is thrown is an error, or the words of one (§7.19).
        const t = expr(s.value, ctx);
        if (!T.isStringLike(t) && !["caught", "option", "null", "error"].includes(t.t)) err("S720", s.value, `throw raises an error or the words of one, and this is ${T.describe(t)}; error(message, code: "…") makes an error`);
        return;
      }
      case "while":
        condition(s.condition, ctx, "while");
        return block(s.body, ctx);
      case "for": {
        const a = expr(s.from, ctx), b = expr(s.to, ctx);
        // Null fits a number (§3.6): a null bound is F023 when it runs (§7.11), S413 when known.
        for (const [e, t] of [[s.from, a], [s.to, b]]) if (t.t !== "number" && t.t !== "null" && !T.isError(t)) err("S313", e, `a for loop counts numbers; this is ${T.describe(t)}`);
        return block(s.body, ctx);
      }
      case "for-each": {
        const type = expr(s.list, ctx);
        if (type.t === "list") {
          s.itemSymbol.type = type.element;
          // The items of a collected list are answers (§8.5), through a loop's name for them too.
          if (s.list.kind === "name" && s.list.symbol?.collectedBy) s.itemSymbol.ofCollected = true;
        } else if (T.isStringLike(type)) s.itemSymbol.type = T.STRING; // each character
        else if (type.t === "map") {
          // A map's keys, in their order; with two names, each key and the value under it (§7.11).
          if (s.indexSymbol) (s.indexSymbol.type = type.key), (s.itemSymbol.type = type.value);
          else s.itemSymbol.type = type.key;
        } else if (type.t === "options") s.itemSymbol.type = T.option(type.set);
        else if (type.t === "range") s.itemSymbol.type = T.NUMBER; // each of its numbers (§6.17)
        else if (type.t === "set") s.itemSymbol.type = type.element; // in the order first added (§3.12)
        else if (type.t === "null") s.itemSymbol.type = T.NULL; // null fits a list (§3.6); F023 when it runs
        else {
          if (!T.isError(type)) err("S314", s.list, `for … in goes through a list, a map, a set of options or a range a..b; ${describeExpr(s.list)} is ${T.describe(type)}`);
          s.itemSymbol.type = T.ERROR;
        }
        // for (a, b) in l (§7.11.2): each item a tuple of as many values as there are names.
        const it = s.itemSymbol.type;
        if (s.destructure && !T.isError(it) && (it.t !== "tuple" || it.elements.length !== s.destructure.length)) {
          err("S741", s.list, it.t === "tuple" ? `each item is a tuple of ${it.elements.length} values, and ${s.destructure.length} names take them` : `for (a, b) in … takes each item's values apart, and the items are ${T.describe(it)}`);
          s.itemSymbol.type = T.ERROR;
        }
        return block(s.body, ctx);
      }
      case "collect":
        return collect(s, ctx);
      case "return":
        return ret(s, ctx);
      case "break":
      case "continue":
        return;
      case "expect":
        if (s.fault) {
          expr(s.value, ctx, { statement: true });
          return text(s.fault, ctx, "the fault expected");
        }
        condition(s.value, ctx, "expect");
        if (s.message) text(s.message, ctx, "an expectation's words");
        return;
      case "assign":
        return assign(s, ctx);
      case "call-statement":
        if (s.call.kind === "call") expr(s.call, ctx, { statement: true });
        return;
      default:
        throw new Error(`unknown statement ${s.kind}`);
    }
  }

  function ask(s, ctx) {
    const form = s.question.form;
    const answer = form === "one_of" || form === "any_of" ? (s.set ? T.typeOfAnswer(form, s.set) : T.ERROR) : T.typeOfAnswer(form);
    s.answerType = answer;
    text(s.printed, ctx, "a question's printed words");
    if (s.set?.anonymous) for (const o of s.set.options) text(o.printed, ctx, "an option's printed words");
    const target = s.target;
    if (target.names.length === 1) {
      const sym = target.symbol;
      if (sym?.kind === "answer") {
        // The same answer asked in another branch must be of the same type.
        if (sym.type && !T.isError(sym.type) && !T.same(sym.type, answer)) err("S315", s.question, `${sym.name} is asked as ${T.describe(sym.type)} on line ${sym.line}; in another branch it must be the same`);
        else sym.type = answer;
      }
      else if (sym?.kind === "item") {
        if (!T.fits(answer, sym.type ?? T.ERROR)) err("S316", target, `the items of ${sym.node.list} are ${T.describe(sym.type)}, and this question's answer is ${T.describe(answer)}`);
      }
    } else if (target.symbol) {
      const base = target.symbol;
      let type = base.type ?? T.ERROR;
      let field = null;
      for (const name of target.names.slice(1)) {
        if (T.isError(type)) break;
        if (type.t !== "record") {
          err("S317", target, `${target.names.slice(0, target.names.indexOf(name)).join(".")} is ${T.describe(type)}, which has no fields`);
          type = T.ERROR;
          break;
        }
        field = type.decl.fields.find((f) => f.name === name);
        if (!field) {
          err("S318", target, `the record ${type.decl.name} has no field ${name}${didYouMean(name, type.decl.fields.map((f) => f.name))}`).label = `no field ${name}`;
          type = T.ERROR;
          break;
        }
        type = field.type;
      }
      if (!["item", "var"].includes(base.kind)) err("S319", target, `an answer goes into a new name, a var's field or a collect's item; ${base.name} is ${what(base)}`);
      else if (!T.isError(type) && !T.fits(answer, type)) err("S320", target, `${target.names.join(".")} is ${T.describe(type)}, and this question's answer is ${T.describe(answer)}`);
      const key = `${base.id}.${target.names.slice(1).join(".")}`;
      if (askedFields.has(key) && base.kind === "var") {
        const first = askedFields.get(key);
        err("S321", target, `${target.names.join(".")} is asked twice (first on line ${first.span.line})`);
      }
      askedFields.set(key, s);
      s.fieldPath = target.names.slice(1);
    }
    for (const m of s.modifiers) {
      if (m.kind === "default") {
        const t = expr(m.value, ctx);
        if (!fitsAt(m.value, t, answer)) err("S322", m.value, `the default is ${T.describe(t)}, and the answer is ${T.describe(answer)}`);
        else optionLiteral(m.value, answer);
      } else {
        condition(m.condition, ctx, "check");
        text(m.message, ctx, "a check's message");
      }
    }
    // At the second default, the first as related code (§16.2.1).
    const defaults = s.modifiers.filter((m) => m.kind === "default");
    if (defaults.length > 1) err("S323", defaults[1], "a question has one default", [{ file: defaults[0].file, span: defaults[0].span, message: "the first default" }]);
  }

  function binding(s, ctx) {
    const sym = s.symbol;
    let type = s.value ? expr(s.value, ctx, { allowNone: true, want: s.declaredType }) : null;
    if (type?.t === "none") {
      err("S324", s.value, `${describeExpr(s.value)} gives no value to keep`);
      type = T.ERROR;
    }
    // (a, b) = e (§7.3.1, §7.5.2): e a tuple of as many values as there are names.
    if (s.destructure && type && !T.isError(type)) {
      const n = (s.destructure.names ?? s.destructure.targets).length;
      if (type.t !== "tuple" || type.elements.length !== n) {
        err("S741", s.value, type.t === "tuple" ? `this tuple holds ${type.elements.length} values, and ${n} names take them` : `(a, b) = … takes a tuple's values apart, and this is ${T.describe(type)}`);
        type = T.ERROR;
      }
    }
    if (s.declaredType) {
      if (type && !fitsAt(s.value, type, s.declaredType)) err("S325", s.value, `${s.name} is ${T.describe(s.declaredType)}, and this is ${T.describe(type)}`);
      else if (type) optionLiteral(s.value, s.declaredType);
      type = s.declaredType;
    } else if (!type) {
      err("S326", s, `var ${s.name} needs a type or a value: var ${s.name}: string, or var ${s.name} = …`);
      type = T.ERROR;
    } else if (type.t === "null") {
      err("S327", s.value, `${s.name} = null says nothing about what ${s.name} holds; give it a type: ${s.kind} ${s.name}: string = null`);
      type = T.ERROR;
    } else if (type.t === "list" && untold(type.element)) {
      // `[]`, `[[]]`, `[[null]]`: no item says what the list holds, at any depth (§6.11, §7.4).
      err("S328", s.value, `an empty list says nothing about what it holds; give ${s.name} a type: ${s.kind} ${s.name}: list<string>`);
      type = T.ERROR;
    } else if (type.t === "set" && untold(type.element)) {
      err("S328", s.value, `an empty set says nothing about what it holds; give ${s.name} a type: ${s.kind} ${s.name}: set<string>`);
      type = T.ERROR;
    }
    // One let or var declared in two arms has one type (§12.4, S315).
    if (sym && s.sameAs && sym.type && !T.isError(sym.type) && !T.isError(type) && !T.same(sym.type, type)) err("S315", s, `${s.name} is ${T.describe(sym.type)} where it is declared on line ${sym.line}; declared again in another branch, it must be the same`);
    else if (sym) sym.type = type;
  }

  function match(s, ctx) {
    matchArms(s, ctx, (arm) => block(arm.body, ctx));
  }

  // A match's subject and its arms' values (§7.10), for the statement and the expression (§6.18); `each` is given
  // every arm after its values. Gives the subject's type.
  function matchArms(s, ctx, each) {
    const type = expr(s.subject, ctx);
    const seen = new Map();
    const known = []; // the values of the arms written as expressions, as the compiler works them out
    s.arms.forEach((arm, i) => {
      if (!arm.values) {
        if (i !== s.arms.length - 1) err("S330", arm, "else comes last in a match");
      } else {
        for (const v of arm.values) {
          if (v.kind !== "plain-string" && v.kind !== "number") {
            // An expression of the subject's type, worked out by the compiler.
            const t = expr(v, ctx);
            if (T.isError(t) || T.isError(type)) continue;
            if (!T.comparable(type, t)) {
              err("S329", v, `${describeExpr(s.subject)} is ${T.describe(type)}, and this arm's value is ${T.describe(t)}`);
              continue;
            }
            const k = evaluate(v);
            if (k === undefined) {
              err("S744", v, "an arm's value is one the compiler works out: a value written out, a constant, or made of these");
              continue;
            }
            v.known = k;
            const first = known.find((x) => V.equal(x.k, k));
            if (first) err("S331", v, `${V.printed(k)} is in this match twice`, [{ file: v.file, span: first.v.span, message: "first here" }]);
            else known.push({ k, v });
            continue;
          }
          v.known = v.value;
          // A value of the subject's kind: a number for a number, words for words or an option.
          const numeric = v.kind === "number";
          const shown = numeric ? V.words(v.value) : `"${v.value}"`;
          if (!T.isError(type) && numeric !== (type.t === "number")) {
            err("S329", v, `${describeExpr(s.subject)} is ${T.describe(type)}, and ${shown} is ${numeric ? "a number" : "words"}`);
            continue;
          }
          const key = numeric ? `#${shown}` : v.value;
          const first = seen.get(key) ?? known.find((x) => V.equal(x.k, v.value))?.v;
          if (first) err("S331", v, `${shown} is in this match twice`, [{ file: v.file, span: first.span, message: "first here" }]);
          seen.set(key, v);
          known.push({ k: v.value, v });
          if (type.t === "option" && !type.set.options.some((o) => o.value === v.value)) err("S332", v, `${describeExpr(s.subject)} is never "${v.value}": it is ${either(type.set.options.map((o) => `"${o.value}"`))}`);
        }
      }
      each(arm);
    });
    if (type.t === "option" && !s.arms.some((a) => !a.values)) {
      const missing = type.set.options.filter((o) => !seen.has(o.value)).map((o) => `"${o.value}"`);
      s.missing = missing;
    }
    return type;
  }

  function collect(s, ctx) {
    const list = s.listSymbol;
    text(s.another, ctx, "the question that asks for another");
    if (s.any) text(s.any, ctx, "the question that asks whether there are any");
    let element = T.ERROR;
    if (list) {
      const type = list.type ?? T.ERROR;
      if (list.kind !== "var") err("S333", s, `collect fills a var declared as a list; ${list.name} is ${what(list)}`);
      else if (type.t !== "list") {
        if (!T.isError(type)) err("S334", s, `collect fills a list; ${list.name} is ${T.describe(type)}`);
      } else {
        element = type.element;
        if (["list", "options"].includes(element.t)) {
          err("S335", s, `a collected list holds records or plain values, not ${T.describe(element)}`);
          element = T.ERROR;
        }
        if (list.node.value && list.node.value.kind === "list" && list.node.value.items.length) err("S336", s, `${list.name} already has items; collect fills a list that starts empty`);
      }
      if (collected.has(list)) err("S337", s, `${list.name} is collected twice (first on line ${collected.get(list).span.line}); a list is collected once`);
      collected.set(list, s);
      list.collectedBy = s;
    }
    s.itemSymbol.type = element;
    block(s.body, ctx);
  }

  function ret(s, ctx) {
    if (!ctx.fn) {
      if (s.value) err("S338", s.value, "the program gives no value; a bare return ends it");
      return;
    }
    // A short function's one value (§9.12): a call that gives no value is the function's whole body.
    if (s.short && s.value?.kind === "call" && (ctx.fn.inferResult || ctx.fn.result.t === "none")) {
      const type = expr(s.value, ctx, { allowNone: true });
      if (type.t === "none" || !ctx.fn.inferResult) {
        s.kind = "call-statement";
        s.call = s.value;
        delete s.value;
      } else ctx.returns.push({ type, node: s.value });
      return;
    }
    if (ctx.fn.inferResult) {
      if (!s.value) err("S339", s, `${ctx.fn.name} gives a value on other paths; return needs one here too`);
      else ctx.returns.push({ type: expr(s.value, ctx), node: s.value });
      return;
    }
    const result = ctx.fn.result;
    if (!s.value) {
      if (result.t !== "none") err("S340", s, `${ctx.fn.name} gives ${T.describe(result)}; return needs a value`);
      return;
    }
    const type = expr(s.value, ctx, { want: result });
    if (result.t === "none") err("S342", s.value, `${ctx.fn.name} is declared with no result; add -> ${T.describe(type)} after its parameters, or return nothing`);
    else if (!fitsAt(s.value, type, result)) err("S342", s.value, `${ctx.fn.name} gives ${T.describe(result)}, and this is ${T.describe(type)}`);
    else optionLiteral(s.value, result);
  }

  function assign(s, ctx) {
    const valueType = s.op ? binary({ kind: "binary", op: s.op, a: s.target, b: s.value, span: s.span, opSpan: s.opSpan, compound: true, file: s.file }, ctx) : expr(s.value, ctx, { allowNone: true, want: s.target.kind === "name" ? s.target.symbol?.type : null });
    const target = s.target;
    let wanted = T.ERROR;
    // A function reads the program's names, and does not change them (§9.1).
    // A function may change the program's var (§9.1): what it holds is then the run's business.
    if (ctx.fn && rootOf(target)?.symbol?.program) rootOf(target).symbol.changedInFunction = true;
    if (target.kind === "name") {
      const sym = target.symbol;
      if (!sym) return;
      // `l += m` adds to the list the name holds (§6.5.1); the name keeps the list it has, so it need not be a var.
      s.inPlace = s.op === "+" && valueType.t === "list" && sym.type?.t === "list";
      if (sym.kind !== "var" && !(s.inPlace && ["let", "param", "item"].includes(sym.kind) && !collectedItem(sym))) {
        const why = {
          answer: `${sym.name} is the person's answer; a program cannot change it`,
          let: `${sym.name} is a let, which keeps its first value; make it a var to give it another`,
          const: `${sym.name} is a constant`,
          param: `${sym.name} is a parameter; put it into a var to give that another value`,
          counter: `${sym.name} is the loop's counter`,
          item: `${sym.name} is an item of a list; give the list's item a value by its position`,
          index: `${sym.name} is an item's number`,
        }[(sym.kept ?? sym).kind] ?? `${sym.name} is ${what(sym)} and cannot be given a value`;
        err("S345", target, why);
        return;
      }
      if (sym.collectedBy) err("S346", target, `${sym.name} is collected on line ${sym.collectedBy.span.line}; its items are answers, which a program cannot change`);
      // The whole var given a value would change an answer asked into one of its fields (§7.5).
      const under = s.inPlace ? null : askedUnder(sym, "");
      if (under) err("S348", target, `${sym.name}.${under.path} is asked on line ${under.ask.span.line}; giving ${sym.name} a value would change that answer`);
      wanted = sym.type ?? T.ERROR;
      expr(target, ctx);
    } else if (target.kind === "field" || target.kind === "index") {
      wanted = expr(target, ctx);
      s.inPlace = s.op === "+" && valueType.t === "list" && wanted.t === "list";
      const root = rootOf(target);
      const sym = root?.symbol;
      // A field or an item is changed through any name that holds the record, list or map (§7.5); a constant's
      // items never change, and an answer stays as the person gave it.
      if (target.kind === "field" && target.target.type?.t === "caught") err("S722", target, `an error's ${target.name} does not change; error(message, code: "…") makes another`);
      if (sym && collectedItem(sym)) err("S346", target, `${sym.name} is a collected item; its fields are answers`);
      else if (sym && !["var", "let", "param", "item"].includes(sym.kind)) err("S347", target, sym.kind === "const" ? `${sym.name} is a constant, and its items do not change; copy(${sym.name}) gives a list that can` : `${sym.name} is ${what(sym)}, which holds nothing that can be given a value`);
      if (target.kind === "index" && target.target.type?.t === "tuple") err("S742", target, `a tuple keeps the values it was made with; give ${describeExpr(target.target)} a new tuple`);
      if (target.kind === "index" && T.isStringLike(target.target.type ?? T.ERROR)) err("S349", target, `${describeExpr(target.target)} is words, whose characters cannot be given a value; a list's item or a map's key can`);
      if (sym && target.kind === "field") {
        const path = fieldPath(target);
        // The field itself asked, or a field inside it (§7.5): either answer would change.
        const under = path ? askedUnder(sym, path) : null;
        if (under) err("S348", target, `${sym.name}.${under.path} is asked on line ${under.ask.span.line}; an answer cannot be changed`);
      }
      if (sym?.collectedBy) err("S346", target, `${sym.name} is collected; its items are answers`);
    } else {
      err("S349", target, "only a var, a field or an item can be given a value");
      return;
    }
    if (valueType.t === "none") err("S350", s.value, `${describeExpr(s.value)} gives no value`);
    else if (!fitsAt(s.value, valueType, wanted)) err("S351", s.value, `${describeExpr(target)} is ${T.describe(wanted)}, and this is ${T.describe(valueType)}`);
    else optionLiteral(s.value, wanted);
  }

  // The item of a collect, or of a for over a collected list: an answer (§8.5).
  function collectedItem(sym) {
    const item = sym.kept ?? sym;
    return item.kind === "item" && !!(item.collected || item.ofCollected);
  }

  function rootOf(e) {
    return e.kind === "name" ? e : e.target ? rootOf(e.target) : null;
  }

  function fieldPath(e) {
    const names = [];
    for (let x = e; x.kind === "field"; x = x.target) names.unshift(x.name);
    return rootOf(e)?.kind === "name" ? names.join(".") : null;
  }

  // ----- expressions

  function condition(e, ctx, what) {
    const type = expr(e, ctx);
    // The bare `null` fits here as everywhere, and counts as false (§3.6, §6.15).
    if (type.t !== "bool" && type.t !== "null" && !T.isError(type)) {
      if (T.isStringLike(type) || type.t === "option") err("S310", e, `${what} needs true or false; ${describeExpr(e)} is ${T.describe(type)}: compare it (== "…") or test it (!= null)`);
      else err("S311", e, `${what} needs true or false, and this is ${T.describe(type)}`);
    }
  }

  function text(e, ctx, what) {
    const type = expr(e, ctx);
    if (!T.isStringLike(type) && !T.isError(type)) err(null, e, `${what} is words, not ${T.describe(type)}`);
  }

  // A literal compared with or given to an option must be one of its values.
  function optionLiteral(e, type) {
    if (type.t === "tuple" && e.kind === "tuple") return e.items.forEach((x, i) => type.elements[i] && optionLiteral(x, type.elements[i]));
    if (type.t !== "option" && type.t !== "options") return;
    const values = literalValues(e);
    for (const [node, v] of values) {
      if (!type.set.options.some((o) => o.value === v)) err("S386", node, `"${v}" is not one of ${type.set.anonymous ? "the options" : type.set.name}: ${either(type.set.options.map((o) => `"${o.value}"`))}`);
    }
  }

  // Whether the value of expression e (of type `type`) can stand where `wanted` is wanted: as types fit, or
  // words in quotes where an option is wanted (one of its values, checked by optionLiteral), or a list of them
  // where several options are.
  function fitsAt(e, type, wanted) {
    if (T.fits(type, wanted)) return true;
    if (wanted.t === "option" && T.isStringLike(type) && literalValues(e).length === 1 && e.kind === "string") return true;
    if (wanted.t === "options" && e.kind === "list" && e.items.every((x) => x.kind === "string" && literalValues(x).length === 1)) return true;
    // A tuple written out: each value where its place's type is wanted.
    if (wanted.t === "tuple" && e.kind === "tuple" && type.t === "tuple" && e.items.length === wanted.elements.length) return e.items.every((x, i) => (wanted.elements[i].t === "options" ? T.fits(type.elements[i], wanted.elements[i]) : fitsAt(x, type.elements[i], wanted.elements[i])));
    return false;
  }

  function literalValues(e) {
    if (e.kind === "string" && e.parts.length <= 1 && (e.parts.length === 0 || typeof e.parts[0] === "string")) return [[e, e.parts[0] ?? ""]];
    if (e.kind === "list") return e.items.flatMap(literalValues);
    return [];
  }

  // A short function whose parameters wait for their types (§9.12).
  function waits(e) {
    return e?.kind === "lambda" && e.symbol.params.some((p) => p.untyped);
  }

  // Gives a short function the types of the function type wanted where it stands (§9.12): its parameters' where
  // they are not written, and its result. A part of `want` that is null is not told here.
  function wantAt(e, want) {
    if (!e || !want) return;
    if (e.kind === "list" && want.t === "list") return e.items.forEach((x) => wantAt(x, want.element));
    if (e.kind === "cond") return (wantAt(e.yes, want), wantAt(e.no, want));
    if (e.kind !== "lambda" || !e.short || want.t !== "function") return;
    const sym = e.symbol;
    if (sym.checked || sym.checking) return;
    if (want.params.length !== sym.params.length) {
      e.wanted = want;
      return;
    }
    sym.params.forEach((p, i) => {
      if (!p.untyped || !want.params[i] || T.isError(want.params[i])) return;
      p.type = want.params[i];
      p.untyped = false;
    });
    if (!want.result || T.isError(want.result) || sym.params.some((p) => p.untyped)) return;
    // The result wanted is the function's: what it returns is placed as it (§9.4.2).
    if (want.result.t !== "none" || (e.valueBody && e.body[0].value?.kind === "call")) {
      sym.result = want.result;
      sym.inferResult = false;
    }
  }

  // `how.statement`: the call is a statement; `how.allowNone`: the context says itself what is wrong with a call that
  // gives no value (S324, S350, S366, S371). Anywhere else such a call is S370.
  function expr(e, ctx, how = {}) {
    if (how.want) wantAt(e, how.want);
    const type = typeOf(e, ctx, how);
    e.type = type;
    // S370 where no more particular code is named (§9.6): the value is then an error, so the context says no more.
    if (type.t === "none" && e.kind === "call" && !how.statement && !how.allowNone) {
      err("S370", e, `${describeExpr(e.target)} gives no value; call it on its own line`);
      return T.ERROR;
    }
    return type;
  }

  function typeOf(e, ctx, how) {
    switch (e.kind) {
      case "number":
        return T.NUMBER;
      case "bool":
        return T.BOOL;
      case "null":
        return T.NULL;
      case "plain-string":
        return T.STRING;
      case "string":
        for (const p of e.parts) {
          if (typeof p === "string") continue;
          const t = expr(p, ctx, { allowNone: true });
          if (["record", "list", "none"].includes(t.t)) err("S352", p, `{…} puts words, a number, a date or an option into words; this is ${T.describe(t)}`);
        }
        return T.STRING;
      case "lambda": {
        // A function written in place (§9.11): what it keeps has the type it has here.
        const sym = e.symbol;
        const untold = sym.params.filter((p) => p.untyped);
        if (untold.length) {
          if (e.wanted) err("S761", e, `this function takes ${sym.params.length} ${sym.params.length === 1 ? "value" : "values"}, and the function wanted here takes ${e.wanted.params.length}`);
          else err("S760", e, `nothing here tells the type of ${either(untold.map((p) => p.name)).replace(/ or /, " and ")}; write ${untold.length === 1 ? "it" : "them"}: (${sym.params.map((p) => `${p.name}: ${p.untyped ? "number" : T.describe(p.type)}`).join(", ")}) => …`);
          for (const p of untold) (p.type = T.ERROR), (p.untyped = false);
        }
        for (const k of e.keeps) {
          const t = expr(k, ctx);
          const kept = sym.keeps.find((x) => x.kept === k.symbol && !x.type);
          if (kept) kept.type = t;
        }
        checkFunction(sym);
        if (untold.length) return T.ERROR;
        if (!sym.result) {
          err("S353", e, "the function's result cannot be worked out here; write it: -> type");
          return T.ERROR;
        }
        e.functionValue = sym;
        return T.fn(sym.params.map((p) => p.type), sym.result);
      }
      case "name": {
        const sym = e.symbol;
        if (!sym) return T.ERROR;
        if (sym.kind === "const") return constType(sym);
        // One of the standard library's, when its types are plain ones (§9.10): upper, round, year.
        if (sym.kind === "native") {
          const plain = (t) => t && !["any", "element", "error", "typevar"].includes(t.t) && (t.t !== "list" || plain(t.element));
          if (!sym.params.every((p) => plain(p.type)) || (sym.result && sym.result.t !== "none" && !plain(sym.result))) {
            err("S353", e, `${sym.name} takes values of any type, so it is called, not passed; wrap it in a function of your own`);
            return T.ERROR;
          }
          e.functionValue = sym;
          return T.fn(sym.params.map((p) => p.type), sym.result ?? T.NONE);
        }
        // A function's name where a value goes is the function itself (§9.10).
        if (sym.kind === "function") {
          if (sym.typeParams?.length) {
            err("S353", e, `${sym.name} has a type parameter, so it is called, not passed`);
            return T.ERROR;
          }
          if (!sym.checked && !sym.checking) checkFunction(sym);
          if (!sym.result) {
            err("S353", e, `${sym.name} is used as a value inside itself; write its result: -> type`);
            return T.ERROR;
          }
          e.functionValue = sym;
          return T.fn(sym.params.map((p) => p.type), sym.result);
        }
        // The program's own name, read in a function called before the line that defines it.
        if ((ctx.fn || ctx.defaultOf) && sym.program && !sym.type) {
          const f = ctx.fn ?? ctx.defaultOf;
          err("S202", e, `${sym.name} is read in ${f.lambda ? "a function made" : `${f.name}, which is called`} before the program defines ${sym.name}, on line ${sym.line ?? sym.node?.span?.line}`);
          return T.ERROR;
        }
        return sym.type ?? T.ERROR;
      }
      case "unary": {
        const t = expr(e.operand, ctx, { allowNone: true });
        if (t.t === "none") {
          err("S371", e.operand, `${describeExpr(e.operand)} gives no value`);
          return e.op === "-" ? T.NUMBER : T.BOOL;
        }
        if (e.op === "-") {
          // Null fits a number (§3.6): `-null` is F023 when it runs.
          if (t.t !== "number" && t.t !== "null" && !T.isError(t)) err("S354", e, `- before a value is for numbers, and this is ${T.describe(t)}`);
          return T.NUMBER;
        }
        if (t.t !== "bool" && t.t !== "null" && !T.isError(t)) err("S355", e, `not is for true or false, and ${describeExpr(e.operand)} is ${T.describe(t)}`);
        return T.BOOL;
      }
      case "binary":
        return binary(e, ctx);
      case "field": {
        const t = expr(e.target, ctx);
        if (T.isError(t)) return T.ERROR;
        // An error's two fields (§3.11).
        if (t.t === "caught") {
          e.fieldIndex = T.CAUGHT_FIELDS.indexOf(e.name);
          if (e.fieldIndex < 0) {
            err("S318", e, `an error has a code and a message, and no field ${e.name}${didYouMean(e.name, T.CAUGHT_FIELDS)}`).label = `no field ${e.name}`;
            return T.ERROR;
          }
          return T.STRING;
        }
        if (t.t !== "record") {
          err("S357", e, `${describeExpr(e.target)} is ${T.describe(t)}, which has no fields${t.t === "list" ? "; count(…) is how many items, [n] the n-th" : ""}`);
          return T.ERROR;
        }
        const field = t.decl.fields.find((f) => f.name === e.name);
        if (!field) {
          err("S318", e, `the record ${t.decl.name} has no field ${e.name}${didYouMean(e.name, t.decl.fields.map((f) => f.name))}`, declaredHere(t.decl)).label = `no field ${e.name}`;
          return T.ERROR;
        }
        e.fieldIndex = t.decl.fields.indexOf(field);
        return field.type;
      }
      case "tuple":
        // (a, b, …) (§6.17): each value's own type.
        return T.tuple(e.items.map((x) => expr(x, ctx)));
      case "match-expr": {
        // The join of the arms' values (§6.18, §3.9).
        let result = T.NULL;
        let failed = false;
        matchArms(e, ctx, (arm) => {
          const t = expr(arm.value, ctx);
          const j = T.join(result, t);
          if (!j) {
            err("S745", arm.value, `this match gives ${T.describe(result)} in the arms before, and ${T.describe(t)} here, which do not join`);
            failed = true;
          } else result = j;
        });
        return failed ? T.ERROR : result;
      }
      case "index": {
        const t = expr(e.target, ctx);
        const i = expr(e.index, ctx);
        // t.0 (§6.17): a tuple's value, by a position written out.
        if (e.position || t.t === "tuple") {
          if (T.isError(t)) return T.ERROR;
          const n = Number(e.index.raw);
          if (t.t !== "tuple") return (err("S740", e, `.${n} reads a tuple's value, and ${describeExpr(e.target)} is ${T.describe(t)}`), T.ERROR);
          if (!e.position) return (err("S740", e, `a tuple's value is read by its position written after a dot: ${describeExpr(e.target)}.0`), T.ERROR);
          if (n >= t.elements.length) return (err("S740", e, `this tuple holds ${t.elements.length} values, .0 to .${t.elements.length - 1}; there is no .${n}`), T.ERROR);
          return t.elements[n];
        }
        // A map's value is chosen by its key (§6.12).
        if (t.t === "map") {
          if (!T.isError(i) && i.t !== "null" && t.key.t !== "null" && !T.fits(i, t.key)) err("S358", e.index, `this map's keys are ${T.describe(t.key)}, and this is ${T.describe(i)}`);
          else optionLiteral(e.index, t.key);
          e.mapIndex = true;
          return t.value;
        }
        if (i.t !== "number" && i.t !== "null" && !T.isError(i)) err("S358", e.index, `a list's item is chosen by its number (from 0), not ${T.describe(i)}`);
        if (T.isError(t)) return T.ERROR;
        // Words are indexed as a list is: one character (§6.9.2).
        if (T.isStringLike(t)) return T.STRING;
        if (t.t !== "list") {
          err("S359", e, `${describeExpr(e.target)} is ${T.describe(t)}, not a list${T.isStringLike(t) ? "; character(words, position) takes one character of words" : ""}`);
          return T.ERROR;
        }
        // A known position that is not a whole number of 0 or more (§6.9.2).
        const n = evaluate(e.index);
        if (V.isNumber(n)) {
          const k = V.whole(n);
          if (k === null || k < 0) err("S360", e.index, `a list's positions are whole numbers from 0; there is no item ${V.words(n)}`);
        }
        return t.element;
      }
      case "call":
        return call(e, ctx, how);
      case "map": {
        // The join of the keys' types, and of the values' (§6.12, §3.9).
        let key = T.NULL, value = T.NULL;
        for (const x of e.entries) {
          const k = expr(x.key, ctx), v = expr(x.value, ctx);
          const jk = T.join(key, k), jv = T.join(value, v);
          if (!jk) err("S361", x.key, `a map's keys join into one type; this is ${T.describe(k)}, and the keys before are ${T.describe(key)}`);
          else key = jk;
          if (!jv) err("S361", x.value, `a map's values join into one type; this is ${T.describe(v)}, and the values before are ${T.describe(value)}`);
          else value = jv;
        }
        if (!["string", "number", "date", "bool", "option", "null", "error"].includes(key.t)) err("S361", e, `a map's keys are words, numbers, dates, bools or options, not ${T.describe(key)}`);
        return T.map(key, value);
      }
      case "list": {
        // The join of the items' types, left to right (§6.11, §3.9).
        let element = T.NULL;
        for (const item of e.items) {
          const t = expr(item, ctx);
          const j = T.join(element, t);
          if (!j) err("S361", item, `a list's items join into one type; this is ${T.describe(t)}, and the items before are ${T.describe(element)}`);
          else element = j;
        }
        return T.list(element);
      }
      case "cond": {
        condition(e.condition, ctx, "if … then");
        const a = expr(e.yes, ctx);
        const b = expr(e.no, ctx);
        const j = T.join(a, b);
        if (!j) {
          err("S394", e.no, `if … then … else gives ${T.describe(a)} on one side and ${T.describe(b)} on the other, which do not join`);
          return T.ERROR;
        }
        return j;
      }
      case "slice": {
        const t = expr(e.target, ctx);
        for (const x of [e.from, e.to]) {
          const i = expr(x, ctx);
          if (i.t !== "number" && i.t !== "null" && !T.isError(i)) err("S396", x, `a slice's bounds are numbers, not ${T.describe(i)}`);
        }
        if (T.isError(t)) return T.ERROR;
        if (T.isStringLike(t)) return T.STRING; // part of words, as part of a list
        if (t.t !== "list") {
          err("S359", e, `${describeExpr(e.target)} is ${T.describe(t)}, not a list`);
          return T.ERROR;
        }
        return t;
      }
      case "comprehension": {
        const l = expr(e.list, ctx);
        if (T.isStringLike(l)) {
          e.itemSymbol.type = T.STRING; // each character
          e.overText = true;
        } else if (l.t === "list") {
          e.itemSymbol.type = l.element;
        } else if (l.t === "options") {
          e.itemSymbol.type = T.option(l.set);
        } else if (l.t === "range") {
          e.itemSymbol.type = T.NUMBER; // each of its numbers (§6.17)
        } else if (l.t === "map") {
          // A map's keys, in their order; with two names, each key and the value under it.
          if (e.indexSymbol) (e.indexSymbol.type = l.key), (e.itemSymbol.type = l.value);
          else e.itemSymbol.type = l.key;
          e.overMap = true;
        } else if (l.t === "set") {
          e.itemSymbol.type = l.element;
          e.overSet = true;
        } else if (l.t === "null") {
          e.itemSymbol.type = T.NULL; // null fits a list (§3.6); F023 when it runs
        } else {
          if (!T.isError(l)) err("S314", e.list, `for … in goes through a list, a map, a set of options or a range a..b; ${describeExpr(e.list)} is ${T.describe(l)}`);
          e.itemSymbol.type = T.ERROR;
        }
        if (e.condition) condition(e.condition, ctx, "a comprehension's if");
        const v = expr(e.value, ctx);
        if (v.t === "none") err("S366", e.value, `${describeExpr(e.value)} gives no value`);
        // With several `for`s (§6.12.1) the value is the comprehension of the next: one list of all its values.
        const type = e.nested ? v : T.list(v);
        if (!e.asMap) return type;
        // {k: v for …} (§6.12.2): the pairs made a map.
        const pair = type.t === "list" ? type.element : null;
        if (pair?.t !== "tuple") return T.ERROR;
        if (!T.isKey(pair.elements[0])) err("S361", e, `a map's keys are words, numbers, dates, bools or options, not ${T.describe(pair.elements[0])}`);
        return T.map(pair.elements[0], pair.elements[1]);
      }
      case "named-arg":
        return expr(e.value, ctx);
      case "new": {
        const sym = e.recordSymbol;
        const seen = new Set();
        for (const f of e.fields) {
          const field = sym?.decl.fields.find((x) => x.name === f.name);
          const t = expr(f.value, ctx, { want: field?.type });
          if (!sym) continue;
          if (seen.has(f.name)) err("S362", f, `${f.name} is given twice`);
          seen.add(f.name);
          if (!field) err("S363", f, `the record ${sym.name} has no field ${f.name}${didYouMean(f.name, sym.decl.fields.map((x) => x.name))}`);
          else if (!fitsAt(f.value, t, field.type)) err("S364", f.value, `${sym.name}'s ${f.name} is ${T.describe(field.type)}, and this is ${T.describe(t)}`);
          else optionLiteral(f.value, field.type);
        }
        return sym ? sym.type : T.ERROR;
      }
      default:
        throw new Error(`unknown expression ${e.kind}`);
    }
  }

  function call(e, ctx, how) {
    const result = callOf(e, ctx, how);
    // A short function the call gave no types to (§9.12): S760 where it stands.
    for (const a of e.args) {
      const v = a.kind === "named-arg" ? a.value : a;
      if (!v.type) expr(v, ctx, { allowNone: true });
      if (a.kind === "named-arg") a.type = v.type;
    }
    // sorted(l, key: f): what f gives is ordered (§14.4.3).
    const key = e.callee && e.callee === givenAFunction.sorted_by_key ? e.bound?.[1] : null;
    if (key?.type?.t === "function" && !T.orderable(key.type.result)) err("S367", key, `sorted orders numbers, dates or words, and key gives ${T.describe(key.type.result)}`);
    return result;
  }

  function callOf(e, ctx, how) {
    // r.f(…) where a record somewhere has a method f, or a field f that holds a function (§9.8): what r is says
    // which is called. The record's own method first, then its field, then a function of the file.
    let typed = null;
    if (e.dot) {
      const receiver = (typed = e.args[0]);
      const rt = expr(receiver, ctx, { allowNone: true });
      const decl = rt.t === "record" ? rt.decl : null;
      const method = decl?.methods?.get(e.dot.name);
      const field = decl?.fields.find((f) => f.name === e.dot.name);
      if (method) e.target.symbol = method;
      else if (field?.type.t === "function") {
        e.dot.fieldIndex = decl.fields.indexOf(field);
        e.dot.type = field.type;
        e.target = e.dot;
        e.args = e.args.slice(1);
        e.valueCall = e.fieldCall = true;
        e.method = false;
      } else if (e.noFunction) err("S230", e.target, e.noFunction);
      e.dot = null;
    }
    // sorted, any and all given a function are functions of the standard library written in Stride (§14.4.3).
    if (!e.valueCall && e.target.symbol?.kind === "native" && e.target.symbol.unit?.std) {
      const named = (n) => e.args.some((a) => a.kind === "named-arg" && a.name === n);
      const name = e.target.symbol.name;
      const to = name === "sorted" ? (named("key") ? "sorted_by_key" : named("compare") ? "sorted_by_compare" : null) : (name === "any" || name === "all") && (e.args.length > 1 || named("test")) ? `${name}_where` : null;
      if (to && givenAFunction[to]) e.target.symbol = givenAFunction[to];
    }
    for (const a of e.args) {
      const v = a.kind === "named-arg" ? a.value : a;
      if (v !== typed && !waits(v)) expr(v, ctx, { allowNone: true });
    }
    for (const a of e.args) if (a.kind === "named-arg") a.type = a.value.type;
    const sym = e.target.symbol;
    if (!sym && !e.valueCall) return T.ERROR;
    // A call of a function a value holds (§9.10): its values in order, each of its parameter's type.
    if (e.valueCall) {
      const called = e.target.kind === "name" ? e.target.name : "the function";
      const t = e.fieldCall && e.target.type ? e.target.type : expr(e.target, ctx);
      if (T.isError(t)) return T.ERROR;
      if (t.t !== "function") return (err("S228", e.target, `${e.target.kind === "name" ? e.target.name : "this"} is ${T.describe(t)}, not a function`), T.ERROR);
      if (e.args.some((a) => a.kind === "named-arg")) return (err("S388", e, `a function held in a name takes its values in order, without names`), T.ERROR);
      if (e.args.length !== t.params.length) return (err("S365", e, `${called} takes ${t.params.length} ${t.params.length === 1 ? "value" : "values"}, and is given ${e.args.length}`), T.ERROR);
      e.args.forEach((a, i) => {
        if (waits(a)) expr(a, ctx, { allowNone: true, want: t.params[i] });
        if (a.type && !T.isError(a.type) && !fitsAt(a, a.type, t.params[i])) err("S367", a, `${called}'s value ${i + 1} is ${T.describe(t.params[i])}, and this is ${T.describe(a.type)}`);
      });
      e.valueType = t;
      return t.result;
    }
    e.callee = sym;
    // print(a, b, …) (§14.5): any number of values, each one that print shows.
    if (sym.kind === "native" && sym.name === "print" && e.args.length !== 1 && e.args.every((a) => a.kind !== "named-arg")) {
      for (const a of e.args) if (a.type?.t === "none") err("S366", a, `${describeExpr(a)} gives no value`);
      e.printAll = true;
      return sym.result ?? T.NONE;
    }
    if (sym.kind === "function" && !sym.checked) {
      if (sym.checking) {
        // A function that reaches itself: the flow check says so; its result is not known here.
        if (sym.inferResult) return T.ERROR;
      } else checkFunction(sym);
    }
    const params = sym.params ?? [];
    // §9.4: positional arguments first, then named ones; each parameter given once; every one without a default
    // given. The call's arguments are put in the parameters' order, defaults filled in (`e.bound`).
    const bound = new Array(params.length).fill(null);
    let sortBy = null; // sorted(l, by: "field")
    let named = false;
    let ok = true;
    e.args.forEach((a) => {
      if (a.kind === "named-arg") {
        named = true;
        if (sym.kind === "native" && sym.name === "sorted" && a.name === "by") {
          // Each parameter given once (§9.4): `by` too.
          if (sortBy) {
            err("S389", a, "by is given twice");
            ok = false;
          }
          sortBy = a;
          return;
        }
        const i = params.findIndex((p) => p.name === a.name);
        if (i < 0) {
          err("S388", a, `${sym.name} has no parameter ${a.name}${didYouMean(a.name, params.map((p) => p.name))}`);
          ok = false;
        } else if (bound[i]) {
          err("S389", a, `${a.name} is given twice`);
          ok = false;
        } else bound[i] = a.value;
        return;
      }
      if (named) {
        err("S390", a, "a value without a name comes before the named ones");
        ok = false;
        return;
      }
      const i = bound.findIndex((x) => x === null);
      if (i < 0 || bound.filter(Boolean).length >= params.length) {
        ok = false;
        return;
      }
      bound[i] = a;
    });
    const given = e.args.filter((a) => a.kind !== "named-arg" || a !== sortBy).length;
    const positional = e.args.filter((a) => a.kind !== "named-arg").length;
    if (positional > params.length || params.some((p, i) => !bound[i] && !p.hasDefault)) {
      if (ok || positional > params.length) err("S365", e, `${sym.name} takes ${params.length === 0 ? "no values" : `${params.length} value${params.length === 1 ? "" : "s"} (${params.map((p) => `${p.name}${p.hasDefault ? " = …" : ""}`).join(", ")})`}, and is given ${given}`);
      return sym.result?.t === "any" ? T.ERROR : sym.result ?? T.ERROR;
    }
    // A short function takes its parameters' types from its parameter (§9.12), with the type parameters the other
    // arguments tell put in; one whose type a type parameter not told yet holds is left for the function to tell.
    if (bound.some(waits)) {
      const told = new Map();
      bound.forEach((a, i) => a?.type && T.unify(params[i].type, a.type, told));
      const open = (t) => (sym.typeParams ?? []).some((tv) => !told.has(tv) && T.typevarIn(t, tv));
      bound.forEach((a, i) => {
        if (!waits(a)) return;
        const p = T.substitute(params[i].type, told);
        const want = p.t === "function" ? T.fn(p.params.map((x) => (open(x) ? null : x)), open(p.result) ? null : p.result) : null;
        expr(a, ctx, { allowNone: true, want });
        if (a.type?.t === "function") T.unify(params[i].type, a.type, told);
      });
    }
    e.bound = bound.map((a, i) => a ?? { kind: "default-of", param: params[i], span: e.span, file: e.file, type: params[i].type });
    // §9.5.1: each argument whose parameter mentions a type parameter gives it a candidate; the binding is their join.
    const candidates = new Map();
    const ordered = []; // every candidate, for every type parameter, in the order the arguments are written
    // Each candidate remembers the argument it came from, for the place of S367.
    const collect = (want, got, from) => {
      if (want.t === "typevar") {
        if (got.t !== "null") {
          candidates.set(want.sym, [...(candidates.get(want.sym) ?? []), { type: got, from }]);
          ordered.push({ tv: want.sym, type: got, from });
        }
      } else if ((want.t === "list" && got.t === "list") || (want.t === "set" && got.t === "set")) collect(want.element, got.element, from);
      else if (want.t === "tuple" && got.t === "tuple") want.elements.forEach((p, i) => got.elements[i] && collect(p, got.elements[i], from));
      else if (want.t === "map" && got.t === "map") (collect(want.key, got.key, from), collect(want.value, got.value, from));
      else if (want.t === "function" && got.t === "function") (want.params.forEach((p, i) => got.params[i] && collect(p, got.params[i], from)), collect(want.result, got.result, from));
    };
    // In the order the arguments are written, then the defaults of those not given, in the parameters' order
    // (§9.5.1): a join does not depend on it, but S367 stands at the first written argument that conflicts.
    for (const a of e.args) {
      const i = bound.indexOf(a.kind === "named-arg" ? a.value : a);
      if (i >= 0 && bound[i].type) collect(params[i].type, bound[i].type, i);
    }
    params.forEach((p, i) => !bound[i] && p.node?.default?.type && collect(p.type, p.node.default.type, i));
    const bindings = new Map();
    let joinFailed = null;
    // Every type parameter's join, its candidates taken in the order written, all parameters together: the first
    // candidate, whichever parameter it is for, that does not join the ones before it is the conflict (S367).
    const joined = new Map();
    for (const c of ordered) {
      if (joinFailed && joinFailed.tv === c.tv) continue;
      const before = joined.get(c.tv) ?? T.NULL;
      const next = T.join(before, c.type);
      if (!next) joinFailed ??= { tv: c.tv, before, value: c.type, from: c.from };
      else joined.set(c.tv, next);
    }
    for (const [tv, j] of joined) if (j.t !== "null") bindings.set(tv, j);
    // f<T, …>(…): the type arguments written are the bindings, and the arguments are checked against them (§9.5.2).
    if (e.typeArgTypes) {
      const tps = sym.typeParams ?? [];
      if (tps.length !== e.typeArgTypes.length) {
        err("S780", e, `${sym.name} has ${tps.length === 0 ? "no type parameters" : `${tps.length} type parameter${tps.length === 1 ? "" : "s"}`}, and is given ${e.typeArgTypes.length}`);
        return T.ERROR;
      }
      tps.forEach((tv, i) => bindings.set(tv, e.typeArgTypes[i]));
      joinFailed = null;
    }
    if (joinFailed) {
      // The first argument whose candidate does not join the ones before it (§9.5.1).
      const i = joinFailed.from;
      const at = bound[i] ?? e;
      err("S367", at, `${sym.name}'s ${params[i]?.name ?? "argument"} is ${T.describe(joinFailed.before)}, and this is ${T.describe(joinFailed.value)}`);
      return T.ERROR;
    }
    bound.forEach((a, i) => {
      if (!a) return;
      const want = params[i].type;
      if (a.type.t === "none") err("S366", a, `${describeExpr(a)} gives no value`);
      else if (T.hasTypevar(want)) {
        if (!T.fits(a.type, T.substitute(want, bindings)) && !T.unify(want, a.type, new Map(bindings))) err("S367", a, `${sym.name}'s ${params[i].name} is ${T.describe(T.substitute(want, bindings))}, and this is ${T.describe(a.type)}`);
      } else if (!fitsAt(a, a.type, want)) err("S367", a, `${sym.name}'s ${params[i].name} is ${T.describe(want)}, and this is ${T.describe(a.type)}`);
      else optionLiteral(a, want);
    });

    let result = sym.result ? T.substitute(sym.result, bindings) : T.ERROR;
    // A type parameter the arguments do not tell (§9.5): S368, whatever the result's type.
    // set(l) (§14.4.2): a set of l's items; `set()` holds none, and takes its type from where it stands.
    const makesSet = sym.kind === "native" && sym.name === "set";
    if (makesSet) {
      const given = bound[0] && bound[0].kind !== "default-of" ? bound[0].type : null;
      const element = given?.t === "list" ? given.element : T.NULL;
      if (!["string", "number", "date", "bool", "null", "error", "typevar"].includes(element.t)) {
        err("S743", bound[0], element.t === "option" ? `the options of ${element.set.name} make a set<${element.set.name}>: give the list where one is wanted` : `a set holds words, numbers, dates or bools, not ${T.describe(element)}`);
        result = T.ERROR;
      } else result = T.set(element);
    } else if ((sym.typeParams ?? []).some((tv) => !bindings.has(tv))) {
      err("S368", e, `the arguments do not tell what ${(sym.typeParams ?? []).filter((tv) => !bindings.has(tv)).map((tv) => tv.name).join(" and ")} is here (an empty list says nothing); give a value of the type`);
      result = T.ERROR;
    }
    const first = bound[0]?.type ?? T.ERROR;
    // A native whose result is its T (§14.4, §14.5): the arguments that hold T must tell it; the bare `null` gives
    // no candidate (§9.5.1), so when all of them are null, T is not told: S368.
    const TOLD_BY = { first: [0], last: [0], filled: [0], reversed: [0], sorted: [0], smallest: [0], largest: [0], either: [0, 1] };
    // An empty list says nothing either (S368): `[]` holds no item to tell T by.
    const tells = (t) => t && t.t !== "null" && !(t.t === "list" && !tells(t.element));
    if (sym.kind === "native" && TOLD_BY[sym.name] && TOLD_BY[sym.name].every((i) => !tells(bound[i]?.type))) {
      err("S368", e, `the arguments do not tell what ${sym.name} gives (an empty list, or the bare null, says nothing); give a value of the type`);
      return T.ERROR;
    }
    // either(a: T, b: T) -> T (§14.5): T is the join of its two arguments (§3.9, §9.5.1), or S367 when there is none.
    if (sym.kind === "native" && sym.name === "either" && bound.length === 2) {
      const j = T.join(first, bound[1]?.type ?? T.ERROR);
      if (!j) {
        err("S367", bound[1], `either's a is ${T.describe(first)}, and this is ${T.describe(bound[1].type)}: they have no type in common`);
        result = T.ERROR;
      } else result = j;
    } else if (result.t === "any") result = first;
    // Two sets of one type (§14.4.2): a set of the join of what they hold.
    if (sym.kind === "native" && ["union", "intersection", "difference"].includes(sym.name) && first.t === "set" && bound[1]?.type?.t === "set") result = T.join(first, bound[1].type) ?? first;
    if (result.t === "element") {
      if (first.t === "list") result = first.element;
      else if (first.t === "options") result = T.option(first.set);
      else {
        if (!T.isError(first)) err("S369", bound[0], `${sym.name} takes a list or a set of options, and this is ${T.describe(first)}`);
        result = T.ERROR;
      }
    }
    if (sym.kind === "native") nativeDomain(sym, e, bound, sortBy);
    return result;
  }

  // The element types the list natives take (§14.4), and sorted's field (S399).
  function nativeDomain(sym, e, bound, sortBy) {
    const l = bound[0]?.type;
    if (!l || T.isError(l)) return;
    const element = l.t === "list" ? l.element : l.t === "options" ? T.option(l.set) : null;
    const hasWords = (t) => T.isStringLike(t) || ["number", "date", "bool", "option", "null", "error", "caught"].includes(t.t);
    // The list functions (§14.4) take a list, or a set of options; their value to look for is one of its items.
    const LIST_FUNCTIONS = ["count", "join", "first", "last", "filled", "index_of", "append", "insert", "remove_at", "without", "reversed", "sorted", "sum", "smallest", "largest"];
    const SET_FUNCTIONS = ["count", "join", "first", "last"];
    if (sym.name === "count" && (l.t === "map" || l.t === "range" || l.t === "set" || T.isStringLike(l))) return;
    if (sym.name === "clear") {
      if (l.t !== "list" && l.t !== "map" && l.t !== "set" && l.t !== "null") err("S369", bound[0], `clear takes a list or a map, and this is ${T.describe(l)}`);
      return;
    }
    // remove(m, key), remove(s, x) (§14.4.1, §14.4.2): a key of the map, a value of the set.
    if (sym.name === "remove") {
      const x = bound[1];
      if (l.t === "map" || l.t === "set") {
        const want = l.t === "map" ? l.key : l.element;
        if (x?.type && !T.isError(x.type) && want.t !== "null" && !fitsAt(x, x.type, want)) err("S367", x, `remove's key is ${T.describe(want)}, and this is ${T.describe(x.type)}`);
        else if (x) optionLiteral(x, want);
      } else if (l.t !== "null") err("S369", bound[0], `remove takes a map or a set, and this is ${T.describe(l)}`);
      return;
    }
    if (["union", "intersection", "difference"].includes(sym.name) && (l.t === "set" || bound[1]?.type?.t === "set")) {
      const b = bound[1]?.type;
      if (b && !T.isError(b) && !((l.t === "set" || l.t === "null") && (b.t === "set" || b.t === "null") && T.join(l, b))) err("S387", e, `${sym.name} takes two sets of one type`);
      return;
    }
    if (LIST_FUNCTIONS.includes(sym.name) && !element && l.t !== "null") {
      err("S369", bound[0], `${sym.name} takes a list${SET_FUNCTIONS.includes(sym.name) ? " or a set of options" : ""}, and this is ${T.describe(l)}`);
      return;
    }
    // Only those whose entry says "or a set" take one (§14.4); the others keep a list's order, which a set has not.
    if (l.t === "options" && LIST_FUNCTIONS.includes(sym.name) && !SET_FUNCTIONS.includes(sym.name)) {
      err("S369", bound[0], `${sym.name} takes a list, and this is ${T.describe(l)}; count, join, first and last take a set`);
      return;
    }
    // The value to look for, or to put in: one of the items.
    const x = ["index_of", "append", "without"].includes(sym.name) ? bound[1] : sym.name === "insert" ? bound[2] : null;
    if (x && element?.t === "option") optionLiteral(x, element);
    if (x && element && x.type && !T.isError(x.type) && (!T.join(element, x.type) || (["append", "insert"].includes(sym.name) && element.t !== "null" && !fitsAt(x, x.type, element)))) err("S367", x, `${sym.name} ${["append", "insert"].includes(sym.name) ? "adds" : "looks for"} one of the items, which are ${T.describe(element)}, and this is ${T.describe(x.type)}`);
    if (sym.name === "sum" && element && !["number", "null", "error"].includes(element.t)) err("S367", bound[0], `sum adds numbers up, and the items are ${T.describe(element)}`);
    if (sym.name === "join" && element && !hasWords(element)) err("S367", bound[0], `join puts items' words together, and the items are ${T.describe(element)}, which have no words`);
    // A set has words too: its options' values in declaration order (§3.5).
    if (sym.name === "string_of" && !hasWords(l) && l.t !== "options") err("S367", bound[0], `string_of gives a value's words, and ${T.describe(l)} has none`);
    if (["sorted", "smallest", "largest"].includes(sym.name) && element) {
      if (sortBy) {
        if (element.t !== "record") err("S367", bound[0], `sorted by a field takes a list of records, and these are ${T.describe(element)}`);
        else {
          const v = sortBy.value.kind === "string" && sortBy.value.parts.length <= 1 && sortBy.value.parts.every((p) => typeof p === "string") ? (sortBy.value.parts[0] ?? "") : null;
          const field = v === null ? null : element.decl.fields.findIndex((f) => f.name === v);
          if (v === null) err("S399", sortBy.value, "by names a field in plain words in quotes");
          else if (field < 0) err("S399", sortBy.value, `the record ${element.decl.name} has no field ${v}${didYouMean(v, element.decl.fields.map((f) => f.name))}`);
          else if (!T.orderable(element.decl.fields[field].type)) err("S399", sortBy.value, `${element.decl.name}'s ${v} is ${T.describe(element.decl.fields[field].type)}, which cannot be ordered`);
          else e.sortField = field;
        }
      } else if (!T.orderable(element)) err("S367", bound[0], `${sym.name} orders numbers, dates or words, and these are ${T.describe(element)}`);
    }
    if (["union", "intersection", "difference"].includes(sym.name)) {
      // Two sets of one option set; either may be words in quotes of its options, as anywhere a set is wanted (§3.6).
      const a = l, b = bound[1]?.type;
      const set = a.t === "options" ? a : b?.t === "options" ? b : null;
      const fitsSet = (x, t) => !t || T.isError(t) || (t.t === "options" && t.set === set.set) || fitsAt(x, t, set);
      if (!set || !fitsSet(bound[0], a) || !fitsSet(bound[1], b)) err("S387", e, `${sym.name} takes two sets of one option set`);
      else {
        e.setOperand = set;
        for (const [x, t] of [[bound[0], a], [bound[1], b]]) if (x && t?.t !== "options") optionLiteral(x, set);
      }
    }
  }

  function binary(e, ctx) {
    const a = expr(e.a, ctx, { allowNone: true });
    const b = expr(e.b, ctx, { allowNone: true });
    // At the operation itself, its brackets left out; in `x -= e`, the `-=` (§16.2.1).
    const err2 = (code, message) => (err(code, { file: e.file, span: e.compound ? e.opSpan : e.bareSpan ?? e.span }, message), T.ERROR);
    const anyError = T.isError(a) || T.isError(b);
    // At the operand that gives none (§16.2.1).
    for (const [x, t] of [[e.a, a], [e.b, b]]) if (t.t === "none") return (err("S371", x, `${describeExpr(x)} gives no value`), T.ERROR);
    switch (e.op) {
      case "+":
        if (anyError) return T.isError(a) ? b : a;
        if (a.t === "number" && b.t === "number") return T.NUMBER;
        // A date and a number of days (§6.4.3).
        if (a.t === "date" && (b.t === "number" || b.t === "null")) return T.DATE;
        // Lists join (§6.5.1): the join of the elements.
        if (a.t === "list" || b.t === "list") {
          const x = a.t === "list" ? a : T.list(T.NULL);
          const y = b.t === "list" ? b : T.list(T.NULL);
          if ((a.t !== "list" && a.t !== "null") || (b.t !== "list" && b.t !== "null")) return err2("S373", `+ joins two lists, not ${T.describe(a)} and ${T.describe(b)}`);
          const element = T.join(x.element, y.element);
          // No join stands at the second value (§3.9 rule 5).
          if (!element) return (err("S373", e.b, `+ joins lists whose items join into one type; these hold ${T.describe(x.element)} and ${T.describe(y.element)}`), T.ERROR);
          return T.list(element);
        }
        // Words of any kind, an option among them, join into a string (§6.5).
        const wordy = (t) => T.isStringLike(t) || t.t === "option" || t.t === "null";
        if (wordy(a) && wordy(b) && (a.t !== "null" || b.t !== "null")) return T.STRING;
        // Empty fits a number (§3.6): F023 when it runs.
        if (a.t === "null" && (b.t === "number" || b.t === "null")) return b;
        if (b.t === "null" && a.t === "number") return a;
        if ((wordy(a) && b.t === "number") || (a.t === "number" && wordy(b))) return err2("S372", `+ adds two numbers or joins two words; to put a number into words, write "…{${describeExpr(a.t === "number" ? e.a : e.b)}}…"`);
        return err2("S373", `+ adds numbers or joins words, not ${T.describe(a)} and ${T.describe(b)}`);
      case "-":
      case "*":
      case "/":
      case "//":
      case "%":
      case "**":
        if (anyError) return T.NUMBER;
        if ((a.t === "number" || a.t === "null") && (b.t === "number" || b.t === "null")) return T.NUMBER;
        // A date less a number of days is a date; a date less a date is the days between them (§6.4.3).
        if (e.op === "-" && a.t === "date" && (b.t === "number" || b.t === "null")) return T.DATE;
        if (e.op === "-" && a.t === "date" && b.t === "date") return T.NUMBER;
        return err2("S374", `${e.op} is for numbers, not ${T.describe(a)} and ${T.describe(b)}`);
      case "..":
      case "..<":
        // A range's bounds are numbers (§6.17); null fits one, and is F023 when it runs.
        for (const [x, t] of [[e.a, a], [e.b, b]]) if (t.t !== "number" && t.t !== "null" && !T.isError(t)) err("S700", x, `a range's bounds are numbers; ${describeExpr(x)} is ${T.describe(t)}`);
        return T.RANGE;
      case "==":
      case "!=": {
        // A set compared with a list of words in quotes: the words are options of its set (§3.6, S386).
        if ((a.t === "options" && fitsAt(e.b, b, a)) || (b.t === "options" && fitsAt(e.a, a, b))) {
          if (a.t === "options") optionLiteral(e.b, a);
          else optionLiteral(e.a, b);
          return T.BOOL;
        }
        if (!T.comparable(a, b)) {
          if ((a.t === "bool" && T.isStringLike(b)) || (b.t === "bool" && T.isStringLike(a))) {
            return err2("S376", `a bool is true or false, without quotes: ${describeExpr(a.t === "bool" ? e.a : e.b)} == true, or ${describeExpr(a.t === "bool" ? e.a : e.b)} alone as the condition`);
          }
          if (a.t === "options" || b.t === "options") return err2("S377", `${describeExpr(a.t === "options" ? e.a : e.b)} holds several options; ask if one is chosen with "…" in ${describeExpr(a.t === "options" ? e.a : e.b)}`);
          return err2("S378", `${T.describe(a)} and ${T.describe(b)} cannot be compared`);
        }
        if (a.t === "option") optionLiteral(e.b, a);
        if (b.t === "option") optionLiteral(e.a, b);
        return T.BOOL;
      }
      case "<":
      case "<=":
      case ">":
      case ">=":
        if (!anyError && !T.ordered(a.t === "null" ? b : a, b.t === "null" ? a : b)) return err2("S379", `${e.op} orders two numbers, two dates or two words, not ${T.describe(a)} and ${T.describe(b)}`);
        return T.BOOL;
      case "and":
      case "or":
        for (const [x, t] of [[e.a, a], [e.b, b]]) {
          if (t.t !== "bool" && t.t !== "null" && !T.isError(t)) err("S380", x, `${e.op} joins two conditions (true or false); ${describeExpr(x)} is ${T.describe(t)}`);
        }
        return T.BOOL;
      case "??": {
        // a ?? b (§6.16): the join of the two (§3.9); a set takes words in quotes that name its options (§3.6).
        if (anyError) return T.isError(a) ? b : a;
        if (a.t === "options" && b.t === "list" && fitsAt(e.b, b, a)) return (optionLiteral(e.b, a), a);
        if (b.t === "options" && a.t === "list" && fitsAt(e.a, a, b)) return (optionLiteral(e.a, b), b);
        const j = T.join(a, b);
        if (!j) return (err("S394", e.b, `?? gives ${T.describe(a)} on one side and ${T.describe(b)} on the other, which do not join`), T.ERROR);
        return j;
      }
      case "in":
      case "not in":
        if (anyError) return T.BOOL;
        if (b.t === "options") {
          if (a.t === "option" && a.set !== b.set) return err2("S381", `${describeExpr(e.a)} is one of ${a.set.name}, and ${describeExpr(e.b)} holds options of ${b.set.name}`);
          if (!T.isStringLike(a) && a.t !== "option" && a.t !== "null") return err2("S382", `${e.op} asks whether an option is among ${describeExpr(e.b)}; this is ${T.describe(a)}`);
          optionLiteral(e.a, b);
          return T.BOOL;
        }
        if (b.t === "set") {
          if (!T.fits(a, b.element) && !T.fits(b.element, a)) return err2("S383", `${describeExpr(e.b)} holds ${T.describe(b.element)}, and this is ${T.describe(a)}`);
          return T.BOOL;
        }
        if (b.t === "list") {
          if (!T.fits(a, b.element) && !T.fits(b.element, a)) return err2("S383", `${describeExpr(e.b)} holds ${T.describe(b.element)}, and this is ${T.describe(a)}`);
          // Words looked for among options are one of the set's values (§3.6, S386).
          if (b.element.t === "option") optionLiteral(e.a, b.element);
          return T.BOOL;
        }
        if (b.t === "null") return T.BOOL; // null fits a list (§3.6); F023 when it runs
        // A number among a range's (§6.17).
        if (b.t === "range") {
          if (a.t !== "number" && a.t !== "null") return err2("S383", `${describeExpr(e.b)} holds numbers, and this is ${T.describe(a)}`);
          return T.BOOL;
        }
        // Words within words, and a key among a map's.
        if (T.isStringLike(b) && (T.isStringLike(a) || a.t === "option" || a.t === "null")) return T.BOOL;
        if (b.t === "map") {
          if (!T.fits(a, b.key)) return err2("S383", `${describeExpr(e.b)}'s keys are ${T.describe(b.key)}, and this is ${T.describe(a)}`);
          return T.BOOL;
        }
        if (T.isStringLike(b)) return err2("S384", `${e.op} asks about a set of options or a list; for words within words, contains(${describeExpr(e.b)}, ${describeExpr(e.a)})`);
        return err2("S385", `${e.op} asks about a set of options or a list; ${describeExpr(e.b)} is ${T.describe(b)}`);
      default:
        throw new Error(`unknown operator ${e.op}`);
    }
  }

  return { collected };
}

// An expression, briefly, as it is written: for messages.
export function describeExpr(e) {
  switch (e?.kind) {
    case "name":
      return e.name;
    case "field":
      return `${describeExpr(e.target)}.${e.name}`;
    case "index":
      return e.position ? `${describeExpr(e.target)}.${e.index.raw}` : `${describeExpr(e.target)}[${describeExpr(e.index)}]`;
    case "call":
      return `${describeExpr(e.target)}(…)`;
    case "number":
      return String(e.value);
    case "string":
      return e.parts.length === 1 && typeof e.parts[0] === "string" ? `"${e.parts[0]}"` : '"…"';
    case "bool":
      return e.value ? "true" : "false";
    case "null":
      return "null";
    default:
      return "this";
  }
}
