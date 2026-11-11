// Stride's lexer and parser, written by hand: the lexer turns the source into tokens, the parser (recursive
// descent, one token of lookahead, precedence climbing for operators) turns the tokens into the syntax tree.
//
// Every node is { kind, span, … }, the span being where it stands: { line, col, endLine, endCol, start, end }, lines
// and columns from 1, offsets from 0, the end just after its last character.
//
// After a mistake the parser does not stop: it reports it, skips to the next statement or declaration (a
// keyword that starts one, at the start of a line, or a closing brace), and goes on, so one run reports every
// mistake it can (up to 20), not only the first. The tree is not used when there was a mistake.
//
// The grammar, in the notation of docs/grammar.md:
//
//   program     = header item*                 header = "form" id "pdf" sha ["fields" plain]
//   library     = item*
//   item        = use | declaration | statement
//   use         = "use" plain ["as" name]
//   declaration = ["export"] (record | options | const | native | define)
//   record      = "record" name "{" (name ":" type [","])* "}"
//   options     = "options" name "{" (["option"] plain string)* "}"
//   const       = "const" name [":" type] "=" expr
//   native      = "native" "define" name "(" [params] ")" "->" type
//   define      = "define" name ["<" name ("," name)* ">"] "(" [params] ")" ["->" type] block
//   type        = "list" "of" type ["most" expr] | "set" "of" qname | "any" | qname
//   statement   = ask | let | var | fill | tick | pick | if | match | for | foreach | collect | return
//               | assign | call
//   ask         = "ask" path ":" qtype string [options-block] ("default" expr | "check" expr string)*
//   if          = "if" expr block ["else" (if | block)]
//   match       = "match" expr "{" (plain ("," plain)* "=>" block | "else" "=>" block)* "}"
//   for         = "for" name "in" expr ".." expr block
//   while       = "while" expr block
//   foreach     = "for" "each" [name ","] name "in" expr block
//   collect     = "collect" [name ","] name "in" name ["any" string "another"] string block
//   expr        = or;  or = and ("or" and)*;  and = not ("and" not)*;  not = "not" not | compare
//   compare     = sum [("=="|"!="|"<"|"<="|">"|">="|"in"|"not" "in") sum | "is" ["not"] "empty"]
//   sum         = product (("+"|"-") product)*;  product = unary (("*"|"/") unary)*;  unary = "-" unary | postfix
//   postfix     = primary ("." name | "[" expr "]" | "(" [args] ")")*   (no line break before "[" or "(")
//   primary     = number | string | "yes" | "no" | "empty" | "[" [args] "]" | "new" qname "{" fields "}" | name
//               | "(" expr ")"
import { either } from "./source.mjs";
import * as D from "../runtime/decimal.mjs";

// The keywords (§2.3). `option`, `any`, `another` and `faults` are contextual (§2.3.1): names everywhere but the one
// place the grammar uses them.
export const KEYWORDS = new Set([
  "and", "as", "ask", "break", "check", "collect", "const", "continue", "default", "define", "else",
  "empty", "expect", "export", "fill", "for", "form", "if", "in", "is", "let", "match",
  "native", "new", "no", "not", "options", "or", "pdf", "pick", "record", "return", "tick",
  "use", "var", "while", "yes",
]);
// Words the grammar uses in one place only (§2.3.1): a type's `list`, `set`, `of` and `most`, the header's `fields`,
// `for each`, `when` and `then`. Anywhere else each is a name like any other.
const CONTEXTUAL = new Set(["each", "fields", "list", "most", "of", "set", "then", "when"]);
const HYPHENATED = new Set(["long-text", "yes-no", "one-of", "any-of"]);
const PUNCT = ["..", "==", "!=", "<=", ">=", "=>", "->", "+=", "-=", "*=", "/=", "//", "{", "}", "(", ")", "[", "]", ",", ":", ".", "=", "<", ">", "+", "-", "*", "/", "%"];
const STARTS = new Set(["use", "export", "record", "options", "const", "native", "define", "ask", "let", "var", "fill", "tick", "pick", "while", "if", "match", "for", "collect", "return", "break", "continue", "expect"]);

export class SyntaxMistake extends Error {
  constructor(message, span, code = "S010") {
    super(message);
    this.span = span;
    this.code = code; // docs/spec.md §16.4
  }
}

// How deep blocks, brackets and expressions may nest (§7.1, §15).
const MAX_DEPTH = 200;

// ----- the lexer

// Positions: an offset into the text, with its line and column, kept as the lexer goes.
class Cursor {
  constructor(text, at = 0, line = 1, col = 1) {
    this.text = text;
    this.at = at;
    this.line = line;
    this.col = col;
  }

  peek(n = 0) {
    return this.text[this.at + n];
  }

  // One character: a code point, so a character outside the Basic Multilingual Plane is one column (§1.3).
  next() {
    let c = this.text[this.at++];
    const code = c?.charCodeAt(0);
    if (code >= 0xd800 && code <= 0xdbff && this.at < this.text.length) {
      const low = this.text.charCodeAt(this.at);
      if (low >= 0xdc00 && low <= 0xdfff) c += this.text[this.at++];
    }
    if (c === "\n") (this.line++, (this.col = 1));
    else this.col++;
    return c;
  }

  get here() {
    return { line: this.line, col: this.col, offset: this.at };
  }
}

// The place one character on from a place on the same line: the end of a one-character span (§16.2).
const oneOn = (p) => ({ line: p.line, col: p.col + 1, offset: p.offset + 1 });
const spanOf = (from, to) => ({ line: from.line, col: from.col, endLine: to.line, endCol: to.col, start: from.offset, end: to.offset });

