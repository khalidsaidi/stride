// Phase 3: resolve names. Every name in every file is tied to the declaration it means, through scopes:
//
//   imports    what the standard library and every imported library export
//   module     a file's own records, option sets, constants and functions (declared before anything runs, so
//              they may be used before the line they stand on)
//   function   a function's parameters; inside it, its blocks
//   main       a program's statements, in order
//   block      the body of a loop or a collect
//
// An `if` and a `match` are not scopes, as in Python: a question asked in a branch is known after it (and is
// null when that branch did not run; the flow check sees to it that nothing reads it where it may not be
// asked). A function sees its module and its own names, not the program's answers: what it needs is passed.
//
// Inside a block, a name is known from the statement that defines it on; a name used before is a mistake that
// says where it is defined. Unknown names get the nearest known name as a hint.
import { KIND, nameSpan, didYouMean } from "./source.mjs";
import * as T from "./types.mjs";

let nextId = 1;

export class Sym {
  constructor(kind, name, node, unit) {
    this.id = nextId++;
    this.kind = kind; // record options const function native answer let var param counter item index module
    this.name = name;
    this.node = node;
    this.unit = unit;
    this.file = node?.file ?? unit?.file ?? null;
    this.exported = !!node?.exported;
    this.type = null; // set here for declarations, by the checker for the rest
  }

  get span() {
    return this.node?.span ?? null;
  }

  get line() {
    return this.node?.span?.line ?? 0;
  }
}

export class Scope {
  constructor(parent, kind, owner = null) {
    this.parent = parent;
    this.kind = kind; // imports module function main block
    this.owner = owner; // the function symbol a function scope belongs to
    this.names = new Map();
  }

  lookup(name) {
    for (let s = this; s; s = s.parent) if (s.names.has(name)) return s.names.get(name);
    return null;
  }

  own(name) {
    return this.names.get(name) ?? null;
  }

  // Every name visible from here, for "did you mean".
  visible() {
    const out = new Set();
    for (let s = this; s; s = s.parent) for (const n of s.names.keys()) out.add(n);
    return [...out];
  }

  // The function this scope is inside, or null in the program's main body.
  get function() {
    for (let s = this; s; s = s.parent) if (s.kind === "function") return s.owner;
    return null;
  }
}

const LOCAL_KINDS = new Set(["let", "var", "answer", "param", "counter", "item", "index"]);
// Words other languages write for Stride's values and types, and what Stride writes.
const OTHER_VALUES = { yes: "the value is written true", no: "the value is written false", True: "the value is written true", False: "the value is written false", empty: "no value is written null", None: "no value is written null", nil: "no value is written null", undefined: "no value is written null" };
const OTHER_TYPES = { text: "words are a string", str: "words are a string", String: "words are a string", boolean: "true and false are a bool", int: "numbers are a number", float: "numbers are a number" };
const DECLARATION_KINDS = new Set(["record", "enum", "const", "function", "native"]);
const SYM_KIND = { record: "record", enum: "enum", const: "const", function: "function", native: "native" };
const WHAT = {
  record: "a record",
  enum: "an option set",
  const: "a constant",
  function: "a function",
  native: "a function",
  answer: "a question's answer",
  let: "a let",
  var: "a var",
  param: "a parameter",
  counter: "a loop's counter",
  item: "an item",
  index: "an item's number",
  module: "a library",
  typevar: "a type parameter",
};
export const what = (sym) => WHAT[sym.kind] ?? sym.kind;

