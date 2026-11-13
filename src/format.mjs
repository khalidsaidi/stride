// `stride fmt`: one layout for every program. The source is parsed, and the tree printed back: two spaces of
// indent per block, one statement per line, one space around operators, a blank line kept where the source had
// one or more, parentheses only where the meaning needs them, `{` on the line it opens. Comments are kept where
// they stood: a comment on its own line goes before the statement after it, at that statement's indent; a
// comment after code stays at the end of that line.
//
// Brackets — a list, a map, a record made with `new`, a call's arguments, a function's parameters, a tuple — keep
// the line breaks their author wrote after the opening and before the closing bracket, and between items written
// an item a line; with a break before the closing bracket, the last item takes a comma and the bracket stands at
// the start of its own line. Other brackets stay on one line when it fits in LIMIT characters; else their items
// fill each line up to LIMIT, the next line two spaces in. Nothing joins a line past LIMIT.
//
// Formatting does not change what a program means: the formatted source parses to the same tree.
import { Diagnostics, SourceFile } from "./source.mjs";
import { parse } from "./parse.mjs";

// The comments of a source, outside words in quotes: { line, text, trailing } (trailing: code before it on its
// line).
// Words in quotes may hold {expressions}, which may hold words in quotes of their own: a stack of what each
// level is (a string, or an expression inside one) tells a # in code from a # in words.
export function comments(text) {
  const out = [];
  let line = 1;
  const stack = []; // "string" | "expr"
  let codeOnLine = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const top = stack[stack.length - 1];
    // Lines end at \n, \r\n or \r (§1.2).
    if (c === "\r" && text[i + 1] === "\n") continue;
    if (c === "\n" || c === "\r") {
      line++;
      codeOnLine = false;
      if (top === "string") stack.length = 0; // words in quotes end with their line
      continue;
    }
    if (top === "string") {
      if (c === "\\") i++;
      else if (c === '"') stack.pop();
      else if (c === "{") stack.push("expr");
      continue;
    }
    if (top === "expr" && c === "}") {
      stack.pop();
      continue;
    }
    if (c === '"') {
      stack.push("string");
      codeOnLine = true;
      continue;
    }
    if (c === "#") {
      const ends = [text.indexOf("\n", i), text.indexOf("\r", i)].filter((x) => x >= 0);
      const end = ends.length ? Math.min(...ends) : -1;
      const body = text.slice(i, end < 0 ? text.length : end).replace(/\s+$/, "");
      out.push({ line, text: body, trailing: codeOnLine });
      i = (end < 0 ? text.length : end) - 1;
      continue;
    }
    if (!/\s/.test(c)) codeOnLine = true;
  }
  return out;
}

// The longest line `stride fmt` makes by joining items of brackets (a line of a single item, or of words that
// cannot be broken, may be longer).
const LIMIT = 120;

// Brackets are printed first as words with marks in them (characters of Unicode's private use area, which a
// program's own words never hold as they are: escape() writes them as \u{…}); layout() then gives each line its
// breaks. OPEN and CLOSE stand around a bracket's items; SOFT between two items is a space, or a line break
// when the next item does not fit; HARD is the author's line break between two items; the edges stand after the
// opening and before the closing bracket: EDGE_NONE (nothing, or a break when the brackets break with nothing
// beside them), EDGE_SPACE (a space when the brackets are on one line: `new r { a: 1 }`), EDGE_HARD (the author's
// line break).
const OPEN = "\uE000", CLOSE = "\uE001", SOFT = "\uE002", HARD = "\uE003";
const OPEN_NONE = "\uE004", OPEN_SPACE = "\uE005", OPEN_HARD = "\uE006", CLOSE_NONE = "\uE007", CLOSE_SPACE = "\uE008", CLOSE_HARD = "\uE009";
const MARKS = /[\uE000-\uE009]/;
const FLAT = { [SOFT]: " ", [HARD]: " ", [OPEN_NONE]: "", [OPEN_SPACE]: " ", [OPEN_HARD]: "", [CLOSE_NONE]: "", [CLOSE_SPACE]: " ", [CLOSE_HARD]: "", [OPEN]: "", [CLOSE]: "" };