// Tokens: { type: name | keyword | number | string | punct | raw | end, value, span, broken (a line break before
// it) }. A string's value is its parts: text, or the tokens of an expression in {…}.
export function lex(text, cursor = new Cursor(text), until = null) {
  const tokens = [];
  let broken = true;
  for (;;) {
    // Whitespace and comments.
    while (cursor.at < text.length) {
      const c = cursor.peek();
      // Inside {…} in words in quotes, the words are still on one line (§2.6): a line end is S002, and a # is no
      // comment there.
      if (until && (c === "\n" || c === "\r")) throw new SyntaxMistake("these words in quotes have no closing quote on their line", spanOf(cursor.here, cursor.here), "S002");
      if (c === "\n") (broken = true), cursor.next();
      else if (c === " " || c === "\t" || c === "\r") cursor.next();
      else if (c === "#" && !until) while (cursor.at < text.length && cursor.peek() !== "\n") cursor.next();
      else break;
    }
    const from = cursor.here;
    if (cursor.at >= text.length) {
      tokens.push({ type: "end", value: null, span: spanOf(from, from), broken });
      return tokens;
    }
    const c = cursor.peek();
    if (until && c === until.close && until.depth === 0) {
      tokens.push({ type: "end", value: null, span: spanOf(from, from), broken });
      return tokens;
    }
    let token;
    const prev = tokens[tokens.length - 1];
    if (prev?.type === "keyword" && (prev.value === "form" || prev.value === "pdf") && !until) {
      // A form's id and a PDF's sha256 are read as they are written.
      let value = "";
      while (cursor.at < text.length && !/\s/.test(cursor.peek()) && cursor.peek() !== "#" && cursor.peek() !== '"') value += cursor.next();
      token = { type: "raw", value };
    } else if (/[A-Za-z_]/.test(c)) {
      let value = "";
      while (cursor.at < text.length && /[A-Za-z0-9_]/.test(cursor.peek())) value += cursor.next();
      // long-text, yes-no, one-of, any-of are one word.
      for (const h of HYPHENATED) {
        if (h.startsWith(`${value}-`) && text.startsWith(h.slice(value.length), cursor.at) && !/[A-Za-z0-9_]/.test(text[cursor.at + h.length - value.length] ?? "")) {
          for (let i = value.length; i < h.length; i++) cursor.next();
          value = h;
        }
      }
      token = { type: KEYWORDS.has(value) ? "keyword" : "name", value };
    } else if (/[0-9]/.test(c)) {
      let value = "";
      while (/[0-9]/.test(cursor.peek() ?? "")) value += cursor.next();
      if (cursor.peek() === "." && /[0-9]/.test(cursor.peek(1) ?? "")) {
        value += cursor.next();
        while (/[0-9]/.test(cursor.peek() ?? "")) value += cursor.next();
      }
      if (/[A-Za-z_]/.test(cursor.peek() ?? "")) {
        while (/[A-Za-z0-9_]/.test(cursor.peek() ?? "")) value += cursor.next();
        throw new SyntaxMistake(`"${value}" is not a number, and a name cannot start with a digit`, spanOf(from, cursor.here), "S007");
      }
      if (/^0\d/.test(value)) throw new SyntaxMistake(`${value} has a leading zero; an id with leading zeros is words: "${value}"`, spanOf(from, cursor.here), "S008");
      const significant = value.replace(".", "").replace(/^0+/, "").replace(/0+$/, "").length;
      const intDigits = value.split(".")[0].replace(/^0+/, "").length;
      if (significant > 34) throw new SyntaxMistake(`${value} has more than 34 significant digits; longer digits are an id: write them in quotes`, spanOf(from, cursor.here), "S009");
      if (intDigits > 34) throw new SyntaxMistake(`${value} is 10^34 or more; numbers stay below 10^34`, spanOf(from, cursor.here), "S009");
      const parsed = D.parseLiteral(value);
      if (parsed.error === "S009") throw new SyntaxMistake(`${value.length > 40 ? `${value.slice(0, 20)}…` : value} is finer than 10^-6176; numbers are multiples of 10^-6176`, spanOf(from, cursor.here), "S009");
      token = { type: "number", value: parsed.value ?? D.ZERO, raw: value };
    } else if (c === '"') {
      token = { type: "string", value: lexString(text, cursor) };
    } else {
      const p = PUNCT.find((x) => text.startsWith(x, cursor.at));
      if (!p) {
        if (cursor.at === 0 && text[0] === "\uFEFF") throw new SyntaxMistake("the file starts with a byte-order mark (U+FEFF); save it as UTF-8 without one", spanOf(from, (cursor.next(), cursor.here)), "S001");
        const ch = cursor.next();
        const why = /[^\x00-\x7f]/.test(ch) && /\p{L}/u.test(ch) ? `; names are written with a–z, A–Z, digits and _` : "";
        throw new SyntaxMistake(`"${ch}" is not understood here${why}`, spanOf(from, cursor.here), "S001");
      }
      for (let i = 0; i < p.length; i++) cursor.next();
      if (until && p === "{") until.depth++;
      if (until && p === "}") until.depth--;
      token = { type: "punct", value: p };
    }
    tokens.push({ ...token, span: spanOf(from, cursor.here), broken });
    broken = false;
  }
}