// Resolves every unit. Gives { units: [{ unit, scope, functions, natives, records, options, consts, main }] }
// where main (for the program only) is its statements, and every name node gets `.symbol`.
export function resolve(loaded, diagnostics) {
  const err = (code, file, span, message, notes) => diagnostics.add(KIND.NAME, file, span, message, notes, code);
  const typeNamed = new Set(); // names a declaration was refused for, being a type's (S208)
  const refusedAliases = new Set(); // use … as names refused by S110: their library's calls say nothing more
  const results = new Map(); // unit -> result
  const callableMembers = new Set(); // the names of records' methods and of their fields that hold a function (§9.8)
  let branch = []; // where resolution stands among ifs and matches (inBranch)
  // The scope whose finally block is being resolved, or null: a return there, or a break or continue of a loop
  // around the try, is refused (§7.18.2, S721).
  let finallyOf = null;

  for (const unit of loaded.units.concat([loaded.main])) {
    const imports = new Scope(null, "imports");
    const from = new Map(); // name -> the unit it was brought in from
    const bring = (other, useNode) => {
      const r = results.get(other);
      if (!r) return;
      for (const [name, sym] of r.scope.names) {
        if (!sym.exported) continue;
        if (imports.names.has(name) && imports.names.get(name) !== sym) {
          const first = from.get(name);
          err("S109", unit.file, useNode?.span ?? null, `${name} is exported by both ${first.file.name} and ${other.file.name}; a file can import only one of them`);
          continue;
        }
        imports.names.set(name, sym);
        from.set(name, other);
      }
    };
    if (loaded.std && unit !== loaded.std) bring(loaded.std, null);
    for (const use of unit.tree.items.filter((i) => i.kind === "import")) {
      if (!use.unit) continue;
      if (!use.alias) {
        bring(use.unit, use);
        continue;
      }
      // Kept under its name: p.full_name, p.person.
      const r = results.get(use.unit);
      const mod = new Sym("module", use.alias, use, unit);
      mod.exports = new Map([...(r?.scope.names ?? [])].filter(([, x]) => x.exported));
      mod.library = use.unit;
      // The name names this library from here on, so its uses say nothing more (§16.1).
      const was = imports.names.get(use.alias);
      if (was) err("S110", unit.file, use.span, was.kind === "module" ? `${use.alias} is already brought in by another import` : `${use.alias} is already ${what(was)} of ${was.unit?.std ? "the standard library" : was.file?.name ?? "a library"}; give the library another name`);
      // A refused name keeps what it named before, so its uses say nothing more (§16.1).
      if (!was || was.kind === "module") imports.names.set(use.alias, mod);
      else refusedAliases.add(use.alias);
    }

    const scope = new Scope(imports, "module");
    const result = { unit, scope, functions: [], lambdas: [], defaults: [], natives: [], records: [], options: [], consts: [], main: [] };
    results.set(unit, result);

    // Declarations first, so they may be used anywhere in the file.
    for (const item of unit.tree.items) {
      if (!DECLARATION_KINDS.has(item.kind)) continue;
      const sym = new Sym(SYM_KIND[item.kind], item.name, item, unit);
      item.symbol = sym;
      if (sym.exported && !unit.library) err("S107", unit.file, item.span, `export is for libraries; nothing imports a ${unit.test ? "test file" : "program"}, so ${item.name} needs no export`);
      if (item.kind === "native" && !unit.std) err("S108", unit.file, item.span, `only the standard library declares natives (functions written in the machine); write ${item.name} in Stride with function`);
      if (T.SCALARS[item.name] || ["one_of", "any_of"].includes(item.name)) {
        err("S208", unit.file, item.span, `${item.name} is the name of a type, and cannot be the name of ${what(sym)}`);
        // Its uses are of this refused name: S208 is all there is to say of them (§16.1).
        typeNamed.add(item.name);
        continue;
      }
      // A file's own declaration may hide what the standard library or a library brings in (§12.3); two of the
      // file's own may not share a name.
      const clash = scope.own(item.name);
      // A library's `as` name names nothing else (§4.5).
      if (imports.names.get(item.name)?.kind === "module") {
        err("S110", unit.file, item.span, `${item.name} names the library brought in by import … as ${item.name}; give ${what(sym)} another name`);
        continue;
      }
      if (!clash && imports.names.has(item.name)) imports.names.delete(item.name);
      if (clash) {
        const where = clash.unit === unit ? `on line ${clash.line}` : `in ${clash.file.name}, which this file imports`;
        err("S207", unit.file, item.span, `${item.name} is already ${what(clash)} ${where}`, [{ file: clash.file, span: clash.span, message: `${item.name} is defined here` }]);
        continue;
      }
      scope.names.set(item.name, sym);
      ({ record: result.records, enum: result.options, const: result.consts, function: result.functions, native: result.natives })[item.kind].push(sym);
    }

    // What declarations hold: option sets' options, records' fields, functions' signatures.
    for (const sym of result.consts) resolveExpr(sym.node.value, scope, unit);
    for (const sym of result.options) sym.type = T.option(optionSet(sym.node, unit, sym.name, false));
    for (const sym of result.records) sym.decl = { name: sym.name, fields: [], node: sym.node, sym };
    for (const sym of result.records) {
      const seen = new Map();
      for (const f of sym.node.fields) {
        if (seen.has(f.name)) {
          err("S218", unit.file, f.span, `${sym.name} has the field ${f.name} twice`);
          continue;
        }
        seen.set(f.name, f);
        sym.decl.fields.push({ name: f.name, type: resolveType(f.type, scope, unit), node: f });
        if (f.type.kind === "type-function") callableMembers.add(f.name);
        // A default is made of what the file declares (§5.1.1).
        if (f.default) resolveExpr(f.default, scope, unit);
      }
      sym.type = T.record(sym.decl);
      // Methods (§5.1.2): functions of the file, each with the record as its first parameter, self.
      sym.decl.methods = new Map();
      for (const m of sym.node.methods ?? []) {
        if (seen.has(m.name) || sym.decl.methods.has(m.name)) {
          err("S764", unit.file, m.nameSpan, `${sym.name} has ${seen.has(m.name) ? "a field" : "another method"} called ${m.name}`);
          continue;
        }
        const method = new Sym("function", `${sym.name}.${m.name}`, m, unit);
        method.method = m.name;
        method.record = sym;
        method.exported = sym.exported;
        m.symbol = method;
        sym.decl.methods.set(m.name, method);
        callableMembers.add(m.name);
        result.functions.push(method);
      }
    }
    for (const sym of result.consts) if (sym.node.type) sym.declaredType = resolveType(sym.node.type, scope, unit);
    for (const sym of [...result.functions, ...result.natives]) {
      const fnScope = new Scope(scope, "function", sym);
      sym.scope = fnScope;
      sym.params = [];
      if (sym.node.params.length > 255) err("S601", unit.file, sym.node.span, `${sym.name} has ${sym.node.params.length} parameters; a function has at most 255`);
      // Type parameters are types inside the function.
      sym.typeParams = [];
      for (const tp of sym.node.typeParams ?? []) {
        const tv = new Sym("typevar", tp.name, tp, unit);
        tv.type = T.typevar(tv);
        tp.symbol = tv;
        // A type's name cannot be one: a scalar's, or a record's or option set's this file sees (S220).
        const seen = scope.lookup(tp.name);
        if (fnScope.own(tp.name) || T.SCALARS[tp.name] || ["one_of", "any_of"].includes(tp.name) || ["record", "enum"].includes(seen?.kind)) {
          err("S220", unit.file, tp.span, `${tp.name} cannot be a type parameter's name here`);
          tv.reported = true;
        } else fnScope.names.set(tp.name, tv);
        sym.typeParams.push(tv);
      }
      for (const p of sym.node.params) {
        const param = new Sym("param", p.name, p, unit);
        param.type = p.self ? sym.record.type : resolveType(p.type, fnScope, unit, sym.kind === "native");
        // A default is worked out by the compiler: made of words, numbers and the file's constants (§9.2).
        if (p.default) {
          // Seen from the function, with no parameter in sight; resolved after the program's statements, whose
          // names it may read (§9.2).
          result.defaults.push([p.default, new Scope(scope, "function", sym)]);
          param.hasDefault = true;
        }
        p.symbol = param;
        if (fnScope.own(p.name)) err("S219", unit.file, p.span, `${sym.name} has two parameters called ${p.name}`);
        else {
          const outer = scope.lookup(p.name);
          // Native signatures have no body or local bindings (date_of's year parameter is alongside year()).
          if (sym.kind === "function" && outer?.kind === "module") err("S110", unit.file, p.span, `${p.name} names the library brought in by import … as ${p.name}; give the parameter another name`);
          fnScope.names.set(p.name, param);
        }
        sym.params.push(param);
      }
      sym.result = sym.node.result ? resolveType(sym.node.result, fnScope, unit, sym.kind === "native") : T.NONE;
      // No result type written and a return with a value: the checker works it out from the returns.
      if (!sym.node.result && sym.kind === "function" && givesValue(sym.node.body)) {
        sym.inferResult = true;
        sym.result = null;
      }
      for (const tv of sym.typeParams) if (!tv.reported && !sym.params.some((p) => T.typevarIn(p.type, tv))) err("S221", unit.file, tv.node.span, `${tv.name} is in none of ${sym.name}'s parameters, so no call could tell what it is`);
      sym.type = { t: "function", params: sym.params.map((p) => p.type), result: sym.result };
    }

    // Bodies: the program's own statements in order, then each function's (which may read the program's names).
    const statements = unit.tree.items.filter((i) => !DECLARATION_KINDS.has(i.kind) && i.kind !== "import");
    if (unit.library) {
      // An expect is a test file's (§7.17): S236 wherever else it stands.
      for (const s of statements) {
        if (s.kind === "expect") err("S236", unit.file, s.span, "expect belongs in a test file (<name>.test.stride)");
        else err("S106", unit.file, s.span, "a library holds only declarations (records, option sets, constants, functions); statements belong in a program");
      }
    } else {
      // S106 says all there is to say of such a statement: nothing more is reported of it as a statement (§16.1).
      if (unit.test) for (const s of statements.filter((s) => s.kind !== "let" && s.kind !== "expect")) (err("S106", unit.file, s.span, "a test file holds declarations, lets and expects (§4.3); other statements belong in a program"), (s.refused = true));
      const main = new Scope(scope, "main");
      result.mainScope = main;
      result.main = statements;
      resolveBlock(statements, main, unit);
    }
    for (const [d, s] of result.defaults) resolveExpr(d, s, unit);
    for (const sym of result.functions) resolveBlock(sym.node.body, sym.scope, unit);
    result.functions.push(...result.lambdas);
  }

  // ----- types

  // Whether a body returns a value somewhere.
  function givesValue(body) {
    for (const s of body) {
      if (s.kind === "return" && s.value) return true;
      const inner = s.kind === "if" ? [...s.then, ...s.otherwise] : s.kind === "try" ? [...s.then, ...s.otherwise, ...(s.final ?? [])] : s.kind === "match" ? s.arms.flatMap((a) => a.body) : ["for", "for-each", "collect", "while"].includes(s.kind) ? s.body : [];
      if (givesValue(inner)) return true;
    }
    return false;
  }

  function resolveType(node, scope, unit, native = false) {
    switch (node.kind) {
      case "type-any":
        if (!native) err("S214", unit.file, node.span, "any is only for the natives of the standard library");
        return T.ANY;
      case "type-function":
        return T.fn(node.params.map((p) => resolveType(p, scope, unit, native)), node.result ? resolveType(node.result, scope, unit, native) : T.NONE);
      case "type-name": {
        if (T.SCALARS[node.name]) return T.SCALARS[node.name];
        if (node.name === "element" && native) return T.ELEMENT;
        const sym = lookupQualified(scope, node.name);
        if (sym?.kind === "record") return sym.type ?? T.record(sym.decl);
        if (sym?.kind === "enum") return sym.type;
        if (sym?.kind === "typevar") return sym.type;
        // `range` is a type's name only where a type is written (§5.6): a function may be called range.
        if (node.name === "range") return T.RANGE;
        if (node.name === "error") return T.CAUGHT;
        if (node.name === "element") {
          err("S214", unit.file, node.span, "element is only for the natives of the standard library");
          return T.ERROR;
        }
        const types = [...Object.keys(T.SCALARS), ...visibleQualified(scope).filter((n) => ["record", "enum"].includes(lookupQualified(scope, n)?.kind))];
        err("S209", unit.file, node.span, sym ? `${node.name} is ${what(sym)}, not a type` : `there is no type called ${node.name}${OTHER_TYPES[node.name] ? `; ${OTHER_TYPES[node.name]}` : didYouMean(node.name, types)}`);
        return T.ERROR;
      }
      case "type-set": {
        // Several options of an option set (§3.8), or values of one type, each once (§3.12).
        if (!node.name) {
          const element = resolveType(node.element, scope, unit, native);
          if (!T.isError(element)) err("S210", unit.file, node.span, `a set holds an option set's options, words, numbers, dates or bools, not ${T.describe(element)}`);
          return T.ERROR;
        }
        if (T.SCALARS[node.name]) return T.set(T.SCALARS[node.name]);
        const sym = lookupQualified(scope, node.name);
        if (sym?.kind === "enum") return T.options(sym.type.set);
        if (sym?.kind === "typevar") return T.set(sym.type);
        const sets = scope.visible().filter((n) => scope.lookup(n)?.kind === "enum");
        err("S210", unit.file, node.span, sym ? `a set holds an option set's options, words, numbers, dates or bools, and ${node.name} is ${what(sym)}` : `there is no option set called ${node.name}${didYouMean(node.name, sets)}`);
        return T.ERROR;
      }
      case "type-tuple":
        return T.tuple(node.elements.map((x) => resolveType(x, scope, unit, native)));
      case "type-map": {
        const key = resolveType(node.key, scope, unit, native);
        const value = resolveType(node.value, scope, unit, native);
        if (!["string", "number", "date", "bool", "option", "typevar", "error"].includes(key.t)) err("S209", unit.file, node.key.span, `a map's keys are words, numbers, dates, bools or options, not ${T.describe(key)}`);
        return T.map(key, value);
      }
      case "type-list": {
        return T.list(resolveType(node.element, scope, unit, native));
      }
      default:
        throw new Error(`unknown type node ${node.kind}`);
    }
  }

  // An option set's options, from a declaration or a question's own block.
  function optionSet(node, unit, name, anonymous) {
    const set = { name, anonymous, options: [], node };
    const seen = new Map();
    for (const o of anonymous ? node : node.options) {
      if (seen.has(o.value)) {
        err("S215", unit.file, o.span, `the option "${o.value}" is there twice`, [{ file: unit.file, span: seen.get(o.value).span, message: "first here" }]);
        continue;
      }
      seen.set(o.value, o);
      if (o.value === "") err("S216", unit.file, o.span, "an option's value cannot be empty");
      set.options.push({ value: o.value, printed: o.printed, node: o });
    }
    // At least one option (§5.2).
    // A question's own options obey the same (§5.2).
    if (set.options.length < 1) err("S235", unit.file, anonymous ? (node[1000] ?? node[0])?.span ?? null : node.span, anonymous ? `the question declares ${set.options.length} options; it declares at least one` : `the option set ${name} declares ${set.options.length} options; it declares 1 to 1000`);
    return set;
  }

  // A record that holds itself (directly or through other records) could never be made.
  // ----- statements

  // The names a block defines, with their lines, including those inside its ifs and matches (which are not
  // scopes): for "used before it is defined".
  function laterNames(statements) {
    const out = new Map();
    const walk = (list) => {
      for (const s of list) {
        if (s.kind === "ask" && s.target.names.length === 1 && !out.has(s.target.names[0])) out.set(s.target.names[0], s);
        if ((s.kind === "let" || s.kind === "var") && !out.has(s.name)) out.set(s.name, s);
        if (s.kind === "if") (walk(s.then), walk(s.otherwise));
        if (s.kind === "match") for (const a of s.arms) walk(a.body);
      }
    };
    walk(statements);
    return out;
  }

  function resolveBlock(statements, scope, unit) {
    scope.later = laterNames(statements);
    scope.statements = statements;
    for (const s of statements) resolveStatement(s, scope, unit);
  }

  // Where resolution stands among the branches of ifs and matches: [{ node, arm }], outermost first. Two places
  // are on different paths when they part at some if or match into different arms.
  function leavesFinally(s, scope, unit) {
    for (let x = scope; x && finallyOf; x = x.parent) {
      if (x === finallyOf) {
        err("S721", unit.file, s.span, `${s.kind} cannot leave a finally block: the block runs to its end, and what the try was doing goes on after it`);
        return true;
      }
      if (x.kind !== "block" || (s.kind !== "return" && x.loop && x.loop !== "collect")) return false;
    }
    return false;
  }

  function inBranch(node, arm, f) {
    const saved = branch;
    branch = [...branch, { node, arm }];
    f();
    branch = saved;
  }
  function exclusive(a, b) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i].node !== b[i].node) return false;
      if (a[i].arm !== b[i].arm) return true;
    }
    return false;
  }

  function declare(scope, sym, unit) {
    // A name defined again hides the one before it from there on, as a name in a block hides one outside it.
    // Two questions of one name in one body would have one key (§8.6): that is S205.
    for (let s = scope; s && (s.kind === "block" || s.kind === "main" || s.kind === "function"); s = s.parent) {
      const clash = s.own(sym.name);
      if (clash && clash.kind === "answer" && sym.kind === "answer") {
        err("S205", unit.file, nameSpan(unit.file, sym.span, sym.name), `${sym.name} is already ${what(clash)}, defined on line ${clash.line}`, [{ file: clash.file, span: clash.span, message: `${sym.name} is defined here` }]);
        return false;
      }
      if (s.kind !== "block") break;
    }
    // A library's `as` name names nothing else (§4.5).
    const outer = scope.parent?.lookup(sym.name);
    if (outer?.kind === "module") {
      err("S110", unit.file, sym.span, `${sym.name} names the library brought in by import … as ${sym.name}; give ${what(sym)} another name`);
      // Its uses here are of this refused name, not of the library: S110 is all there is to say of them (§16.1).
      sym.type = T.ERROR;
      sym.refused = true;
      scope.names.set(sym.name, sym);
      return false;
    }
    scope.names.set(sym.name, sym);
    return true;
  }

  function resolveStatement(s, scope, unit) {
    switch (s.kind) {
      case "ask":
        return resolveAsk(s, scope, unit);
      case "let":
      case "var": {
        if (s.type) s.declaredType = resolveType(s.type, scope, unit);
        // A function written in place into a let or var goes by that name (its questions' keys, §8.6.2).
        if (s.value?.kind === "lambda") s.value.called = s.name;
        if (s.value) resolveExpr(s.value, scope, unit);
        // The same let or var declared in arms that exclude each other is one name (§12.4).
        const existing = scope.own(s.name);
        if (existing && existing.kind === s.kind && existing.branches?.every((b) => exclusive(b, branch))) {
          existing.branches.push(branch);
          existing.branchDeclared = true;
          s.symbol = existing;
          s.sameAs = existing;
          return;
        }
        const sym = new Sym(s.kind, s.name, s, unit);
        sym.branches = [branch];
        sym.branchDeclared = branch.length > 0;
        s.symbol = sym;
        declare(scope, sym, unit);
        return;
      }
      case "fill":
        resolveExpr(s.box, scope, unit);
        return resolveExpr(s.value, scope, unit);
      case "tick":
        resolveExpr(s.box, scope, unit);
        return resolveExpr(s.condition, scope, unit);
      case "pick":
        resolveExpr(s.box, scope, unit);
        resolveExpr(s.button, scope, unit);
        return resolveExpr(s.condition, scope, unit);
      case "if":
        resolveExpr(s.condition, scope, unit);
        inBranch(s, 0, () => s.then.forEach((t) => resolveStatement(t, scope, unit)));
        inBranch(s, 1, () => s.otherwise.forEach((t) => resolveStatement(t, scope, unit)));
        return;
      case "try":
        // Its two blocks are paths, as an if's; the error is a let of the catch.
        inBranch(s, 0, () => s.then.forEach((t) => resolveStatement(t, scope, unit)));
        inBranch(s, 1, () => {
          if (s.caught) {
            const sym = new Sym("let", s.caught.name, s.caught, unit);
            sym.type = T.CAUGHT;
            s.caught.symbol = sym;
            declare(scope, sym, unit);
          }
          s.otherwise.forEach((t) => resolveStatement(t, scope, unit));
        });
        if (s.final) {
          // The finally block's statements are the scope's own; what leaves it is refused (S721).
          const saved = finallyOf;
          finallyOf = scope;
          s.final.forEach((t) => resolveStatement(t, scope, unit));
          finallyOf = saved;
        }
        return;
      case "throw":
        return resolveExpr(s.value, scope, unit);
      case "match":
        resolveExpr(s.subject, scope, unit);
        for (const a of s.arms) for (const v of a.values ?? []) resolveExpr(v, scope, unit);
        s.arms.forEach((a, i) => inBranch(s, i, () => a.body.forEach((t) => resolveStatement(t, scope, unit))));
        return;
      case "while": {
        resolveExpr(s.condition, scope, unit);
        const inner = new Scope(scope, "block");
        inner.loop = "while";
        resolveBlock(s.body, inner, unit);
        return;
      }
      case "for": {
        resolveExpr(s.from, scope, unit);
        resolveExpr(s.to, scope, unit);
        const inner = new Scope(scope, "block");
        inner.loop = "for";
        const counter = new Sym("counter", s.counter, s, unit);
        counter.type = T.NUMBER;
        s.symbol = counter;
        declare(inner, counter, unit);
        resolveBlock(s.body, inner, unit);
        return;
      }
      case "for-each": {
        resolveExpr(s.list, scope, unit);
        const inner = new Scope(scope, "block");
        inner.loop = "for-each";
        if (s.index) {
          const index = new Sym("index", s.index, s, unit);
          index.type = T.NUMBER;
          s.indexSymbol = index;
          declare(inner, index, unit);
        }
        const item = new Sym("item", s.item, s, unit);
        s.itemSymbol = item;
        if (s.index === s.item) err("S231", unit.file, s.span, `${s.item} names both the item and its number; give them two names: for n, ${s.item} in …`);
        else declare(inner, item, unit);
        resolveBlock(s.body, inner, unit);
        return;
      }
      case "collect": {
        const list = lookupName(s.list, s, scope, unit);
        s.listSymbol = list;
        // Collected once (§8.5): a collect inside a loop the list is declared outside of would collect it again
        // in each turn.
        for (let at = scope; at && !at.names.has(s.list); at = at.parent) {
          if (at.loop) {
            err("S337", unit.file, s.span, `${s.list} is declared outside this ${at.loop === "for-each" ? "for" : at.loop}, so each turn would collect it again; declare it inside, or collect it once`);
            break;
          }
        }
        resolveExpr(s.another, scope, unit);
        if (s.any) resolveExpr(s.any, scope, unit);
        const inner = new Scope(scope, "block");
        inner.loop = "collect";
        // One name for the item and its number is S231, and the name is the item's: nothing more follows from it.
        const same = s.index && s.index === s.item;
        if (same) err("S231", unit.file, s.span, `${s.item} names both the item and its number; give them two names: collect n, ${s.item} in …`);
        if (s.index && !same) {
          const index = new Sym("index", s.index, s, unit);
          index.type = T.NUMBER;
          s.indexSymbol = index;
          declare(inner, index, unit);
        }
        const item = new Sym("item", s.item, s, unit);
        item.collected = true;
        s.itemSymbol = item;
        declare(inner, item, unit);
        resolveBlock(s.body, inner, unit);
        return;
      }
      case "return":
        if (s.value) resolveExpr(s.value, scope, unit);
        leavesFinally(s, scope, unit);
        return;
      case "break":
      case "continue": {
        if (leavesFinally(s, scope, unit)) return;
        // In the innermost for or while, not across a collect or a function (§7.12).
        let inLoop = false;
        for (let x = scope; x && x.kind === "block"; x = x.parent) {
          if (x.loop === "collect") {
            err("S234", unit.file, s.span, `${s.kind} cannot end a collect: it ends when the person says there is no other`);
            return;
          }
          if (x.loop === "for" || x.loop === "for-each" || x.loop === "while") {
            inLoop = true;
            break;
          }
        }
        if (!inLoop) err("S233", unit.file, s.span, `${s.kind} belongs inside a for or a while`);
        return;
      }
      case "expect":
        // An expect stands at the top level of a test file (§7.17): in a function, even a test file's, it is S236.
        let inFunction = false;
        for (let at = scope; at; at = at.parent) if (at.kind === "function") inFunction = true;
        if (!unit.test) err("S236", unit.file, s.span, "expect belongs in a test file (<name>.test.stride)");
        else if (inFunction) err("S236", unit.file, s.span, "expect stands at the top level of a test file, not inside a function");
        resolveExpr(s.value, scope, unit);
        if (s.message) resolveExpr(s.message, scope, unit);
        if (s.fault) resolveExpr(s.fault, scope, unit);
        return;
      case "assign":
        resolveExpr(s.target, scope, unit);
        return resolveExpr(s.value, scope, unit);
      case "call-statement":
        resolveExpr(s.call, scope, unit);
        if (s.call.kind !== "call" && !s.refused) err("S232", unit.file, s.span, "this is a value on its own; a statement asks, writes a box, gives a value (=) or calls a function");
        return;
      default:
        throw new Error(`unknown statement ${s.kind}`);
    }
  }

  function resolveAsk(s, scope, unit) {
    const [head, ...rest] = s.target.names;
    // Options: a named set, or the question's own.
    if (s.question.set) {
      const sym = lookupQualified(scope, s.question.set);
      if (sym?.kind === "enum") s.set = sym.type.set;
      else {
        const sets = scope.visible().filter((n) => scope.lookup(n)?.kind === "enum");
        err("S222", unit.file, s.question.span, sym ? `${s.question.set} is ${what(sym)}, not an option set` : `there is no option set called ${s.question.set}${didYouMean(s.question.set, sets)}`);
      }
      if (s.options) err("S223", unit.file, s.span, `${head} takes its options from ${s.question.set}; it cannot have its own as well`);
    } else if (s.question.form === "one_of" || s.question.form === "any_of") {
      if (!s.options?.length) err("S224", unit.file, s.question.span, `a ${s.question.form} question needs options: a block { option "value" "printed words" … }, or an option set after ${s.question.form}`);
      else s.set = optionSet(s.options, unit, head, true);
    } else if (s.options) {
      err("S225", unit.file, s.span, `a ${s.question.form} question has no options; one_of or any_of has`);
    }
    resolveExpr(s.printed, scope, unit);
    for (const o of s.set?.anonymous ? s.set.options : []) resolveExpr(o.printed, scope, unit);
    for (const m of s.modifiers) {
      if (m.kind === "default") resolveExpr(m.value, scope, unit);
    }
    if (rest.length) {
      // An answer into a record's field: the record is a collect's item or a var.
      const base = lookupName(head, s.target, scope, unit);
      s.target.symbol = base;
    } else {
      const existing = scope.lookup(head);
      if (existing?.kind === "item" && existing.collected) {
        s.target.symbol = existing; // a collect's item that is not a record: the answer is the item
      } else if (existing?.kind === "answer" && scope.own(head) === existing && existing.branches.every((b) => exclusive(b, branch))) {
        // The same question in another branch of an if or match (worded for that branch): the same answer.
        existing.branches.push(branch);
        s.symbol = existing;
        s.target.symbol = existing;
      } else {
        const sym = new Sym("answer", head, s, unit);
        sym.branches = [branch];
        s.symbol = sym;
        s.target.symbol = sym;
        declare(scope, sym, unit);
      }
    }
    // A check reads the answer, so it is resolved after the answer is defined.
    for (const m of s.modifiers) if (m.kind === "check") (resolveExpr(m.condition, scope, unit), resolveExpr(m.message, scope, unit));
  }

  // A name a function written in place reads from around it (§9.11): the program's top-level names as they are
  // when it runs, as any function reads them; a name of the function or the block around it as it was when the
  // function was made.
  function around(name, node, scope, unit) {
    let inner = null;
    for (let s = scope; s; s = s.parent) {
      if (s.names.has(name)) return inner ? { sym: s.names.get(name), inner } : null;
      if (s.kind === "function" && !inner) {
        if (!s.owner?.lambda) return null;
        inner = s;
      }
    }
    return null;
  }

  function lookupName(name, node, scope, unit) {
    const found = around(name, node, scope, unit);
    if (found && LOCAL_KINDS.has(found.sym.kind)) {
      const { inner } = found;
      // As the scope around the function sees it (a function in place inside another captures through it).
      const outer = lookupName(name, node, inner.parent, unit);
      if (!outer) return null;
      if (outer.program || (results.get(unit)?.mainScope?.own(name) === outer && ["let", "var", "answer"].includes(outer.kind))) {
        outer.program = true;
        return outer;
      }
      // A var is shared: the function and the code around it read and change the one var. Another name does
      // not change, so the function keeps its value.
      const kept = new Sym(outer.kind === "var" ? "var" : "param", name, outer.node, unit);
      kept.kept = outer;
      if (outer.kind === "var") outer.shared = kept.shared = true;
      inner.owner.keeps.push(kept);
      inner.names.set(name, kept);
      return kept;
    }
    const sym = scope.lookup(name);
    if (sym) return sym;
    const later = findLater(scope, name);
    const inner = later ? null : findInner(scope, name);
    const fn = scope.function;
    if (later) err("S202", unit.file, node.span, `${name} is used before it is defined, on line ${later.span.line}`, [{ file: unit.file, span: later.span, message: `${name} is defined here` }]);
    else if (inner) err("S203", unit.file, node.span, `${name} is defined inside the ${inner.kind === "collect" ? "collect" : "loop"} on line ${inner.span.line}, and is known only there`);
    // A function reads the program's own names (§9.1): an answer, a let, a var of its top level.
    else if (fn && ["let", "var", "answer"].includes(results.get(unit)?.mainScope?.own(name)?.kind)) {
      const outer = results.get(unit).mainScope.own(name);
      outer.program = true;
      return outer;
    } else err("S201", unit.file, node.span, `nothing called ${name} is defined here${OTHER_VALUES[name] ? `; ${OTHER_VALUES[name]}` : didYouMean(name, scope.visible())}`);
    return null;
  }

  // A name that may be qualified by a library brought in with `as`: person, or people.person.
  function lookupQualified(scope, name) {
    const dot = name.indexOf(".");
    if (dot < 0) return scope.lookup(name);
    const mod = scope.lookup(name.slice(0, dot));
    if (mod?.kind !== "module") return null;
    return mod.exports.get(name.slice(dot + 1)) ?? null;
  }

  // Every name visible from here, with those of libraries kept under a name: for "did you mean".
  function visibleQualified(scope) {
    const out = scope.visible();
    for (const n of [...out]) {
      const sym = scope.lookup(n);
      if (sym?.kind === "module") for (const k of sym.exports.keys()) out.push(`${n}.${k}`);
    }
    return out;
  }

  // A loop or collect of the blocks around here that defines the name inside it.
  function findInner(scope, name) {
    for (let s = scope; s; s = s.parent) {
      for (const st of s.statements ?? []) {
        if (!["for", "for-each", "collect", "while"].includes(st.kind)) continue;
        if (st.counter === name || st.item === name || st.index === name || laterNames(st.body).has(name)) return st;
      }
    }
    return null;
  }

  // The names the program's own statements define, for "a function does not see the program's answers".
  function mainNames(unit) {
    const r = results.get(unit);
    return r?.mainNames ?? (r ? (r.mainNames = laterNames(unit.tree.items.filter((i) => i.kind !== "import" && !DECLARATION_KINDS.has(i.kind)))) : new Map());
  }

  function findLater(scope, name) {
    for (let s = scope; s; s = s.parent) if (s.later?.has(name)) return s.later.get(name);
    return null;
  }

  // ----- expressions

  function resolveExpr(e, scope, unit) {
    if (!e || typeof e !== "object") return;
    switch (e.kind) {
      case "lambda": {
        // A function written in place: a function of the file with no name of its own, resolved where it stands.
        const r = results.get(unit);
        const sym = new Sym("function", e.called ?? "function", e, unit);
        sym.lambda = true;
        sym.keeps = []; // the names around it that it reads, kept as they were when it was made
        sym.referenced = true;
        const fnScope = new Scope(scope, "function", sym);
        sym.scope = fnScope;
        sym.params = [];
        sym.typeParams = [];
        // One put into a let or var may call itself by that name.
        if (e.called) fnScope.names.set(e.called, sym);
        for (const p of e.params) {
          const param = new Sym("param", p.name, p, unit);
          // A short function's parameter may leave its type to where the function stands (§9.12).
          param.type = p.type ? resolveType(p.type, scope, unit) : null;
          param.untyped = !p.type;
          if (p.default) err("S392", unit.file, p.span, "a function written in place is called through a value, so its parameters have no defaults");
          p.symbol = param;
          if (fnScope.own(p.name)) err("S219", unit.file, p.span, `the function has two parameters called ${p.name}`);
          else fnScope.names.set(p.name, param);
          sym.params.push(param);
        }
        sym.result = e.result ? resolveType(e.result, scope, unit) : T.NONE;
        if (!e.result && givesValue(e.body)) {
          sym.inferResult = true;
          sym.result = null;
        }
        resolveBlock(e.body, fnScope, unit);
        e.symbol = sym;
        // What it keeps, read where it stands.
        e.keeps = sym.keeps.map((k) => ({ kind: "name", name: k.name, symbol: k.kept, span: e.span, file: e.file }));
        r.lambdas.push(sym);
        return;
      }
      case "name":
        e.symbol = lookupName(e.name, e, scope, unit);
        if (e.symbol) e.symbol.referenced = true;
        if (e.symbol?.kind === "module") {
          err("S111", unit.file, e.span, `${e.name} is the library ${e.symbol.library.file.name}; name what it exports: ${e.name}.${[...e.symbol.exports.keys()][0] ?? "…"}`);
          e.symbol = null;
        }
        if (e.symbol?.kind === "record" || e.symbol?.kind === "enum") {
          err("S226", unit.file, e.span, `${e.name} is ${what(e.symbol)}, a type, not a value${e.symbol.kind === "record" ? `; new ${e.name} { … } makes one` : ""}`);
          e.symbol = null;
        }
        return;
      case "string":
        for (const p of e.parts) if (typeof p !== "string") resolveExpr(p, scope, unit);
        return;
      case "binary":
        resolveExpr(e.a, scope, unit);
        resolveExpr(e.b, scope, unit);
        return;
      case "unary":
        resolveExpr(e.operand, scope, unit);
        return;
      case "field": {
        // people.ROWS: a name a library exports, under the name it was brought in with.
        const mod = e.target.kind === "name" ? scope.lookup(e.target.name) : null;
        if (mod?.kind === "module") {
          const sym = mod.exports.get(e.name);
          const name = `${e.target.name}.${e.name}`;
          Object.assign(e, { kind: "name", name, target: undefined });
          if (!sym) err("S112", unit.file, e.span, `${mod.library.file.name} exports nothing called ${e.name.split(".").pop()}${didYouMean(name, visibleQualified(scope))}`);
          e.symbol = sym ?? null;
          return;
        }
        resolveExpr(e.target, scope, unit);
        return;
      }
      case "index":
        resolveExpr(e.target, scope, unit);
        resolveExpr(e.index, scope, unit);
        return;
      case "call":
        if (e.typeArgs) e.typeArgTypes = e.typeArgs.map((t) => resolveType(t, scope, unit));
        if (e.args.length > 255) err("S601", unit.file, e.span, `this call gives ${e.args.length} arguments; a call gives at most 255`);
        // What is called is a function's name, or any value that holds a function (§9.10): fs[1](2), (f)(2).
        if (e.target.parenthesised || !["name", "field"].includes(e.target.kind)) {
          e.valueCall = true;
          resolveExpr(e.target, scope, unit);
          for (const a of e.args) resolveExpr(a, scope, unit);
          return;
        }
        if (e.target.kind === "field") {
          const mod = e.target.target.kind === "name" ? scope.lookup(e.target.target.name) : null;
          if (mod?.kind === "module") {
            // people.full_name(…): a function a library exports.
            e.target = { kind: "name", name: `${e.target.target.name}.${e.target.name}`, span: e.target.span, file: e.target.file };
            const sym = mod.exports.get(e.target.name.split(".").pop());
            if (!sym || (sym.kind !== "function" && sym.kind !== "native")) err("S112", unit.file, e.target.span, `${mod.library.file.name} exports no function ${e.target.name.split(".").pop()}`);
            else e.target.symbol = sym;
            for (const a of e.args) resolveExpr(a, scope, unit);
            return;
          }
          // r.label(…) is label(r, …): a function called on its first argument.
          const receiver = e.target.target;
          const name = e.target.name;
          // A library kept under a name lends its functions to calls like this one: f.full() finds people's full.
          let sym = scope.lookup(name);
          if (!sym) {
            const mods = scope.visible().map((n) => scope.lookup(n)).filter((m) => m?.kind === "module");
            const found = mods.filter((m) => ["function", "native"].includes(m.exports.get(name)?.kind));
            if (found.length === 1) sym = found[0].exports.get(name);
            if (found.length > 1) {
              err("S113", unit.file, e.target.span, `${name} is a function of ${found.map((m) => m.name).join(" and of ")}; say which: ${found[0].name}.${name}(…)`);
              for (const a of e.args) resolveExpr(a, scope, unit);
              e.target = { kind: "name", name, span: e.target.span, file: e.target.file };
              return;
            }
          }
          e.method = true;
          // A record's own method, or a field that holds a function, goes before a function of the file (§9.8):
          // the type phase, which knows what the call is made on, chooses.
          const member = callableMembers.has(name);
          if (member) e.dot = e.target;
          // The call's place is the function's name (§16.3.1), not the value it is called on.
          e.target = { kind: "name", name, span: e.target.nameSpan ?? e.target.span, file: e.target.file };
          e.args = [receiver, ...e.args];
          if (receiver.kind === "name" && refusedAliases.has(receiver.name) && ["function", "native", undefined].includes(scope.lookup(receiver.name)?.kind)) {
            // a call of the library a refused `as` name was meant to bring in (S110)
            return;
          } else if (!sym || (sym.kind !== "function" && sym.kind !== "native")) {
            const fns = scope.visible().filter((n) => ["function", "native"].includes(scope.lookup(n)?.kind));
            const message = `there is no function called ${name} to call on ${receiver.kind === "name" ? receiver.name : "this"}${didYouMean(name, fns)}; a record's fields are read without ()`;
            if (member) e.noFunction = message;
            else err("S230", unit.file, e.target.span, message);
          } else e.target.symbol = sym;
          for (const a of e.args) resolveExpr(a, scope, unit);
          return;
        }
        {
          const sym = scope.lookup(e.target.name);
          if (!sym && typeNamed.has(e.target.name)) {
            // a declaration refused by S208
          } else if (!sym) {
            const fns = scope.visible().filter((n) => ["function", "native"].includes(scope.lookup(n)?.kind));
            err("S227", unit.file, e.target.span, `there is no function called ${e.target.name}${didYouMean(e.target.name, fns)}`);
          } else if (sym.kind !== "function" && sym.kind !== "native") {
            // A name that holds a function (§9.10): the type phase says whether it does.
            if (["param", "let", "var", "const", "item", "answer", "counter", "index"].includes(sym.kind)) {
              e.valueCall = true;
              resolveExpr(e.target, scope, unit);
            } else err("S228", unit.file, e.target.span, `${e.target.name} is ${what(sym)}, not a function`);
          } else e.target.symbol = sym;
        }
        for (const a of e.args) resolveExpr(a, scope, unit);
        return;
      case "list":
      case "tuple":
        for (const x of e.items) resolveExpr(x, scope, unit);
        return;
      case "match-expr":
        resolveExpr(e.subject, scope, unit);
        for (const a of e.arms) {
          for (const v of a.values ?? []) resolveExpr(v, scope, unit);
          resolveExpr(a.value, scope, unit);
        }
        return;
      case "map":
        for (const x of e.entries) (resolveExpr(x.key, scope, unit), resolveExpr(x.value, scope, unit));
        return;
      case "named-arg":
        resolveExpr(e.value, scope, unit);
        return;
      case "cond":
        resolveExpr(e.condition, scope, unit);
        resolveExpr(e.yes, scope, unit);
        resolveExpr(e.no, scope, unit);
        return;
      case "slice":
        resolveExpr(e.target, scope, unit);
        resolveExpr(e.from, scope, unit);
        resolveExpr(e.to, scope, unit);
        return;
      case "comprehension": {
        // [e for n, x in l if c]: the list is worked out outside; x and n are known only inside (§6.12).
        resolveExpr(e.list, scope, unit);
        const inner = new Scope(scope, "block");
        inner.loop = "comprehension";
        if (e.index) {
          const index = new Sym("index", e.index, e, unit);
          index.type = T.NUMBER;
          e.indexSymbol = index;
          declare(inner, index, unit);
        }
        // Named as a for.s are (§12.3, S231): no name defined twice, none hiding the file's declarations.
        const item = new Sym("item", e.item, e, unit);
        e.itemSymbol = item;
        if (e.index === e.item) err("S231", unit.file, e.span, `${e.item} names both the item and its number; give them two names: [… for n, ${e.item} in …]`);
        else declare(inner, item, unit);
        if (e.condition) resolveExpr(e.condition, inner, unit);
        resolveExpr(e.value, inner, unit);
        return;
      }
      case "new": {
        const sym = lookupQualified(scope, e.type);
        if (sym?.kind === "record") e.recordSymbol = sym;
        else {
          const recs = scope.visible().filter((n) => scope.lookup(n)?.kind === "record");
          err("S209", unit.file, e.span, sym ? `${e.type} is ${what(sym)}, not a record` : `there is no record called ${e.type}${didYouMean(e.type, recs)}`);
        }
        for (const f of e.fields) resolveExpr(f.value, scope, unit);
        return;
      }
      case "number":
      case "bool":
      case "null":
      case "plain-string":
        return;
      default:
        throw new Error(`unknown expression ${e.kind}`);
    }
  }

  return { units: [...results.values()], byUnit: results, mainResult: results.get(loaded.main) };
}