// A printed line's breaks: each pair of brackets on one line when it holds no author's break and fits, with
// what follows it up to the next place a line may break; else broken, its items two spaces in from the line
// it opens on.
function layout(line) {
  if (!MARKS.test(line)) return line;
  const tokens = line.split(/([\uE000-\uE009])/).filter((x) => x !== "");
  const closeOf = new Map(), hard = new Map(), stack = [];
  tokens.forEach((t, i) => {
    if (t === OPEN) stack.push(i);
    else if (t === CLOSE) {
      const o = stack.pop();
      closeOf.set(o, i);
      hard.set(o, tokens.slice(o, i).some((x) => x === HARD || x === OPEN_HARD || x === CLOSE_HARD || x.includes("\n")));
    }
  });
  const width = (from, to) => tokens.slice(from, to).reduce((n, t) => n + (t in FLAT ? FLAT[t].length : t.length), 0);
  // The words from a place up to where a line may next break: a SOFT, a HARD or a hard edge at any depth.
  // Outside every bracket, only the marks that close what stands before them count (`)`, `]`, `,`): words there
  // cannot break, and breaking brackets for them would not make the line fit.
  const depth = [];
  tokens.reduce((d, t, i) => ((depth[i] = d), t === OPEN ? d + 1 : t === CLOSE ? d - 1 : d), 0);
  const until = (from) => {
    let n = 0;
    for (let i = from; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === SOFT || t === HARD || t === OPEN_HARD || t === CLOSE_HARD) break;
      if (t.includes("\n")) return n + t.indexOf("\n");
      if (depth[i] === 0 && t !== OPEN && t !== CLOSE) return n + t.match(/^[^\s]*/)[0].length;
      n += t in FLAT ? FLAT[t].length : t.length;
    }
    return n;
  };
  // An item of brackets, from where it starts: its words up to the next item, or for the last one up to the
  // closing bracket and what follows it up to the next place a line may break.
  const item = (from) => {
    let n = 0, d = 0;
    for (let i = from; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === OPEN) d++;
      else if (t === CLOSE && --d < 0) return n + until(i + 1);
      else if (d === 0 && (t === SOFT || t === HARD)) return n;
      else if (t.includes("\n")) return n + t.indexOf("\n");
      else n += t in FLAT ? FLAT[t].length : t.length;
    }
    return n;
  };
  let out = "", col = 0, indent = line.match(/^ */)[0];
  const groups = []; // { flat, base, inner }
  const newline = (to) => {
    out = out.replace(/ +$/, "");
    out += `\n${to}`;
    col = to.length;
    indent = to;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const top = groups[groups.length - 1];
    if (t === OPEN) {
      const flat = (top?.flat ?? false) || (!hard.get(i) && col + width(i, closeOf.get(i)) + until(closeOf.get(i) + 1) <= LIMIT);
      groups.push({ flat, base: indent, inner: `${indent}  ` });
    } else if (t === CLOSE) groups.pop();
    else if (top?.flat && t in FLAT) out += FLAT[t], (col += FLAT[t].length);
    else if (t === HARD || t === OPEN_HARD) newline(top.inner);
    else if (t === CLOSE_HARD) newline(top.base);
    else if (t === SOFT) {
      // The next item goes on this line when the whole of it fits, with what follows it there.
      if (col + 1 + item(i + 1) <= LIMIT) (out += " "), col++;
      else newline(top.inner);
    } else if (t === OPEN_SPACE || t === CLOSE_SPACE) (out += " "), col++; // `new r { a: 1,` … `b: 2 }`
    else if (t in FLAT) continue; // any other edge of brackets that break with no break of the author's: nothing
    else {
      out += t;
      const nl = t.lastIndexOf("\n");
      if (nl < 0) col += t.length;
      else {
        col = t.length - nl - 1;
        indent = t.slice(nl + 1).match(/^ */)[0];
      }
    }
  }
  return out;
}