// Words in quotes: text with \" \\ \{ \} \n, and {expression}s, each lexed into tokens of its own.
function lexString(text, cursor) {
  const open = cursor.here;
  cursor.next();
  const parts = [];
  let buf = "";
  for (;;) {
    if (cursor.at >= text.length || cursor.peek() === "\n") throw new SyntaxMistake("these words in quotes have no closing quote on their line", spanOf(open, cursor.here), "S002");
    const c = cursor.peek();
    if (c === '"') {
      cursor.next();
      break;
    }
    if (c === "\\") {
      const at = cursor.here;
      cursor.next();
      const e = cursor.next();
      const map = { '"': '"', "\\": "\\", "{": "{", "}": "}", n: "\n", t: "\t" };
      if (e === "u") {
        // \u{h…}: one to six hexadecimal digits, at most 10FFFF, not a surrogate (§2.6).
        const m = text.slice(cursor.at).match(/^\{([0-9A-Fa-f]*)\}/);
        if (!m || m[1] === "") throw new SyntaxMistake(`\\u is written \\u{hex}, with one to six hexadecimal digits`, spanOf(at, cursor.here), "S003");
        for (let i = 0; i < m[0].length; i++) cursor.next();
        const n = parseInt(m[1], 16);
        if (m[1].length > 6 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) throw new SyntaxMistake(`\\u{${m[1]}} is not a character: one is \\u{0} to \\u{10FFFF}, not D800–DFFF`, spanOf(at, cursor.here), "S021");
        buf += String.fromCodePoint(n);
        continue;
      }
      if (!(e in map)) throw new SyntaxMistake(`\\${e} is not an escape in words in quotes; the ones there are \\" \\\\ \\{ \\} \\n \\t and \\u{hex}`, spanOf(at, cursor.here), "S003");
      buf += map[e];
      continue;
    }
    if (c === "{") {
      if (buf) parts.push(buf), (buf = "");
      const at = cursor.here;
      cursor.next();
      let inner;
      try {
        inner = lex(text, cursor, { close: "}", depth: 0 });
      } catch (e) {
        // Words that open inside the braces and run to the line's end: the brace is the one not closed.
        if (e instanceof SyntaxMistake && e.code === "S002") throw new SyntaxMistake("this { has no closing }", spanOf(at, oneOn(at)), "S005");
        throw e;
      }
      if (cursor.peek() !== "}") throw new SyntaxMistake("this { has no closing }", spanOf(at, cursor.here), "S005");
      cursor.next();
      parts.push({ tokens: inner, span: spanOf(at, cursor.here) });
      continue;
    }
    if (c === "}") throw new SyntaxMistake("a } in words in quotes is written \\}", spanOf(cursor.here, oneOn(cursor.here)), "S004");
    buf += cursor.next();
  }
  if (buf) parts.push(buf);
  return parts;
}

// ----- the parser

class Parser {
  constructor(tokens, mistakes, depth = 0) {
    this.tokens = tokens;
    this.at = 0;
    this.mistakes = mistakes;
    this.depth = depth; // how deep blocks, brackets and expressions nest here (§7.1)
  }

  // One level deeper; past 200, S019 at the first token beyond it.
  enter() {
    if (++this.depth > MAX_DEPTH) throw new SyntaxMistake(`blocks, brackets and expressions nest more than ${MAX_DEPTH} deep here; split it into functions or lets`, this.token.span, "S019");
  }

  leave() {
    this.depth--;
  }

  get token() {
    return this.tokens[this.at];
  }

  peek(n = 1) {
    return this.tokens[Math.min(this.at + n, this.tokens.length - 1)];
  }

  is(type, value) {
    const t = this.token;
    return t.type === type && (value === undefined || t.value === value);
  }

  word(value) {
    return this.is("keyword", value) || (CONTEXTUAL.has(value) && this.is("name", value));
  }

  sym(value) {
    return this.is("punct", value);
  }

  take() {
    const t = this.token;
    if (t.type !== "end") this.at++;
    return t;
  }

  // The token, of this type and value, or a mistake naming what was wanted.
  expect(type, value, what) {
    if (this.is(type, value) || (type === "keyword" && this.word(value))) return this.take();
    throw this.mistake(what ?? (value ? `"${value}"` : type));
  }

  mistake(expected) {
    const t = this.token;
    const found = t.type === "end" ? "the end of the file" : t.type === "string" ? "words in quotes" : `"${t.value}"`;
    // An "=" where none is wanted is a comparison written with one sign.
    if (t.type === "punct" && t.value === "=") return new SyntaxMistake(`"=" gives a value; to compare, write "=="`, t.span, "S011");
    return new SyntaxMistake(`${found} is not understood here; expected ${Array.isArray(expected) ? either(expected) : expected}`, t.span, "S010");
  }

  name(what = "a name (letters, digits and _)") {
    if (this.is("name")) {
      return this.take().value;
    }
    if (this.is("keyword")) throw new SyntaxMistake(`"${this.token.value}" is a word of the language, and cannot be a name`, this.token.span, "S013");
    throw this.mistake(what);
  }

  // A span from a token to the token before the current one.
  from(start) {
    const last = this.tokens[Math.max(this.at - 1, 0)];
    return { line: start.span.line, col: start.span.col, endLine: last.span.endLine, endCol: last.span.endCol, start: start.span.start, end: last.span.end };
  }

  node(kind, start, props) {
    return { kind, span: this.from(start), ...props };
  }

  // ----- files

