// Phase 4: check types. Every expression gets its type (`.type`) and every statement is checked against what
// it may do:
//
//   - an operator gets operands it works on: + adds numbers or joins words, < compares numbers or dates, and/or
//     take yes-no, `in` asks a set of options or a list;
//   - an option is compared only with one of its own values ("sign" in acts, kind == "individual");
//   - a call has as many arguments as its function has parameters, each of the parameter's type;
//   - a box is filled with words, a number, a date or an option; ticked or picked on a yes-no;
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

  // ----- declarations

  for (const r of resolved.units) {
    for (const sym of r.natives) {
      if (!NATIVES[sym.name]) err("S301", sym.node, `the machine has no native called ${sym.name} (runtime/natives.mjs)${didYouMean(sym.name, Object.keys(NATIVES))}`);
      else if (NATIVES[sym.name].fn.length !== sym.params.length) err("S302", sym.node, `the native ${sym.name} takes ${NATIVES[sym.name].fn.length} values in the machine, and is declared with ${sym.params.length}`);
    }
    for (const sym of r.natives) checkDefaults(sym);
    for (const sym of r.consts) constType(sym);
  }

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
    if (["record"].includes(sym.type.t)) err("S306", sym.node, `a constant is words, a number, a date, yes or no, a set, or a list of them; ${sym.name} is ${T.describe(sym.type)}`);
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

  for (const r of resolved.units) {
    // The program first: a function it calls is checked at the call, and may read the names defined before it.
    if (!r.unit.library) block(r.main, { fn: null, unit: r.unit, main: true });
    for (const sym of r.functions) checkFunction(sym, r.unit);
  }

  // A type no value tells: the bare empty, or a list of such at any depth (§6.11, S328, S344).
  function untold(t) {
    return t?.t === "empty" || (t?.t === "list" && untold(t.element));
  }

  // A function's body, once; a function whose result is worked out from its returns is checked before the first
  // call that needs its result (no function reaches itself, so this ends; the flow check reports one that does).
  function checkFunction(sym, unit = sym.unit) {
    if (sym.checked || sym.checking) return;
    sym.checking = true;
    checkDefaults(sym);
    const ctx = { fn: sym, unit, returns: [] };
    block(sym.node.body, ctx);
    if (sym.inferResult) {
      let result = T.NONE;
      for (const { type, node } of ctx.returns) {
        if (T.isError(type) || type.t === "none") continue;
        if (result.t === "none" || result.t === "empty") result = type;
        else if (T.fits(type, result)) continue;
        else if (T.fits(result, type)) result = type;
        else err("S343", node, `${sym.name} gives ${T.describe(result)} on one path and ${T.describe(type)} here; one function gives one type (or write it: -> type)`);
      }
      if (untold(result)) {
        err("S344", sym.node, `${sym.name} returns only empty, so its type cannot be worked out; write it: -> text`);
        result = T.ERROR;
      }
      // A worked-out list result with no most stated anywhere.
      const unbounded = (t) => t.t === "list" && (!Number.isFinite(t.most) || unbounded(t.element));
      const bounded = (t) => (t.t === "list" ? T.list(bounded(t.element), Number.isFinite(t.most) ? t.most : 1000) : t);
      if (unbounded(result)) result = bounded(result); // no most written anywhere: it holds up to 1000 (§3.7)
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
      const t = expr(d, { fn: null });
      // A default for a parameter of a type parameter is one more candidate at each call that leaves it out
      // (§9.5.1), checked there; any other default fits its parameter here.
      if (!T.hasTypevar(p.type) && !fitsAt(d, t, p.type)) err("S367", d, `${p.name} is ${T.describe(p.type)}, and its default is ${T.describe(t)}`);
      const v = evaluate(d);
      // Made of known values, and its working out faults: S413 at the operation, in the flow phase (§11.3.3, §11.3.5).
      if (v === undefined && faultIn(d)) p.fault = faultIn(d);
      else if (v === undefined) err("S393", d, `a default is worked out by the compiler: words, numbers and constants`);
      else {
        // Placed as the parameter's type, as an argument is (§9.2, §3.7.2): words for a set become the set, a list
        // takes the parameter's most, a bare empty a list's (§3.7.3.1).
        const placed = T.hasTypevar(p.type) ? v : knownPlaced(d, p.type);
        if (placed === undefined) err("S367", d, `${p.name} is ${T.describe(p.type)}, and its default does not fit it`);
        else p.defaultValue = placed;
      }
    }
  }

  // Whether a list type fits another but for a most that is too large, at some level (§3.7.2: S351).
  function narrows(a, b) {
    if (a?.t !== "list" || b?.t !== "list") return false;
    const widenAll = (t) => (t.t === "list" ? T.list(widenAll(t.element), Infinity) : t);
    return T.fits(widenAll(a), widenAll(b)) && !T.fits(a, b);
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
          if (type.t === "yes-no") err("S307", s.value, `fill writes words or a number; a yes-no answer goes into a check box with tick "box" when …`);
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
      case "while":
        condition(s.condition, ctx, "while");
        return block(s.body, ctx);
      case "for": {
        const a = expr(s.from, ctx), b = expr(s.to, ctx);
        // Empty fits a number (§3.6): an empty bound is F004 when it runs (§7.11), S413 when known.
        for (const [e, t] of [[s.from, a], [s.to, b]]) if (t.t !== "number" && t.t !== "empty" && !T.isError(t)) err("S313", e, `a for loop counts numbers; this is ${T.describe(t)}`);
        return block(s.body, ctx);
      }
      case "for-each": {
        const type = expr(s.list, ctx);
        if (type.t === "list") s.itemSymbol.type = type.element;
        else if (type.t === "options") s.itemSymbol.type = T.option(type.set);
        else if (type.t === "empty") s.itemSymbol.type = T.EMPTY; // no turns (§3.6)
        else {
          if (!T.isError(type)) err("S314", s.list, `for each goes through a list or a set of options; ${describeExpr(s.list)} is ${T.describe(type)}`);
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
    const answer = form === "one-of" || form === "any-of" ? (s.set ? T.typeOfAnswer(form, s.set) : T.ERROR) : T.typeOfAnswer(form);
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
    let type = s.value ? expr(s.value, ctx, { allowNone: true }) : null;
    if (type?.t === "none") {
      err("S324", s.value, `${describeExpr(s.value)} gives no value to keep`);
      type = T.ERROR;
    }
    if (s.declaredType) {
      // A list too large for its declared most is S351 (§3.7.2); any other mismatch S325.
      const narrowing = narrows(type, s.declaredType);
      if (type && !fitsAt(s.value, type, s.declaredType)) err(narrowing ? "S351" : "S325", s.value, `${s.name} is ${T.describe(s.declaredType)}, and this is ${T.describe(type)}`);
      else if (type) optionLiteral(s.value, s.declaredType);
      type = s.declaredType;
    } else if (!type) {
      err("S326", s, `var ${s.name} needs a type or a value: var ${s.name}: text, or var ${s.name} = …`);
      type = T.ERROR;
    } else if (type.t === "empty") {
      err("S327", s.value, `${s.name} = empty says nothing about what ${s.name} holds; give it a type: ${s.kind} ${s.name}: text = empty`);
      type = T.ERROR;
    } else if (type.t === "list" && untold(type.element)) {
      // `[]`, `[[]]`, `[[empty]]`: no item says what the list holds, at any depth (§6.11, §7.4).
      err("S328", s.value, `an empty list says nothing about what it holds; give ${s.name} a type: ${s.kind} ${s.name}: list of text most 4`);
      type = T.ERROR;
    }
    if (type.t === "list" && s.kind === "var" && !s.declaredType && s.value) {
      // A var list made from a literal can grow only as far as the literal is long; say so if it is collected.
      s.literalMost = type.most;
    }
    // One let or var declared in two arms has one type (§12.4, S315).
    if (sym && s.sameAs && sym.type && !T.isError(sym.type) && !T.isError(type) && !T.same(sym.type, type)) err("S315", s, `${s.name} is ${T.describe(sym.type)} where it is declared on line ${sym.line}; declared again in another branch, it must be the same`);
    else if (sym) sym.type = type;
  }

  function match(s, ctx) {
    const type = expr(s.subject, ctx);
    if (!T.isError(type) && type.t !== "option" && type.t !== "number" && !T.isTextLike(type)) err("S329", s.subject, `match chooses on an option, on words or on a number; ${describeExpr(s.subject)} is ${T.describe(type)}`);
    const seen = new Map();
    s.arms.forEach((arm, i) => {
      if (!arm.values) {
        if (i !== s.arms.length - 1) err("S330", arm, "else comes last in a match");
      } else {
        for (const v of arm.values) {
          // A value of the subject's kind: a number for a number, words for words or an option.
          const numeric = v.kind === "number";
          const shown = numeric ? V.words(v.value) : `"${v.value}"`;
          if (!T.isError(type) && numeric !== (type.t === "number")) {
            err("S329", v, `${describeExpr(s.subject)} is ${T.describe(type)}, and ${shown} is ${numeric ? "a number" : "words"}`);
            continue;
          }
          const key = numeric ? `#${shown}` : v.value;
          if (seen.has(key)) err("S331", v, `${shown} is in this match twice`, [{ file: v.file, span: seen.get(key).span, message: "first here" }]);
          seen.set(key, v);
          if (type.t === "option" && !type.set.options.some((o) => o.value === v.value)) err("S332", v, `${describeExpr(s.subject)} is never "${v.value}": it is ${either(type.set.options.map((o) => `"${o.value}"`))}`);
        }
      }
      block(arm.body, ctx);
    });
    if (type.t === "option" && !s.arms.some((a) => !a.values)) {
      const missing = type.set.options.filter((o) => !seen.has(o.value)).map((o) => `"${o.value}"`);
      s.missing = missing;
    }
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
    const type = expr(s.value, ctx);
    if (result.t === "none") err("S342", s.value, `${ctx.fn.name} is declared with no result; add -> ${T.describe(type)} after its parameters, or return nothing`);
    else if (!fitsAt(s.value, type, result)) err("S342", s.value, `${ctx.fn.name} gives ${T.describe(result)}, and this is ${T.describe(type)}`);
    else optionLiteral(s.value, result);
  }

  function assign(s, ctx) {
    const valueType = s.op ? binary({ kind: "binary", op: s.op, a: s.target, b: s.value, span: s.span, opSpan: s.opSpan, compound: true, file: s.file }, ctx) : expr(s.value, ctx, { allowNone: true });
    const target = s.target;
    let wanted = T.ERROR;
    // A function reads the program's names, and does not change them (§9.1).
    if (rootOf(target)?.symbol?.kept) {
      const name = rootOf(target).symbol.name;
      err("S204", target, `${name} is kept as it was when the function was made: the function reads it, and does not change it; give the new value back with return`);
      return;
    }
    if (ctx.fn && rootOf(target)?.symbol?.program) {
      const name = rootOf(target).symbol.name;
      err("S204", target, `${name} is the program's: a function reads it, and does not change it; give the new value back with return`);
      return;
    }
    if (target.kind === "name") {
      const sym = target.symbol;
      if (!sym) return;
      if (sym.kind !== "var") {
        const why = {
          answer: `${sym.name} is the person's answer; a program cannot change it`,
          let: `${sym.name} is a let, which keeps its first value; make it a var to change it`,
          const: `${sym.name} is a constant`,
          param: `${sym.name} is a parameter; copy it into a var to change it`,
          counter: `${sym.name} is the loop's counter`,
          item: `${sym.name} is an item of a list; change the list's var`,
          index: `${sym.name} is an item's number`,
        }[sym.kind] ?? `${sym.name} is ${what(sym)} and cannot be given a value`;
        err("S345", target, why);
        return;
      }
      if (sym.collectedBy) err("S346", target, `${sym.name} is collected on line ${sym.collectedBy.span.line}; its items are answers, which a program cannot change`);
      // The whole var given a value would change an answer asked into one of its fields (§7.5).
      const under = askedUnder(sym, "");
      if (under) err("S348", target, `${sym.name}.${under.path} is asked on line ${under.ask.span.line}; giving ${sym.name} a value would change that answer`);
      wanted = sym.type ?? T.ERROR;
      expr(target, ctx);
    } else if (target.kind === "field" || target.kind === "index") {
      wanted = expr(target, ctx);
      const root = rootOf(target);
      const sym = root?.symbol;
      if (sym && sym.kind !== "var") err(sym.kind === "item" && sym.collected ? "S346" : "S347", target, sym.kind === "item" && sym.collected ? `${sym.name} is a collected item; its fields are answers` : `only a var's fields and items can be given a value; ${sym.name} is ${what(sym)}`);
      if (sym && target.kind === "field") {
        const path = fieldPath(target);
        // The field itself asked, or a field inside it (§7.5): either answer would change.
        const under = path ? askedUnder(sym, path) : null;
        if (under) err("S348", target, `${sym.name}.${under.path} is asked on line ${under.ask.span.line}; an answer cannot be changed`);
      }
      if (sym?.collectedBy) err("S346", target, `${sym.name} is collected; its items are answers`);
    } else {
      err("S349", target, "only a var, a var's field or a var's item can be given a value");
      return;
    }
    if (valueType.t === "none") err("S350", s.value, `${describeExpr(s.value)} gives no value`);
    else if (!fitsAt(s.value, valueType, wanted)) err("S351", s.value, `${describeExpr(target)} is ${T.describe(wanted)}, and this is ${T.describe(valueType)}`);
    else optionLiteral(s.value, wanted);
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
    // The bare `empty` fits here as everywhere, and counts as no (§3.6, §6.15).
    if (type.t !== "yes-no" && type.t !== "empty" && !T.isError(type)) {
      if (T.isTextLike(type) || type.t === "option") err("S310", e, `${what} needs yes or no; ${describeExpr(e)} is ${T.describe(type)}: compare it (== "…") or test it (is not empty)`);
      else err("S311", e, `${what} needs yes or no, and this is ${T.describe(type)}`);
    }
  }

  function text(e, ctx, what) {
    const type = expr(e, ctx);
    if (!T.isTextLike(type) && !T.isError(type)) err(null, e, `${what} is words, not ${T.describe(type)}`);
  }

  // A literal compared with or given to an option must be one of its values.
  function optionLiteral(e, type) {
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
    if (wanted.t === "option" && T.isTextLike(type) && literalValues(e).length === 1 && e.kind === "string") return true;
    if (wanted.t === "options" && e.kind === "list" && e.items.every((x) => x.kind === "string" && literalValues(x).length === 1)) return true;
    return false;
  }

  function literalValues(e) {
    if (e.kind === "string" && e.parts.length <= 1 && (e.parts.length === 0 || typeof e.parts[0] === "string")) return [[e, e.parts[0] ?? ""]];
    if (e.kind === "list") return e.items.flatMap(literalValues);
    return [];
  }

  // `how.statement`: the call is a statement; `how.allowNone`: the context says itself what is wrong with a call that
  // gives no value (S324, S350, S356, S366, S371). Anywhere else such a call is S370.
  function expr(e, ctx, how = {}) {
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
      case "yes-no":
        return T.YES_NO;
      case "empty":
        return T.EMPTY;
      case "plain-string":
        return T.TEXT;
      case "string":
        for (const p of e.parts) {
          if (typeof p === "string") continue;
          const t = expr(p, ctx, { allowNone: true });
          if (["record", "list", "none"].includes(t.t)) err("S352", p, `{…} puts words, a number, a date or an option into words; this is ${T.describe(t)}`);
        }
        return T.TEXT;
      case "lambda": {
        // A function written in place (§9.11): what it keeps has the type it has here.
        const sym = e.symbol;
        for (const k of e.keeps) {
          const t = expr(k, ctx);
          sym.keeps.find((x) => x.kept === k.symbol && !x.type).type = t;
        }
        checkFunction(sym);
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
        if (ctx.fn && sym.program && !sym.type) {
          err("S202", e, `${sym.name} is read in ${ctx.fn.lambda ? "a function made" : `${ctx.fn.name}, which is called`} before the program defines ${sym.name}, on line ${sym.line ?? sym.node?.span?.line}`);
          return T.ERROR;
        }
        return sym.type ?? T.ERROR;
      }
      case "unary": {
        const t = expr(e.operand, ctx, { allowNone: true });
        if (t.t === "none") {
          err("S371", e.operand, `${describeExpr(e.operand)} gives no value`);
          return e.op === "-" ? T.NUMBER : T.YES_NO;
        }
        if (e.op === "-") {
          // `-empty` is empty (§6.3).
          if (t.t !== "number" && t.t !== "empty" && !T.isError(t)) err("S354", e, `- before a value is for numbers, and this is ${T.describe(t)}`);
          return T.NUMBER;
        }
        if (t.t !== "yes-no" && t.t !== "empty" && !T.isError(t)) err("S355", e, `not is for yes or no, and ${describeExpr(e.operand)} is ${T.describe(t)}`);
        return T.YES_NO;
      }
      case "is-empty": {
        const t = expr(e.operand, ctx, { allowNone: true });
        if (t.t === "none") err("S356", e.operand, `${describeExpr(e.operand)} gives no value`);
        return T.YES_NO;
      }
      case "binary":
        return binary(e, ctx);
      case "field": {
        const t = expr(e.target, ctx);
        if (T.isError(t)) return T.ERROR;
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
      case "index": {
        const t = expr(e.target, ctx);
        const i = expr(e.index, ctx);
        if (i.t !== "number" && i.t !== "empty" && !T.isError(i)) err("S358", e.index, `a list's item is chosen by its number (from 1), not ${T.describe(i)}`);
        if (T.isError(t)) return T.ERROR;
        if (t.t !== "list") {
          err("S359", e, `${describeExpr(e.target)} is ${T.describe(t)}, not a list${T.isTextLike(t) ? "; character(words, position) takes one character of words" : ""}`);
          return T.ERROR;
        }
        // A known position that is not a whole number of 1 or more (§6.9.2).
        const n = evaluate(e.index);
        if (V.isNumber(n)) {
          const k = V.whole(n);
          if (k === null || k < 1) err("S360", e.index, `a list's positions are whole numbers from 1; there is no item ${V.words(n)}`);
        }
        return t.element;
      }
      case "call":
        return call(e, ctx, how);
      case "list": {
        // The join of the items' types, left to right (§6.11, §3.9).
        let element = T.EMPTY;
        for (const item of e.items) {
          const t = expr(item, ctx);
          const j = T.join(element, t);
          if (!j) err("S361", item, `a list's items join into one type; this is ${T.describe(t)}, and the items before are ${T.describe(element)}`);
          else element = j;
        }
        // A literal's most is its number of items, at most 1000 (§3.7, §3.7.1).
        if (e.items.length > 1000) err("S213", e, `this list has ${e.items.length} items; a list holds at most 1000`);
        return T.list(element, Math.min(1000, Math.max(1, e.items.length)));
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
          if (i.t !== "number" && i.t !== "empty" && !T.isError(i)) err("S396", x, `a slice's bounds are numbers, not ${T.describe(i)}`);
        }
        if (T.isError(t)) return T.ERROR;
        if (t.t !== "list") {
          err("S359", e, `${describeExpr(e.target)} is ${T.describe(t)}, not a list${T.isTextLike(t) ? "; slice(words, from, to) takes part of words" : ""}`);
          return T.ERROR;
        }
        return t;
      }
      case "comprehension": {
        const l = expr(e.list, ctx);
        let most = 1;
        if (l.t === "list") {
          e.itemSymbol.type = l.element;
          most = l.most;
        } else if (l.t === "options") {
          e.itemSymbol.type = T.option(l.set);
          most = Math.max(1, l.set.options.length);
        } else if (l.t === "empty") {
          e.itemSymbol.type = T.EMPTY; // no items (§3.6)
          most = 0;
        } else {
          if (!T.isError(l)) err("S314", e.list, `for each goes through a list or a set of options; ${describeExpr(e.list)} is ${T.describe(l)}`);
          e.itemSymbol.type = T.ERROR;
        }
        if (e.condition) condition(e.condition, ctx, "a comprehension's if");
        const v = expr(e.value, ctx);
        if (v.t === "none") err("S366", e.value, `${describeExpr(e.value)} gives no value`);
        return T.list(v, most);
      }
      case "named-arg":
        return expr(e.value, ctx);
      case "new": {
        const sym = e.recordSymbol;
        const seen = new Set();
        for (const f of e.fields) {
          const t = expr(f.value, ctx);
          if (!sym) continue;
          const field = sym.decl.fields.find((x) => x.name === f.name);
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
    for (const a of e.args) expr(a.kind === "named-arg" ? a.value : a, ctx, { allowNone: true });
    for (const a of e.args) if (a.kind === "named-arg") a.type = a.value.type;
    const sym = e.target.symbol;
    if (!sym && !e.valueCall) return T.ERROR;
    // A call of a function a value holds (§9.10): its values in order, each of its parameter's type.
    if (e.valueCall) {
      const called = e.target.kind === "name" ? e.target.name : "the function";
      const t = expr(e.target, ctx);
      if (T.isError(t)) return T.ERROR;
      if (t.t !== "function") return (err("S228", e.target, `${e.target.kind === "name" ? e.target.name : "this"} is ${T.describe(t)}, not a function`), T.ERROR);
      if (e.args.some((a) => a.kind === "named-arg")) return (err("S388", e, `a function held in a name takes its values in order, without names`), T.ERROR);
      if (e.args.length !== t.params.length) return (err("S365", e, `${called} takes ${t.params.length} ${t.params.length === 1 ? "value" : "values"}, and is given ${e.args.length}`), T.ERROR);
      e.args.forEach((a, i) => {
        if (a.type && !T.isError(a.type) && !fitsAt(a, a.type, t.params[i])) err("S367", a, `${called}'s value ${i + 1} is ${T.describe(t.params[i])}, and this is ${T.describe(a.type)}`);
      });
      e.valueType = t;
      return t.result;
    }
    e.callee = sym;
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
    e.bound = bound.map((a, i) => a ?? { kind: "default-of", param: params[i], span: e.span, file: e.file, type: params[i].type });
    // §9.5.1: each argument whose parameter mentions a type parameter gives it a candidate; the binding is their join.
    const candidates = new Map();
    const ordered = []; // every candidate, for every type parameter, in the order the arguments are written
    // Each candidate remembers the argument it came from, for the place of S367.
    const collect = (want, got, from) => {
      if (want.t === "typevar") {
        if (got.t !== "empty") {
          candidates.set(want.sym, [...(candidates.get(want.sym) ?? []), { type: got, from }]);
          ordered.push({ tv: want.sym, type: got, from });
        }
      } else if (want.t === "list" && got.t === "list") collect(want.element, got.element, from);
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
      const before = joined.get(c.tv) ?? T.EMPTY;
      const next = T.join(before, c.type);
      if (!next) joinFailed ??= { tv: c.tv, before, value: c.type, from: c.from };
      else joined.set(c.tv, next);
    }
    for (const [tv, j] of joined) if (j.t !== "empty") bindings.set(tv, j);
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
    // Each argument is placed as its parameter's type with the type parameters bound (§9.5.1): with t bound to a
    // list of most 2, [1] given as a t is a list of most 2.
    if (bindings.size) e.placedAs = params.map((p) => T.substitute(p.type, bindings));
    // A type parameter the arguments do not tell (§9.5): S368, whatever the result's type.
    if ((sym.typeParams ?? []).some((tv) => !bindings.has(tv))) {
      err("S368", e, `the arguments do not tell what ${(sym.typeParams ?? []).filter((tv) => !bindings.has(tv)).map((tv) => tv.name).join(" and ")} is here (an empty list says nothing); give a value of the type`);
      result = T.ERROR;
    }
    const first = bound[0]?.type ?? T.ERROR;
    // A native whose result is its T (§14.4, §14.5): the arguments that hold T must tell it; the bare `empty` gives
    // no candidate (§9.5.1), so when all of them are empty, T is not told: S368.
    const TOLD_BY = { first: [0], last: [0], filled: [0], reversed: [0], sorted: [0], smallest: [0], largest: [0], either: [0, 1] };
    // An empty list says nothing either (S368): `[]` holds no item to tell T by.
    const tells = (t) => t && t.t !== "empty" && !(t.t === "list" && !tells(t.element));
    if (sym.kind === "native" && TOLD_BY[sym.name] && TOLD_BY[sym.name].every((i) => !tells(bound[i]?.type))) {
      err("S368", e, `the arguments do not tell what ${sym.name} gives (an empty list, or the bare empty, says nothing); give a value of the type`);
      return T.ERROR;
    }
    // either(a: T, b: T) -> T (§14.5): T is the join of its two arguments (§3.9, §9.5.1), or S367 when there is none.
    if (sym.kind === "native" && sym.name === "either" && bound.length === 2) {
      const j = T.join(first, bound[1]?.type ?? T.ERROR);
      if (!j) {
        err("S367", bound[1], `either's a is ${T.describe(first)}, and this is ${T.describe(bound[1].type)}: they have no type in common`);
        result = T.ERROR;
      } else result = j;
      e.joined = result;
    } else if (result.t === "any") result = first;
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
    const hasWords = (t) => T.isTextLike(t) || ["number", "date", "yes-no", "option", "empty", "error"].includes(t.t);
    // The list functions (§14.4) take a list, or a set of options; their value to look for is one of its items.
    const LIST_FUNCTIONS = ["count", "join", "first", "last", "filled", "index_of", "append", "without", "reversed", "sorted", "sum", "smallest", "largest"];
    const SET_FUNCTIONS = ["count", "join", "first", "last"];
    if (LIST_FUNCTIONS.includes(sym.name) && !element && l.t !== "empty") {
      err("S369", bound[0], `${sym.name} takes a list${SET_FUNCTIONS.includes(sym.name) ? " or a set of options" : ""}, and this is ${T.describe(l)}`);
      return;
    }
    // Only those whose entry says "or a set" take one (§14.4); the others keep a list's order, which a set has not.
    if (l.t === "options" && LIST_FUNCTIONS.includes(sym.name) && !SET_FUNCTIONS.includes(sym.name)) {
      err("S369", bound[0], `${sym.name} takes a list, and this is ${T.describe(l)}; count, join, first and last take a set`);
      return;
    }
    if (["index_of", "append", "without"].includes(sym.name) && element?.t === "option" && bound[1]) optionLiteral(bound[1], element);
    if (["index_of", "append", "without"].includes(sym.name) && element && bound[1]?.type && !T.isError(bound[1].type) && !T.join(element, bound[1].type)) err("S367", bound[1], `${sym.name} ${sym.name === "append" ? "adds" : "looks for"} one of the items, which are ${T.describe(element)}, and this is ${T.describe(bound[1].type)}`);
    if (sym.name === "sum" && element && !["number", "empty", "error"].includes(element.t)) err("S367", bound[0], `sum adds numbers up, and the items are ${T.describe(element)}`);
    if (sym.name === "join" && element && !hasWords(element)) err("S367", bound[0], `join puts items' words together, and the items are ${T.describe(element)}, which have no words`);
    // A set has words too: its options' values in declaration order (§3.5).
    if (sym.name === "text_of" && !hasWords(l) && l.t !== "options") err("S367", bound[0], `text_of gives a value's words, and ${T.describe(l)} has none`);
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
        // Lists join (§6.5.1): the join of the elements, the sum of the mosts.
        if (a.t === "list" || b.t === "list") {
          const x = a.t === "list" ? a : T.list(T.EMPTY, 0);
          const y = b.t === "list" ? b : T.list(T.EMPTY, 0);
          if ((a.t !== "list" && a.t !== "empty") || (b.t !== "list" && b.t !== "empty")) return err2("S373", `+ joins two lists, not ${T.describe(a)} and ${T.describe(b)}`);
          const element = T.join(x.element, y.element);
          // No join stands at the second value (§3.9 rule 5).
          if (!element) return (err("S373", e.b, `+ joins lists whose items join into one type; these hold ${T.describe(x.element)} and ${T.describe(y.element)}`), T.ERROR);
          const most = x.most + y.most;
          // A list holds at most 1000 (§3.7): more than that when the program runs is F017.
          return T.list(element, Math.min(most, 1000));
        }
        // Words of any kind, an option among them, join into text (§6.5).
        const wordy = (t) => T.isTextLike(t) || t.t === "option" || t.t === "empty";
        if (wordy(a) && wordy(b) && (a.t !== "empty" || b.t !== "empty")) return T.TEXT;
        // Empty beside a number adds as a number; two empties stay empty (§6.5).
        if (a.t === "empty" && (b.t === "number" || b.t === "empty")) return b;
        if (b.t === "empty" && a.t === "number") return a;
        if ((wordy(a) && b.t === "number") || (a.t === "number" && wordy(b))) return err2("S372", `+ adds two numbers or joins two words; to put a number into words, write "…{${describeExpr(a.t === "number" ? e.a : e.b)}}…"`);
        return err2("S373", `+ adds numbers or joins words, not ${T.describe(a)} and ${T.describe(b)}`);
      case "-":
      case "*":
      case "/":
      case "//":
      case "%":
        if (anyError) return T.NUMBER;
        if ((a.t === "number" || a.t === "empty") && (b.t === "number" || b.t === "empty")) return T.NUMBER;
        if (e.op === "-" && a.t === "date" && b.t === "date") return err2("S375", "dates are not subtracted; days_between(from, to) counts the days");
        return err2("S374", `${e.op} is for numbers, not ${T.describe(a)} and ${T.describe(b)}`);
      case "==":
      case "!=": {
        // A set compared with a list of words in quotes: the words are options of its set (§3.6, S386).
        if ((a.t === "options" && fitsAt(e.b, b, a)) || (b.t === "options" && fitsAt(e.a, a, b))) {
          if (a.t === "options") optionLiteral(e.b, a);
          else optionLiteral(e.a, b);
          return T.YES_NO;
        }
        if (!T.comparable(a, b)) {
          if ((a.t === "yes-no" && T.isTextLike(b)) || (b.t === "yes-no" && T.isTextLike(a))) {
            return err2("S376", `a yes-no answer is yes or no, without quotes: ${describeExpr(a.t === "yes-no" ? e.a : e.b)} == yes, or ${describeExpr(a.t === "yes-no" ? e.a : e.b)} alone as the condition`);
          }
          if (a.t === "options" || b.t === "options") return err2("S377", `${describeExpr(a.t === "options" ? e.a : e.b)} holds several options; ask if one is chosen with "…" in ${describeExpr(a.t === "options" ? e.a : e.b)}`);
          return err2("S378", `${T.describe(a)} and ${T.describe(b)} cannot be compared`);
        }
        if (a.t === "option") optionLiteral(e.b, a);
        if (b.t === "option") optionLiteral(e.a, b);
        return T.YES_NO;
      }
      case "<":
      case "<=":
      case ">":
      case ">=":
        if (!anyError && !T.ordered(a.t === "empty" ? b : a, b.t === "empty" ? a : b)) return err2("S379", `${e.op} orders two numbers, two dates or two words, not ${T.describe(a)} and ${T.describe(b)}`);
        return T.YES_NO;
      case "and":
      case "or":
        for (const [x, t] of [[e.a, a], [e.b, b]]) {
          if (t.t !== "yes-no" && t.t !== "empty" && !T.isError(t)) err("S380", x, `${e.op} joins two conditions (yes or no); ${describeExpr(x)} is ${T.describe(t)}`);
        }
        return T.YES_NO;
      case "in":
      case "not in":
        if (anyError) return T.YES_NO;
        if (b.t === "options") {
          if (a.t === "option" && a.set !== b.set) return err2("S381", `${describeExpr(e.a)} is one of ${a.set.name}, and ${describeExpr(e.b)} holds options of ${b.set.name}`);
          if (!T.isTextLike(a) && a.t !== "option" && a.t !== "empty") return err2("S382", `${e.op} asks whether an option is among ${describeExpr(e.b)}; this is ${T.describe(a)}`);
          optionLiteral(e.a, b);
          return T.YES_NO;
        }
        if (b.t === "list") {
          if (!T.fits(a, b.element) && !T.fits(b.element, a)) return err2("S383", `${describeExpr(e.b)} holds ${T.describe(b.element)}, and this is ${T.describe(a)}`);
          // Words looked for among options are one of the set's values (§3.6, S386).
          if (b.element.t === "option") optionLiteral(e.a, b.element);
          return T.YES_NO;
        }
        if (b.t === "empty") return T.YES_NO; // nothing is in empty (§3.6)
        if (T.isTextLike(b)) return err2("S384", `${e.op} asks about a set of options or a list; for words within words, contains(${describeExpr(e.b)}, ${describeExpr(e.a)})`);
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
      return `${describeExpr(e.target)}[${describeExpr(e.index)}]`;
    case "call":
      return `${describeExpr(e.target)}(…)`;
    case "number":
      return String(e.value);
    case "string":
      return e.parts.length === 1 && typeof e.parts[0] === "string" ? `"${e.parts[0]}"` : '"…"';
    case "yes-no":
      return e.value ? "yes" : "no";
    case "empty":
      return "empty";
    default:
      return "this";
  }
}