// How tightly each operator binds (§6.1): `if … then … else` loosest (0), a field, a position or a call tightest (8).
const PRECEDENCE = { "??": 0.75, or: 1, and: 2, not: 3, "==": 4, "!=": 4, "<": 4, "<=": 4, ">": 4, ">=": 4, in: 4, "not in": 4, "+": 5, "-": 5, "*": 6, "/": 6, "//": 6, "%": 6, neg: 7, "..": 4.5, "..<": 4.5, "**": 7.5 };

export function format(text, name = "program.stride") {
  const diagnostics = new Diagnostics();
  const file = new SourceFile(name, text);
  const start = name.endsWith(".test.stride") ? "Test" : /^\s*(#[^\n]*\n\s*)*form\s/.test(text) ? "Program" : "Library";
  const tree = parse(file, diagnostics, start);
  if (!tree) return { text: null, diagnostics };

  const notes = comments(text);
  let next = 0; // the next comment not printed yet
  const lines = [];
  let lastLine = 0; // the last source line printed
  let at = { indent: "", line: 0 }; // the statement being printed, for a function written in place inside it
  let inWords = 0; // inside words in quotes, where brackets stay on one line

  // Comments before a source line, each on its own line.
  function leading(beforeLine, indent) {
    while (next < notes.length && notes[next].line < beforeLine) {
      const c = notes[next++];
      if (c.trailing && lines.length) {
        lines[lines.length - 1] += ` ${c.text}`;
        continue;
      }
      if (c.line > lastLine + 1 && lines.length && lines[lines.length - 1] !== "") lines.push("");
      lines.push(`${indent}${c.text}`);
      lastLine = c.line;
    }
  }

  // A trailing comment on a source line, after the code printed for it.
  function trailing(onLine) {
    // A statement printed is over at the line it ends on: a blank line is kept only where the source had one after it.
    lastLine = Math.max(lastLine, onLine);
    while (next < notes.length && notes[next].line === onLine && notes[next].trailing) {
      lines[lines.length - 1] += ` ${notes[next++].text}`;
    }
  }

  function put(node, indent, text) {
    const line = node.span.line;
    leading(line, indent);
    if (line > lastLine + 1 && lines.length && lines[lines.length - 1] !== "") lines.push("");
    lines.push(indent + text);
    lastLine = line;
  }

  // ----- the file

  if (tree.kind === "program" && !tree.test) {
    put(tree.form, "", `form ${tree.form.value}`);
    trailing(tree.form.span.line);
    put(tree.pdf, "", `pdf ${tree.pdf.value}`);
    trailing(tree.pdf.span.line);
    if (tree.prefix) {
      put(tree.prefix, "", `fields ${plain(tree.prefix.value)}`);
      trailing(tree.prefix.span.line);
    }
  }
  for (const item of tree.items) item_(item, "");
  leading(Infinity, "");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return { text: `${lines.map(layout).join("\n")}\n`, diagnostics };

  // ----- brackets

  // The line a place in the source stands on.
  function lineOf(at) {
    return file.lineStarts.findLastIndex((x) => x <= at) + 1;
  }
  // Items between brackets, each printed by print, with the author's line breaks (see the top of the file). In
  // words in quotes, where a line cannot break, they are joined with spaces.
  function bracketed(open, close, items, print, { spaced = false, spans = (x) => x.span } = {}) {
    const edge = spaced ? " " : "";
    if (!items.length) return `${open}${close}`;
    const printed = items.map((x) => print(x));
    if (inWords) return `${open}${edge}${printed.join(", ")}${edge}${close}`;
    const first = spans(items[0]), last = spans(items[items.length - 1]);
    const openAt = text.lastIndexOf(open, first.start - 1);
    const closeAt = text.indexOf(close, last.end);
    const openHard = openAt >= 0 && lineOf(first.start) > lineOf(openAt);
    const closeHard = closeAt >= 0 && lineOf(closeAt) > lineOf(Math.max(last.start, last.end - 1));
    const breaks = items.slice(1).map((x, i) => lineOf(spans(x).start) > lineOf(Math.max(spans(items[i]).start, spans(items[i]).end - 1)));
    // Items an item a line keep their lines; items that fill lines are filled again, to the limit.
    const kept = breaks.every((b) => b);
    let body = printed[0];
    for (let i = 1; i < items.length; i++) body += `,${kept ? HARD : SOFT}${printed[i]}`;
    return `${open}${OPEN}${openHard ? OPEN_HARD : spaced ? OPEN_SPACE : OPEN_NONE}${body}${closeHard ? "," : ""}${closeHard ? CLOSE_HARD : spaced ? CLOSE_SPACE : CLOSE_NONE}${CLOSE}${close}`;
  }
  // Words printed with no marks: their length as one line.
  function flatLength(s) {
    return [...s].reduce((n, c) => n + (c in FLAT ? FLAT[c].length : 1), 0);
  }

  // ----- declarations and statements

  function item_(n, indent) {
    switch (n.kind) {
      case "import":
        put(n, indent, `import ${plain(n.path)}${n.alias ? ` as ${n.alias}` : ""}`);
        return trailing(n.span.line);
      case "record":
        put(n, indent, `${exp(n)}record ${n.name} {`);
        opening(n);
        // Fields and methods in the order written (§5.1).
        for (const f of [...n.fields, ...(n.methods ?? [])].sort((a, b) => a.span.start - b.span.start)) {
          if (f.kind === "function") {
            item_(f, `${indent}  `);
            continue;
          }
          put(f, `${indent}  `, `${f.name}: ${type(f.type)}${f.default ? ` = ${expr(f.default)}` : ""}`);
          if (n.span.line !== n.span.endLine) trailing(f.span.endLine);
        }
        return close(n, indent);
      case "enum":
        put(n, indent, `${exp(n)}enum ${n.name} {`);
        opening(n);
        for (const o of n.options) {
          put(o, `${indent}  `, `${plain(o.value)} ${str(o.printed)}`);
          if (n.span.line !== n.span.endLine) trailing(o.span.line);
        }
        return close(n, indent);
      case "const":
        put(n, indent, `${exp(n)}const ${n.name}${n.type ? `: ${type(n.type)}` : ""} = ${expr(n.value)}`);
        return trailing(n.span.endLine);
      case "native":
        put(n, indent, `${exp(n)}native function ${n.name}${params(n.params)}${n.result ? ` -> ${type(n.result)}` : ""}`);
        return trailing(n.span.endLine);
      case "function":
        put(n, indent, `${exp(n)}function ${n.name}${n.typeParams?.length ? `<${n.typeParams.map((t) => t.name).join(", ")}>` : ""}${params(n.params.filter((p) => !p.self || n.selfWritten))}${n.result ? ` -> ${type(n.result)}` : ""} {`);
        trailing(n.body.length && text.lastIndexOf("{", n.body[0].span.start) > n.span.start ? lineOf(text.lastIndexOf("{", n.body[0].span.start)) : n.span.line);
        block(n.body, `${indent}  `);
        return close(n, indent);
      default:
        return statement(n, indent);
    }
  }
  const DECLARATIONS = new Set(["import", "record", "enum", "const", "native", "function"]);

  // A comment after the opening line of a construct that is all on one line belongs after its closing brace. The
  // opening line ends at the brace before the first thing inside, which a header written over several lines puts
  // on a later line.
  function opening(n, inside = []) {
    if (n.span.line === n.span.endLine) return;
    const brace = inside.length ? text.lastIndexOf("{", inside[0].span.start) : -1;
    trailing(brace >= 0 && brace >= n.span.start ? lineOf(brace) : n.span.line);
  }

  function close(n, indent) {
    leading(n.span.endLine, `${indent}  `);
    lines.push(`${indent}}`);
    lastLine = n.span.endLine;
    trailing(n.span.endLine);
  }

  function block(list, indent) {
    for (const s of list) statement(s, indent);
  }

  function statement(s, indent) {
    if (s.hidden) return; // a name of `(a, b) = …`, written with the statement it belongs to
    at = { indent, line: s.span.line };
    switch (s.kind) {
      case "ask": {
        const q = s.question.set ? `${s.question.form} ${s.question.set}` : s.question.form;
        let head = `ask ${s.target.indexed ? expr(s.target.place) : s.target.names.join(".")}: ${q} ${str(s.printed)}`;
        const mods = s.modifiers.map((m) => (m.kind === "default" ? `default ${expr(m.value)}` : `check ${expr(m.condition)} ${str(m.message)}`));
        if (s.options) {
          put(s, indent, `${head} {`);
          trailing(s.span.line);
          for (const o of s.options) {
            put(o, `${indent}  `, `option ${plain(o.value)} ${str(o.printed)}`);
            trailing(o.span.line);
          }
          lines.push(`${indent}}${mods.length ? ` ${mods.join(" ")}` : ""}`);
          lastLine = s.span.endLine;
          return trailing(s.span.endLine);
        }
        // A check goes on its own line, indented, when the question is long.
        if (mods.length && flatLength(head + mods.join(" ")) + indent.length > 110) {
          put(s, indent, head);
          for (const m of mods) lines.push(`${indent}  ${m}`);
          lastLine = s.span.endLine;
          return trailing(s.span.endLine);
        }
        head += mods.length ? ` ${mods.join(" ")}` : "";
        put(s, indent, head);
        return trailing(s.span.endLine);
      }
      case "let":
      case "var":
        if (s.destructure) put(s, indent, `${s.destructure.kind === "assign" ? "" : `${s.destructure.kind} `}(${(s.destructure.names ?? s.destructure.targets.map((x) => expr(x))).join(", ")}) = ${expr(s.value)}`);
        else put(s, indent, `${s.kind} ${s.name}${s.type ? `: ${type(s.type)}` : ""}${s.value ? ` = ${expr(s.value)}` : ""}`);
        return trailing(s.span.endLine);
      case "fill":
        put(s, indent, `fill ${expr(s.box)} = ${expr(s.value)}`);
        return trailing(s.span.endLine);
      case "tick":
        put(s, indent, s.always ? `tick ${expr(s.box)}` : `tick ${expr(s.box)} when ${expr(s.condition)}`);
        return trailing(s.span.endLine);
      case "pick":
        put(s, indent, s.always ? `pick ${expr(s.box)} ${str(s.button)}` : `pick ${expr(s.box)} ${str(s.button)} when ${expr(s.condition)}`);
        return trailing(s.span.endLine);
      case "if":
        return ifChain(s, indent, "if");
      case "match":
        put(s, indent, `match ${expr(s.subject)} {`);
        opening(s, s.arms);
        for (const arm of s.arms) {
          put(arm, `${indent}  `, `${armValues(arm)} => {`);
          trailing(arm.span.line);
          block(arm.body, `${indent}    `);
          close(arm, `${indent}  `);
        }
        return close(s, indent);
      case "try":
        put(s, indent, "try {");
        opening(s, s.then);
        block(s.then, `${indent}  `);
        if (s.hasCatch !== false) {
          leading(s.catchLine, `${indent}  `);
          lines.push(`${indent}} catch ${s.caught ? `${s.caught.name} ` : ""}{`);
          lastLine = s.catchLine;
          trailing(s.catchLine);
          block(s.otherwise, `${indent}  `);
        }
        if (s.final) {
          leading(s.finallyLine, `${indent}  `);
          lines.push(`${indent}} finally {`);
          lastLine = s.finallyLine;
          trailing(s.finallyLine);
          block(s.final, `${indent}  `);
        }
        return close(s, indent);
      case "throw":
        put(s, indent, `throw ${expr(s.value)}`);
        return trailing(s.span.endLine);
      case "while":
        put(s, indent, `while ${expr(s.condition)} {`);
        opening(s, s.body);
        block(s.body, `${indent}  `);
        return close(s, indent);
      case "for":
        put(s, indent, `for ${s.counter} in ${expr(s.from)}${s.exclusive ? "..<" : ".."}${expr(s.to)} {`);
        opening(s, s.body);
        block(s.body, `${indent}  `);
        return close(s, indent);
      case "for-each":
        put(s, indent, `for ${s.destructure ? `(${s.destructure.join(", ")})` : `${s.index ? `${s.index}, ` : ""}${s.item}`} in ${expr(s.list)} {`);
        opening(s, s.body);
        block(s.body, `${indent}  `);
        return close(s, indent);
      case "collect":
        put(s, indent, `collect ${s.index ? `${s.index}, ` : ""}${s.item} in ${s.list}${s.any ? ` any ${str(s.any)}` : ""}${s.anotherWritten ? " another" : ""} ${str(s.another)} {`);
        opening(s, s.body);
        block(s.body, `${indent}  `);
        return close(s, indent);
      case "return":
        put(s, indent, s.value ? `return ${expr(s.value)}` : "return");
        return trailing(s.span.endLine);
      case "assign":
        put(s, indent, `${expr(s.target)} ${s.op ?? ""}= ${expr(s.value)}`);
        return trailing(s.span.endLine);
      case "call-statement":
        // A statement starts with a name or "(" (§7.14): what stood in brackets stays so.
        put(s, indent, s.call.parenthesised ? `(${expr(s.call)})` : expr(s.call));
        return trailing(s.span.endLine);
      case "break":
      case "continue":
        put(s, indent, s.kind);
        return trailing(s.span.endLine);
      case "expect":
        put(s, indent, `expect ${expr(s.value)}${s.fault ? ` faults ${str(s.fault)}` : s.message ? ` ${str(s.message)}` : ""}`);
        return trailing(s.span.endLine);
      default:
        // A declaration inside a block is a mistake (S025); printed as it is.
        if (DECLARATIONS.has(s.kind)) return item_(s, indent);
        throw new Error(`stride fmt has no layout for ${s.kind}`);
    }
  }

  // if … { } else if … { } else { }, with the closing brace and the else on one line.
  function ifChain(s, indent, word) {
    if (word === "if") put(s, indent, `if ${expr(s.condition)} {`);
    else {
      lines[lines.length - 1] += ` else if ${expr(s.condition)} {`;
      lastLine = s.span.line;
    }
    opening(s, s.then);
    block(s.then, `${indent}  `);
    const elseIf = s.otherwise.length === 1 && s.otherwise[0].kind === "if" && isElseIf(s);
    // Comments before the else belong to the then block; those after it, to the else block.
    leading(s.otherwise.length ? elseLine(s) : s.span.endLine, `${indent}  `);
    lines.push(`${indent}}`);
    if (elseIf) return ifChain(s.otherwise[0], indent, "else if");
    if (s.otherwise.length) {
      lines[lines.length - 1] += " else {";
      lastLine = elseLine(s);
      block(s.otherwise, `${indent}  `);
      leading(s.span.endLine, `${indent}  `);
      lines.push(`${indent}}`);
    }
    lastLine = s.span.endLine;
    trailing(s.span.endLine);
  }

  // The line the else of an if stands on.
  function elseLine(s) {
    const from = s.then.length ? s.then[s.then.length - 1].span.end : s.condition.span.end;
    const between = text.slice(from, s.otherwise[0].span.start);
    const at = between.search(/\belse\b/);
    return at < 0 ? s.otherwise[0].span.line : file.lineStarts.findLastIndex((x) => x <= from + at) + 1;
  }

  // An else holding only an if, written `else if`, not `else { if … }`.
  function isElseIf(s) {
    const inner = s.otherwise[0];
    const between = text.slice(s.then.length ? s.then[s.then.length - 1].span.end : s.condition.span.end, inner.span.start);
    return /else\s+$/.test(between) || /\}\s*else\s*$/.test(between);
  }

  // ----- types and expressions

  function exp(n) {
    return n.exported ? "export " : "";
  }

  function params(list) {
    return bracketed("(", ")", list, param);
  }

  function param(p) {
    return `${p.name}${p.type ? `: ${type(p.type)}` : ""}${p.default ? ` = ${expr(p.default)}` : ""}`;
  }

  function type(t) {
    switch (t.kind) {
      case "type-list":
        return `list<${type(t.element)}>`;
      case "type-map":
        return `map<${type(t.key)}, ${type(t.value)}>`;
      case "type-set":
        return `set<${type(t.element)}>`;
      case "type-tuple":
        return `(${t.elements.map(type).join(", ")})`;
      case "type-any":
        return "any";
      case "type-function":
        return `function(${t.params.map(type).join(", ")})${t.result ? ` -> ${type(t.result)}` : ""}`;
      case "type-name":
      case "type-param":
        return t.name;
      default:
        throw new Error(`stride fmt has no layout for the type ${t.kind}`);
    }
  }

  // An arm's values, or else.
  function armValues(arm) {
    return arm.values ? arm.values.map((v) => (v.kind === "number" ? v.raw : v.kind === "plain-string" ? plain(v.value) : expr(v, PRECEDENCE["??"]))).join(", ") : "else";
  }

  function expr(e, outer = 0) {
    const wrap = (p, s) => (p < outer ? `(${s})` : s);
    switch (e.kind) {
      case "lambda": {
        // A short function of one value (§9.12): (x) => x * 2.
        if (e.valueBody) return wrap(0.4, `(${e.params.map(param).join(", ")}) => ${expr(e.body[0].value ?? e.body[0].call)}`);
        // A function written in place: its body as a block, inside the statement it stands in.
        const mine = at;
        leading(mine.line, mine.indent);
        if (mine.line > lastLine + 1 && lines.length && lines[lines.length - 1] !== "") lines.push("");
        const head = e.short ? `${params(e.params)} =>` : `function${params(e.params)}${e.result ? ` -> ${type(e.result)}` : ""}`;
        const from = lines.length;
        lastLine = e.span.line;
        block(e.body, `${mine.indent}  `);
        leading(e.span.endLine, `${mine.indent}  `);
        const body = lines.splice(from);
        at = mine;
        lastLine = Math.max(lastLine, e.span.endLine);
        if (e.span.line === e.span.endLine && body.length === 1) return `${head} { ${body[0].trim()} }`;
        return `${head} {\n${body.join("\n")}\n${mine.indent}}`;
      }
      case "number":
        return e.raw ?? String(e.value);
      case "bool":
        return e.value ? "true" : "false";
      case "null":
        return "null";
      case "plain-string":
        return plain(e.value);
      case "string":
        return str(e);
      case "name":
        return e.name;
      case "unary":
        if (e.op === "not") return wrap(PRECEDENCE.not, `not ${expr(e.operand, PRECEDENCE.not)}`);
        return wrap(PRECEDENCE.neg, `-${expr(e.operand, PRECEDENCE.neg)}`);
      case "binary": {
        const p = PRECEDENCE[e.op];
        // A range has no spaces; one written in brackets keeps them (a slice's bound needs them, §6.9.3).
        if (e.op === ".." || e.op === "..<") {
          const range = `${expr(e.a, 5)}${e.op}${expr(e.b, 5)}`;
          return p < outer || e.parenthesised ? `(${range})` : range;
        }
        // a ** b takes its right side first: -a and a ** b stand there bare, and only a value stands on its left.
        if (e.op === "**") return wrap(p, `${expr(e.a, 8)} ** ${expr(e.b, PRECEDENCE.neg)}`);
        // Comparisons do not chain; arithmetic is left to right, so the right side of - and / needs parentheses
        // at the same precedence.
        const left = expr(e.a, p === 4 ? 4.5 : p);
        const right = expr(e.b, p === 4 ? 4.5 : p + (["-", "/", "+", "*", "//", "%"].includes(e.op) ? 1 : 0));
        return wrap(p, `${left} ${e.op} ${right}`);
      }
      case "field":
        return `${expr(e.target, 8)}${e.safe ? "?." : "."}${e.name}`;
      case "index":
        return e.position ? `${expr(e.target, 8)}.${e.index.raw}` : `${expr(e.target, 8)}[${expr(e.index)}]`;
      case "tuple":
        return bracketed("(", ")", e.items, (a) => expr(a));
      case "match-expr":
        // Written over several lines, an arm a line; else on one, the arms after commas.
        if (e.span.line !== e.span.endLine) {
          const indent = at.indent;
          return `match ${expr(e.subject)} {\n${e.arms.map((a) => `${indent}  ${armValues(a)} => ${expr(a.value)}`).join("\n")}\n${indent}}`;
        }
        return `match ${expr(e.subject)} { ${e.arms.map((a) => `${armValues(a)} => ${expr(a.value)}`).join(", ")} }`;
      case "slice":
        return `${expr(e.target, 8)}[${e.from.open ? "" : expr(e.from)}${e.exclusive ? "..<" : ".."}${e.to.open ? "" : expr(e.to)}]`;
      case "call":
        return `${e.target.parenthesised ? `(${expr(e.target)})` : expr(e.target, 8)}${e.typeArgs ? `<${e.typeArgs.map(type).join(", ")}>` : ""}${bracketed("(", ")", e.args, (a) => expr(a))}${e.keyAs ? ` as ${str(e.keyAs)}` : ""}`;
      case "named-arg":
        return `${e.name}: ${expr(e.value)}`;
      case "list":
        return bracketed("[", "]", e.items, (a) => expr(a));
      case "map":
        return bracketed("{", "}", e.entries, (x) => `${expr(x.key)}: ${expr(x.value)}`, { spans: (x) => ({ start: x.key.span.start, end: x.value.span.end }) });
      case "comprehension": {
        // Every `for`, outermost first, then the value of the last (§6.12.1); a map's as key: value (§6.12.2).
        const fors = [];
        let last = e;
        for (;;) {
          const w = last.written ?? last;
          const names = w.names ? `(${w.names.map((n) => n.name).join(", ")})` : `${last.index ? `${last.index}, ` : ""}${last.item}`;
          fors.push(`for ${names} in ${expr(w.list, PRECEDENCE["??"])}${w.condition ? ` if ${expr(w.condition, PRECEDENCE["??"])}` : ""}`);
          if (!last.nested) break;
          last = last.value;
        }
        const v = e.writtenValue ?? last.value;
        return e.asMap ? `{${expr(v.items[0])}: ${expr(v.items[1])} ${fors.join(" ")}}` : `[${expr(v)} ${fors.join(" ")}]`;
      }
      case "cond":
        return wrap(0.5, `if ${expr(e.condition)} then ${expr(e.yes)} else ${expr(e.no)}`);
      case "new":
        return `new ${e.type} ${bracketed("{", "}", e.fields, (f) => `${f.name}: ${expr(f.value)}`, { spaced: true })}`;
      default:
        throw new Error(`stride fmt has no layout for ${e.kind}`);
    }
  }

  function str(e) {
    if (e.kind === "plain-string") return plain(e.value);
    // Known words written as an expression (§7.9.1): a constant, an item of a constant list.
    if (e.parenthesised) return `(${expr(e)})`;
    if (e.kind !== "string") return expr(e);
    inWords++;
    try {
      return `"${e.parts.map((p) => (typeof p === "string" ? escape(p) : `{${expr(p)}}`)).join("")}"`;
    } finally {
      inWords--;
    }
  }

  function plain(v) {
    return `"${escape(v)}"`;
  }

  // Words as written in quotes (§1.7): \\, \", \n, \t, \r, \0 and the braces escaped, so they stay words.
  function escape(s) {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(/\0/g, "\\0").replace(/\{/g, "\\{").replace(/\}/g, "\\}")
      .replace(/[\u0000-\u001f\u007f\uE000-\uE009]/gu, (c) => `\\u{${c.codePointAt(0).toString(16)}}`);
  }
}