  program() {
    const start = this.token;
    // No form line: a script (§4.6), run on its own; it writes no boxes.
    if (!this.word("form")) {
      const items = this.items(null);
      return { kind: "program", span: this.from(start), form: null, pdf: null, prefix: null, items, script: true };
    }
    const formTok = this.expect("keyword", "form", '"form" and the form\'s id');
    const idTok = this.expect("raw", undefined, "the form's id");
    // A bad id or sha256 is recorded, and the rest of the file is still read (§16.1).
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(idTok.value)) this.mistakes.push(new SyntaxMistake(`"${idTok.value}" is not a form id: letters, digits, ., - and _`, idTok.span, "S016"));
    const form = { kind: "form-id", value: idTok.value, span: { ...formTok.span, endLine: idTok.span.endLine, endCol: idTok.span.endCol, end: idTok.span.end } };
    const pdfTok = this.expect("keyword", "pdf", '"pdf" and the sha256 of the PDF');
    const shaTok = this.expect("raw", undefined, "the PDF's sha256 (64 hexadecimal digits)");
    if (!/^[0-9a-f]{64}$/.test(shaTok.value)) this.mistakes.push(new SyntaxMistake(`"${shaTok.value.slice(0, 20)}" is not a sha256: 64 hexadecimal digits, small letters`, shaTok.span, "S017"));
    const pdf = { kind: "pdf-id", value: shaTok.value, span: { ...pdfTok.span, endLine: shaTok.span.endLine, endCol: shaTok.span.endCol, end: shaTok.span.end } };
    let prefix = null;
    if (this.word("fields")) {
      this.take();
      prefix = this.plain();
    }
    const items = this.items(null);
    return { kind: "program", span: this.from(start), form, pdf, prefix, items };
  }

  library() {
    const start = this.token;
    const items = this.items(null);
    return { kind: "library", span: this.from(start), items };
  }

  // A test file (§4.3): no header; uses, declarations, lets and expects.
  testFile() {
    const start = this.token;
    const items = this.items(null);
    return { kind: "program", span: this.from(start), form: null, pdf: null, prefix: null, items, test: true };
  }

  // Items until the end (or a closing brace when `close`), recovering after each mistake.
  items(close) {
    const out = [];
    while (!this.is("end") && !(close && this.sym("}"))) {
      const before = this.at;
      try {
        out.push(this.item());
        this.ownLine();
      } catch (e) {
        if (!(e instanceof SyntaxMistake)) throw e;
        this.mistakes.push(e);
        if (this.mistakes.length >= 20) throw e;
        this.recover(before);
        // At the top, a closing brace recovery stopped at closed the construct the mistake was in.
        if (!close && this.sym("}")) this.take();
      }
    }
    return out;
  }

  // A statement ends where its line does (§7.1): the next one starts on a line of its own; a block's closing
  // brace may follow on the same line (`if c { print(1) }`).
  ownLine() {
    const last = this.tokens[this.at - 1], next = this.token;
    if (!last || next.type === "end" || (next.type === "punct" && next.value === "}")) return;
    // Only where another statement plainly starts: anything else is the mistake the statement itself reports.
    const starts = next.type === "name" || (next.type === "keyword" && STARTS.has(next.value));
    if (starts && next.span.line === last.span.endLine) this.mistakes.push(new SyntaxMistake("a statement starts on a line of its own", next.span, "S024"));
  }

  // On to the next statement or declaration: at the start of a line, a word that starts one, or a name (an
  // assignment or a call) once the brackets the broken statement opened are closed; or a closing brace (a block's
  // end). At least one token is skipped, so the parser always moves on.
  recover(before) {
    let brackets = 0;
    const count = (t) => {
      if (t.type !== "punct") return;
      if (t.value === "(" || t.value === "[") brackets++;
      if (t.value === ")" || t.value === "]") brackets = Math.max(0, brackets - 1);
    };
    // The braces the broken item opened are its own (a record's, a block's): recovery goes past their close.
    let depth = 0;
    for (let i = before; i < this.at; i++) {
      count(this.tokens[i]);
      const t = this.tokens[i];
      if (t.type === "punct" && t.value === "{") depth++;
      if (t.type === "punct" && t.value === "}") depth = Math.max(0, depth - 1);
    }
    if (this.at === before) count(this.take());
    while (!this.is("end")) {
      const t = this.token;
      if (t.type === "punct" && t.value === "{") depth++;
      if (t.type === "punct" && t.value === "}") {
        if (depth === 0) return;
        depth--;
        this.take();
        if (depth === 0 && this.token.broken) return;
        continue;
      }
      if (depth === 0 && t.broken && t.type === "keyword" && STARTS.has(t.value)) return;
      if (depth === 0 && brackets === 0 && t.broken && t.type === "name") return;
      count(this.take());
    }
  }

  item() {
    if (this.word("use")) return this.use();
    if (this.word("export") || this.word("record") || this.word("options") || this.word("const") || this.word("native") || this.word("define")) return this.declaration();
    return this.statement();
  }

  use() {
    const start = this.take();
    const file = this.plain();
    let alias = null;
    if (this.word("as")) {
      this.take();
      alias = this.name();
    }
    return this.node("use", start, { path: file.value, pathSpan: file.span, alias });
  }

  // ----- declarations

  declaration() {
    const start = this.token;
    const exported = this.word("export");
    if (exported) this.take();
    let d;
    if (this.word("record")) d = this.record();
    else if (this.word("options")) d = this.options();
    else if (this.word("const")) d = this.constant();
    else if (this.word("native")) d = this.native();
    else if (this.word("define")) d = this.define();
    else throw this.mistake(["record", "options", "const", "define"]);
    d.exported = exported;
    if (exported) d.span = this.from(start);
    return d;
  }

  record() {
    const start = this.take();
    const name = this.name();
    this.expect("punct", "{");
    const fields = [];
    while (!this.sym("}")) {
      const f = this.token;
      const fname = this.name("a field's name");
      this.expect("punct", ":", '":" and the field\'s type');
      const type = this.type();
      fields.push(this.node("field-decl", f, { name: fname, type }));
      if (this.sym(",")) this.take();
    }
    this.take();
    return this.node("record", start, { name, fields });
  }

  options() {
    const start = this.take();
    const name = this.name();
    this.expect("punct", "{");
    const options = [];
    while (!this.sym("}")) options.push(this.option(false));
    this.take();
    return this.node("options", start, { name, options });
  }

  option(required) {
    const start = this.token;
    // "option" is a word only here: a name elsewhere.
    if (this.is("name", "option")) this.take();
    else if (required) throw new SyntaxMistake(`a question's own option is written option "value" "printed words"`, this.token.span, "S022");
    const value = this.plain();
    const printed = this.string();
    return this.node("option", start, { value: value.value, printed });
  }

  constant() {
    const start = this.take();
    const name = this.name();
    let type = null;
    if (this.sym(":")) {
      this.take();
      type = this.type();
    }
    this.expect("punct", "=", '"=" and its value');
    const value = this.expr();
    return this.node("const", start, { name, type, value });
  }

  native() {
    const start = this.take();
    this.expect("keyword", "define");
    const name = this.name();
    const params = this.params();
    // Without -> type, a native gives no value (§5.5).
    let result = null;
    if (this.sym("->")) {
      this.take();
      result = this.type();
    }
    return this.node("native", start, { name, params, result });
  }

  define() {
    const start = this.take();
    const name = this.name();
    // Type parameters: define first_of<T>(l: list of T) -> T
    const typeParams = [];
    if (this.sym("<")) {
      this.take();
      do {
        if (this.sym(",")) this.take();
        const t = this.token;
        typeParams.push(this.node("type-param", t, { name: this.name("a type parameter's name") }));
      } while (this.sym(","));
      this.expect("punct", ">", '">"');
    }
    const params = this.params();
    let result = null;
    if (this.sym("->")) {
      this.take();
      result = this.type();
    }
    const body = this.block();
    return this.node("define", start, { name, typeParams, params, result, body });
  }

  params() {
    this.expect("punct", "(");
    const out = [];
    while (!this.sym(")")) {
      const p = this.token;
      const name = this.name("a parameter's name");
      this.expect("punct", ":", '":" and the parameter\'s type');
      const type = this.type();
      // A default: name: type = value (§9.2).
      let value = null;
      if (this.sym("=")) {
        this.take();
        value = this.expr();
      }
      out.push(this.node("param", p, { name, type, default: value }));
      if (!this.sym(")")) this.expect("punct", ",", '"," or ")"');
    }
    this.take();
    return out;
  }

  // ----- types

  type() {
    const start = this.token;
    if (this.word("list")) {
      this.take();
      this.expect("keyword", "of");
      const element = this.type();
      // Without a most, in a parameter: a list of any length.
      let most = null;
      if (this.word("most")) {
        this.take();
        most = this.expr();
      }
      return this.node("type-list", start, { element, most });
    }
    if (this.word("set")) {
      this.take();
      this.expect("keyword", "of");
      return this.node("type-set", start, { name: this.qname() });
    }
    if (this.is("name", "any")) {
      this.take();
      return this.node("type-any", start, {});
    }
    // function(number, text) -> yes-no: a function as a value (§9.10).
    if (this.is("name", "function") && this.peek().type === "punct" && this.peek().value === "(") {
      this.take();
      this.take();
      const params = [];
      while (!this.sym(")")) {
        params.push(this.type());
        if (!this.sym(")")) this.expect("punct", ",", '"," or ")"');
      }
      this.take();
      let result = null;
      if (this.sym("->")) {
        this.take();
        result = this.type();
      }
      return this.node("type-function", start, { params, result });
    }
    if (!this.is("name")) throw this.mistake("a type");
    return this.node("type-name", start, { name: this.qname() });
  }

  // A name, or a name in a library brought in with `as`: people.person.
  qname() {
    let name = this.name();
    if (this.sym(".") && this.peek().type === "name" && !this.token.broken) {
      this.take();
      name += `.${this.name()}`;
    }
    return name;
  }

  // ----- statements

  block() {
    this.expect("punct", "{", '"{"');
    this.enter();
    try {
      return this.blockBody();
    } finally {
      this.leave();
    }
  }

  blockBody() {
    const body = [];
    while (!this.sym("}")) {
      if (this.is("end")) throw this.mistake('"}"');
      const before = this.at;
      try {
        body.push(this.statement());
        this.ownLine();
      } catch (e) {
        if (!(e instanceof SyntaxMistake)) throw e;
        this.mistakes.push(e);
        if (this.mistakes.length >= 20) throw e;
        this.recover(before);
      }
    }
    this.take();
    return body;
  }

  statement() {
    const t = this.token;
    if (t.type === "keyword") {
      switch (t.value) {
        case "ask":
          return this.ask();
        case "let":
        case "var":
          return this.binding();
        case "fill":
          return this.fill();
        case "tick":
          return this.tick();
        case "pick":
          return this.pick();
        case "if":
          return this.ifStatement();
        case "match":
          return this.match();
        case "for":
          // for each x in …: `each`, then the item's name; a counter may itself be called each (for each in 1..3).
          return this.peek().value === "each" && this.peek().type === "name" && !(this.peek(2).type === "keyword" && this.peek(2).value === "in") ? this.forEach() : this.forLoop();
        case "while": {
          // while c { … }: the body again and again, as long as c is yes (§7.11.1).
          const start = this.take();
          const condition = this.condition();
          return this.node("while", start, { condition, body: this.block() });
        }
        case "collect":
          return this.collect();
        case "return":
          return this.returnStatement();
        case "break":
        case "continue":
          return (this.take(), this.node(t.value, t, {}));
        case "expect":
          return this.expectStatement();
        default:
          break;
      }
    }
    if (t.type === "name" || (t.type === "punct" && t.value === "(")) return this.assignOrCall();
    // A value on its own, whatever it starts with, is one statement name resolution refuses (S232).
    const value = ["number", "string"].includes(t.type) || (t.type === "punct" && ["[", "-"].includes(t.value)) || (t.type === "keyword" && ["yes", "no", "empty", "not", "new"].includes(t.value));
    const prevTok = this.tokens[this.at - 1];
    if (value && (t.broken || !prevTok || (prevTok.type === "punct" && prevTok.value === "{"))) return this.node("call-statement", t, { call: this.expr() });
    throw this.mistake(["a statement (ask, let, var, fill, tick, pick, if, match, for, while, collect, return, break, continue)", "a call"]);
  }

  // expect e ["words"]   expect e faults "code or words"   (§7.17)
  expectStatement() {
    const start = this.take();
    const value = this.expr();
    if (this.is("name", "faults")) {
      this.take();
      const fault = this.wordsOrName("the fault's code or words, in quotes, or a constant that holds them");
      return this.node("expect", start, { value, fault });
    }
    const message = this.is("string") ? this.string() : null;
    return this.node("expect", start, { value, fault: null, message });
  }

  ask() {
    const start = this.take();
    const p = this.token;
    const names = [this.name("the answer's name")];
    while (this.sym(".")) {
      this.take();
      names.push(this.name("a field's name"));
    }
    const target = this.node("path", p, { names });
    this.expect("punct", ":", '":" and the question\'s type');
    const q = this.token;
    const types = ["one-of", "any-of", "long-text", "yes-no", "text", "number", "date", "phone", "email"];
    if (!(this.is("name") && types.includes(q.value))) throw this.mistake(types.map((x) => `"${x}"`));
    this.take();
    let set = null;
    if ((q.value === "one-of" || q.value === "any-of") && this.is("name")) set = this.qname();
    const question = this.node("question-type", q, { form: q.value, set });
    const printed = this.wordsOrName("the question's printed words, in quotes, or a constant that holds them");
    let options = null;
    if (this.sym("{")) {
      this.take();
      options = [];
      while (!this.sym("}")) options.push(this.option(true));
      this.take();
    }
    const modifiers = [];
    for (;;) {
      const m = this.token;
      if (this.word("default")) {
        this.take();
        modifiers.push(this.node("default", m, { value: this.expr() }));
      } else if (this.word("check")) {
        this.take();
        const condition = this.expr();
        const message = this.wordsOrName("the check's message, in quotes, or a constant that holds them");
        modifiers.push(this.node("check", m, { condition, message }));
      } else break;
    }
    return this.node("ask", start, { target, question, printed, options, modifiers });
  }

  binding() {
    const start = this.take();
    const kind = start.value;
    const name = this.name();
    let type = null;
    if (this.sym(":")) {
      this.take();
      type = this.type();
    }
    let value = null;
    if (kind === "let" || this.sym("=")) {
      this.expect("punct", "=", '"=" and its value');
      value = this.expr();
    }
    return this.node(kind, start, { name, type, value });
  }

  fill() {
    const start = this.take();
    const box = this.wordsOrName("the box's name, in quotes, or a constant that holds it");
    this.expect("punct", "=", '"=" and what goes into the box');
    return this.node("fill", start, { box, value: this.expr() });
  }

  tick() {
    const start = this.take();
    const box = this.wordsOrName("the box's name, in quotes, or a constant that holds it");
    this.expect("keyword", "when", '"when" and a condition');
    return this.node("tick", start, { box, condition: this.condition() });
  }

  pick() {
    const start = this.take();
    const box = this.wordsOrName("the radio group's name, in quotes, or a constant that holds it");
    const button = this.wordsOrName("the button's name, in quotes, or a constant that holds it");
    this.expect("keyword", "when", '"when" and a condition');
    return this.node("pick", start, { box, button, condition: this.condition() });
  }

  condition() {
    return this.expr();
  }

  ifStatement() {
    const start = this.take();
    const condition = this.condition();
    const then = this.block();
    let otherwise = [];
    if (this.word("else")) {
      this.take();
      otherwise = this.word("if") ? [this.ifStatement()] : this.block();
    }
    return this.node("if", start, { condition, then, otherwise });
  }

  match() {
    const start = this.take();
    const subject = this.expr();
    this.expect("punct", "{");
    const arms = [];
    while (!this.sym("}")) {
      const a = this.token;
      let values = null;
      if (this.word("else")) this.take();
      else {
        // An arm's values: words in quotes, or numbers (§7.10).
        const value = () => {
          if (!this.is("number")) return this.plain("words in quotes, or a number");
          const t = this.take();
          return { kind: "number", value: t.value, raw: t.raw, span: t.span };
        };
        values = [value()];
        while (this.sym(",")) {
          this.take();
          values.push(value());
        }
      }
      this.expect("punct", "=>", '"=>" and a block');
      arms.push(this.node("arm", a, { values, body: this.block() }));
    }
    this.take();
    return this.node("match", start, { subject, arms });
  }

  forLoop() {
    const start = this.take();
    const counter = this.name("the loop's counter");
    this.expect("keyword", "in");
    const from = this.sum();
    this.expect("punct", "..", '".." and where the loop ends');
    const to = this.sum();
    return this.node("for", start, { counter, from, to, body: this.block() });
  }

  // `n, item` or `item`.
  indexAndItem() {
    const first = this.name();
    if (this.sym(",")) {
      this.take();
      return [first, this.name()];
    }
    return [null, first];
  }

  forEach() {
    const start = this.take();
    this.take();
    const [index, item] = this.indexAndItem();
    this.expect("keyword", "in");
    const list = this.expr();
    return this.node("for-each", start, { index, item, list, body: this.block() });
  }

  collect() {
    const start = this.take();
    const [index, item] = this.indexAndItem();
    this.expect("keyword", "in");
    const list = this.name("the list's name");
    let any = null;
    if (this.is("name", "any") && this.peek().type === "string") {
      this.take();
      any = this.wordsOrName("the question whether there are any, in quotes, or a constant that holds them");
    }
    if (this.is("name", "another") && this.peek().type === "string") this.take();
    const another = this.wordsOrName("the question whether there is another, in quotes, or a constant that holds them");
    return this.node("collect", start, { index, item, list, any, another, body: this.block() });
  }

  // A return's value is on its line: a bare return before the next line's statement has none.
  returnStatement() {
    const start = this.take();
    const value = this.token.broken || this.sym("}") || this.is("end") ? null : this.expr();
    return this.node("return", start, { value });
  }

  assignOrCall() {
    const start = this.token;
    const target = this.postfix();
    if (this.sym("=")) {
      this.take();
      return this.node("assign", start, { target, value: this.expr() });
    }
    // x += e is x = x + e with x's place worked out once (§7.5).
    for (const op of ["+=", "-=", "*=", "/="]) {
      if (this.sym(op)) {
        const opTok = this.take();
        return this.node("assign", start, { target, value: this.expr(), op: op[0], opSpan: opTok.span });
      }
    }
    if (this.sym("==")) throw new SyntaxMistake(`${"=="} on its own does nothing; to give a value, write "="`, this.token.span, "S023");
    // More of a value on the same line (x + 1, x and y): the whole value on its own (S232).
    if (!this.token.broken && !this.is("end") && !this.sym("}")) {
      this.at = this.tokens.indexOf(start);
      return this.node("call-statement", start, { call: this.expr() });
    }
    return this.node("call-statement", start, { call: target });
  }

  // ----- expressions

  expr() {
    this.enter();
    try {
      // if c then a else b (§6.13): the loosest expression.
      if (this.word("if")) {
        const start = this.take();
        const condition = this.expr();
        this.expect("keyword", "then", '"then" and a value');
        const yes = this.expr();
        this.expect("keyword", "else", '"else" and a value');
        const no = this.expr();
        return { kind: "cond", condition, yes, no, span: join(start.span, no.span) };
      }
      return this.or();
    } finally {
      this.leave();
    }
  }

  // a + b + c is (a + b) + c: each operator one level deeper (§7.1), so a chain of 201 is S019 at its 201st sign.
  binaryChain(next, ops) {
    let a = next();
    let levels = 0;
    try {
      while (ops.some((op) => this.is("keyword", op) || this.is("punct", op))) {
        this.enter();
        levels++;
        const opTok = this.take();
        const b = next();
        a = { kind: "binary", op: opTok.value, a, b, opSpan: opTok.span, span: join(a.span, b.span) };
      }
      return a;
    } finally {
      this.depth -= levels;
    }
  }

  or() {
    return this.binaryChain(() => this.and(), ["or"]);
  }

  and() {
    return this.binaryChain(() => this.not(), ["and"]);
  }

  not() {
    if (this.word("not")) {
      this.enter();
      try {
        const start = this.take();
        const operand = this.not();
        return this.node("unary", start, { op: "not", operand });
      } finally {
        this.leave();
      }
    }
    return this.compare();
  }

  compare() {
    const a = this.sum();
    const t = this.token;
    // One comparison: a second one after it, of any kind (an order, ==, in, is empty), is S014 at its operator.
    const once = (e) => {
      const n = this.token;
      const another = (n.type === "punct" && ["==", "!=", "<=", ">=", "<", ">"].includes(n.value)) || this.word("in") || this.word("is") || (this.word("not") && this.peek().type === "keyword" && this.peek().value === "in");
      if (another) throw new SyntaxMistake("comparisons do not chain: a < b < c is written a < b and b < c", n.span, "S014");
      return e;
    };
    if (t.type === "punct" && ["==", "!=", "<=", ">=", "<", ">"].includes(t.value)) {
      this.take();
      const b = this.sum();
      return once({ kind: "binary", op: t.value, a, b, span: join(a.span, b.span) });
    }
    if (this.word("in")) {
      this.take();
      const b = this.sum();
      return once({ kind: "binary", op: "in", a, b, span: join(a.span, b.span) });
    }
    if (this.word("not") && this.peek().type === "keyword" && this.peek().value === "in") {
      this.take();
      this.take();
      const b = this.sum();
      return once({ kind: "binary", op: "not in", a, b, span: join(a.span, b.span) });
    }
    if (this.word("is")) {
      this.take();
      const not = this.word("not");
      if (not) this.take();
      const end = this.expect("keyword", "empty", '"empty"');
      return once({ kind: "is-empty", not, operand: a, span: join(a.span, end.span) });
    }
    return a;
  }

  sum() {
    return this.binaryChain(() => this.product(), ["+", "-"]);
  }

  product() {
    return this.binaryChain(() => this.unary(), ["*", "/", "//", "%"]);
  }

  unary() {
    if (this.sym("-")) {
      this.enter();
      try {
        const start = this.take();
        const operand = this.unary();
        return this.node("unary", start, { op: "-", operand });
      } finally {
        this.leave();
      }
    }
    return this.postfix();
  }

  // Each field, position or call after a value is one level deeper (§7.1).
  postfix() {
    let e = this.primary();
    let levels = 0;
    try {
      return this.postfixes(e, () => (this.enter(), levels++));
    } finally {
      this.depth -= levels;
    }
  }

  postfixes(e, deeper) {
    for (;;) {
      const t = this.token;
      if ((this.sym(".") && this.peek().type === "name") || ((this.sym("[") || this.sym("(")) && !t.broken)) deeper();
      if (this.sym(".") && this.peek().type === "name") {
        this.take();
        const n = this.take();
        e = { kind: "field", name: n.value, target: e, span: join(e.span, n.span), nameSpan: n.span };
      } else if (this.sym("[") && !t.broken) {
        const open = this.take();
        const index = this.expr();
        if (this.sym("..")) {
          // l[a..b] (§6.9.3)
          this.take();
          const to = this.expr();
          const end = this.expect("punct", "]");
          e = { kind: "slice", from: index, to, target: e, opSpan: open.span, span: join(e.span, end.span) };
          continue;
        }
        const end = this.expect("punct", "]");
        e = { kind: "index", index, target: e, opSpan: open.span, span: join(e.span, end.span) };
      } else if (this.sym("(") && !t.broken) {
        this.take();
        const args = this.args(")", true);
        const end = this.expect("punct", ")", '"," or ")"');
        e = { kind: "call", args, target: e, span: join(e.span, end.span) };
      } else return e;
    }
  }

  // Arguments, or a list's items. In a call an argument may be named: name: value (§9.4).
  args(close, named = false) {
    const out = [];
    if (this.sym(close)) return out;
    const one = () => {
      if (named && this.is("name") && this.peek().type === "punct" && this.peek().value === ":") {
        const n = this.take();
        this.take();
        const value = this.expr();
        return { kind: "named-arg", name: n.value, value, span: join(n.span, value.span) };
      }
      return this.expr();
    };
    out.push(one());
    while (this.sym(",")) {
      this.take();
      out.push(one());
    }
    return out;
  }

  primary() {
    const t = this.token;
    if (t.type === "number") return (this.take(), { kind: "number", value: t.value, raw: t.raw, span: t.span });
    if (t.type === "string") return this.string();
    if (t.type === "keyword") {
      if (t.value === "yes" || t.value === "no") return (this.take(), { kind: "yes-no", value: t.value === "yes", span: t.span });
      if (t.value === "empty") return (this.take(), { kind: "empty", span: t.span });
      if (t.value === "new") {
        const start = this.take();
        const type = this.qname();
        this.expect("punct", "{");
        const fields = [];
        while (!this.sym("}")) {
          const f = this.token;
          const name = this.name("a field's name");
          this.expect("punct", ":");
          fields.push(this.node("field-value", f, { name, value: this.expr() }));
          if (this.sym(",")) this.take();
        }
        this.take();
        return this.node("new", start, { type, fields });
      }
    }
    if (t.type === "name") return (this.take(), { kind: "name", name: t.value, span: t.span });
    if (this.sym("[")) {
      const start = this.take();
      const items = this.args("]");
      // [e for each [n,] x in l if c] (§6.12)
      if (items.length === 1 && this.word("for") && this.peek().type === "name" && this.peek().value === "each") {
        this.take();
        this.take();
        const [index, item] = this.indexAndItem();
        this.expect("keyword", "in");
        const list = this.or();
        let condition = null;
        if (this.word("if")) {
          this.take();
          condition = this.or();
        }
        this.expect("punct", "]", '"]"');
        return this.node("comprehension", start, { value: items[0], index, item, list, condition });
      }
      this.expect("punct", "]", '"," or "]"');
      return this.node("list", start, { items });
    }
    if (this.sym("(")) {
      const start = this.take();
      const e = this.expr();
      this.expect("punct", ")", '")"');
      // `bareSpan`: the expression without its brackets, the smallest construct a mistake in it names (§16.2.1).
      return { ...e, span: this.from(start), bareSpan: e.bareSpan ?? e.span, parenthesised: true };
    }
    if (t.type === "punct" && ["+", "-", "*", "/", "<", ">", "==", "!="].includes(t.value)) throw this.mistake("a value");
    // A line that ends on an operator (S015), whatever the next line starts with.
    const before = this.tokens[this.at - 1];
    const onOperator = t.broken && before?.type === "punct" && ["+", "-", "*", "/", "//", "%", "<", "<=", ">", ">=", "==", "!="].includes(before.value);
    if (this.is("end") || (t.broken && t.type === "keyword") || onOperator) {
      const prev = this.tokens[this.at - 1];
      throw new SyntaxMistake(prev?.type === "punct" ? `"${prev.value}" at the end of the line needs a value after it` : "the line ended where a value was expected", prev?.span ?? t.span, prev?.type === "punct" ? "S015" : "S010");
    }
    throw this.mistake("an expression");
  }

  // Words in quotes, with {expression}s: { kind: "string", parts }.
  // Words a statement takes (§7.9): in quotes, or an expression that starts with a
  // name and gives them (a constant, an item of a constant list).
  wordsOrName(what) {
    if (!this.is("name")) return this.string(what);
    return this.expr();
  }

  string(what = "words in quotes") {
    if (!this.is("string")) throw this.mistake(what);
    const t = this.take();
    const parts = t.value.map((p) => {
      if (typeof p === "string") return p;
      const inner = new Parser(p.tokens, this.mistakes, this.depth);
      if (inner.is("end")) throw new SyntaxMistake("{} holds nothing; put a value in it", p.span, "S006");
      const e = inner.expr();
      if (!inner.is("end")) throw inner.mistake('"}"');
      return e;
    });
    return { kind: "string", parts, span: t.span };
  }

  // Words in quotes with nothing put in.
  plain(what = "words in quotes") {
    if (!this.is("string")) throw this.mistake(what);
    const t = this.token;
    if (t.value.some((p) => typeof p !== "string")) throw new SyntaxMistake("{…} cannot go in these words: they must be plain", t.span, "S018");
    this.take();
    return { kind: "plain-string", value: t.value.join(""), span: t.span };
  }
}


function join(a, b) {
  return { line: a.line, col: a.col, endLine: b.endLine, endCol: b.endCol, start: a.start, end: b.end };
}

// One expression alone, as `stride eval` is given it (§17.2): { tree, mistakes, rest }. `rest` is the token after a
// complete expression when more follows it (`1 2`, `1)`, `x: 1`): the input is not one expression. `depth` as below.
export function parseExpression(text, depth = 0) {
  let tokens;
  try {
    tokens = lex(text);
  } catch (e) {
    if (!(e instanceof SyntaxMistake)) throw e;
    // A complete expression before the text that does not lex: that text follows it, so the input is not one
    // expression (`1 @`, `1; 2`); otherwise the mistake is the expression's own.
    const before = e.span.start > 0 ? parseExpression(text.slice(0, e.span.start), depth) : null;
    if (before?.tree && !before.rest) return { tree: null, mistakes: [], rest: { type: "raw", span: e.span } };
    return { tree: null, mistakes: [e], rest: null };
  }
  // Only whitespace and comments: no expression at all.
  if (tokens.every((t) => t.type === "end")) return { tree: null, mistakes: [], rest: null, empty: true };
  const parser = new Parser(tokens, [], depth);
  try {
    const tree = parser.expr();
    return { tree, mistakes: [], rest: parser.is("end") ? null : parser.token };
  } catch (e) {
    if (!(e instanceof SyntaxMistake)) throw e;
    return { tree: null, mistakes: [e], rest: null };
  }
}

// The syntax tree of a program ("Program") or a library ("Library"), and the mistakes found: [SyntaxMistake].
// `depth`: the nesting already around the text (§7.1); below 0 when the text stands inside brackets of its own
// that do not count, as `stride eval`'s expression inside the print it is shown by.
export function parseSource(text, start = "Program", depth = 0) {
  const mistakes = [];
  let tokens;
  for (;;) {
    try {
      tokens = lex(text);
      break;
    } catch (e) {
      if (!(e instanceof SyntaxMistake)) throw e;
      // A mistake in a token: report it, set that line aside, and read the rest. Twenty are enough (§16.1).
      mistakes.push(e);
      if (mistakes.length >= 20) return { tree: null, mistakes };
      const lines = text.split("\n");
      // A byte-order mark is the one mistake of its line: the rest is read (a space keeps the columns).
      if (e.span.start === 0 && text[0] === "\uFEFF") lines[0] = ` ${lines[0].slice(1)}`;
      else lines[e.span.line - 1] = "";
      text = lines.join("\n");
    }
  }
  const parser = new Parser(tokens, mistakes, depth);
  let tree = null;
  try {
    tree = start === "Library" ? parser.library() : start === "Test" ? parser.testFile() : parser.program();
    if (!parser.is("end")) {
      parser.mistakes.push(parser.mistake("a declaration or a statement"));
    }
  } catch (e) {
    if (!(e instanceof SyntaxMistake)) throw e;
    if (!mistakes.includes(e)) mistakes.push(e);
  }
  return { tree: mistakes.length ? null : tree, mistakes: mistakes.slice(0, 20) };
}
