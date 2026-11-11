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
//   item        = import | declaration | statement
//   import      = "import" plain ["as" name]
//   declaration = ["export"] (record | enum | const | native | function)
//   record      = "record" word "{" (word ":" type [","])* "}"          word = a name or a keyword
//   enum        = "enum" name "{" (["option"] plain string)* "}"
//   const       = "const" name [":" type] "=" expr
//   native      = "native" "function" name "(" [params] ")" ["->" type]
//   function    = "function" name ["<" name ("," name)* ">"] "(" [params] ")" ["->" type] block
//   type        = "list" "<" type ">" | "map" "<" type "," type ">" | "set" "<" type ">"
//               | "(" type ("," type)+ ")" | "function" "(" [type ("," type)*] ")" ["->" type] | "any" | qname
//   statement   = ask | let | var | fill | tick | pick | if | match | for | foreach | collect | return
//               | assign | call
//   ask         = "ask" path ":" qtype string [options-block] ("default" expr | "check" expr string)*
//   if          = "if" expr block ["else" (if | block)]
//   let         = "let" (name [":" type] | names) "=" expr;  names = "(" name ("," name)+ ")"
//   assign      = (postfix | "(" postfix ("," postfix)+ ")") "=" expr
//   match       = "match" expr "{" (values "=>" block | "else" "=>" block)* "}";  values = or ("," or)*
//   for         = "for" name "in" expr (".." | "..<") expr block
//   while       = "while" expr block
//   try         = "try" block "catch" [name] block
//   foreach     = "for" ([name ","] name | names) "in" expr block     (what follows "in" has no ".." after its sum)
//   collect     = "collect" [name ","] name "in" name ["any" string "another"] string block
//   expr        = cond | coalesce;  coalesce = or ("??" or)*;  or = and ("or" and)*;  and = not ("and" not)*;  not = "not" not | compare
//   compare     = sum [("=="|"!="|"<"|"<="|">"|">="|"in"|"not" "in") sum]
//   sum         = product (("+"|"-") product)*;  product = unary (("*"|"/") unary)*;  unary = "-" unary | postfix
//   postfix     = primary ("." word | "." digits | "[" expr "]" | "[" [expr] (".." [expr] | "..<" expr) "]" | "(" [args] ")")*   (no line break before "[" or "(")
//   primary     = number | string | "true" | "false" | "null" | "[" [args] "]" | "new" qname "{" fields "}" | name
//               | "(" expr ")" | "(" expr ("," expr)+ ")" | "function" "(" [params] ")" ["->" type] block
//               | "[" expr fors "]" | "{" expr ":" expr fors "}" | "{" [expr ":" expr ("," expr ":" expr)*] "}"
//               | "match" expr "{" ((values | "else") "=>" expr [","])* "}"
//   fors        = ("for" [name ","] name "in" or ["if" or])+
import { either } from "./source.mjs";
import * as D from "../runtime/decimal.mjs";

// The keywords (§2.3). `option`, `any`, `another` and `faults` are contextual (§2.3.1): names everywhere but the one
// place the grammar uses them.
export const KEYWORDS = new Set([
  "and", "as", "ask", "break", "check", "collect", "const", "continue", "default", "else", "enum",
  "expect", "export", "false", "fill", "for", "form", "function", "if", "import", "in", "let", "match",
  "native", "new", "not", "null", "or", "pdf", "pick", "record", "return", "tick",
  "true", "var", "while",
]);
// Words the grammar uses in one place only (§2.3.1): a type's `list`, `map` and `set`, the header's `fields`,
// `when` and `then`. Anywhere else each is a name like any other.
const CONTEXTUAL = new Set(["fields", "list", "set", "then", "when"]);
// The ways of asking (§8.1).
const QUESTION_TYPES = ["one_of", "any_of", "long_text", "bool", "string", "number", "date", "phone", "email"];
// Spellings of the ways of asking that Stride does not have, and what it writes for each.
const OTHER_QUESTION_TYPES = { "one-of": "one_of", "any-of": "any_of", "long-text": "long_text", "yes-no": "bool", text: "string" };
const PUNCT = ["..<", "..", "??", "==", "!=", "<=", ">=", "=>", "->", "+=", "-=", "*=", "//=", "/=", "%=", "//", "{", "}", "(", ")", "[", "]", ",", ":", ".", "=", "<", ">", "+", "-", "*", "/", "%"];
const STARTS = new Set(["import", "export", "record", "enum", "const", "native", "function", "ask", "let", "var", "fill", "tick", "pick", "while", "if", "match", "for", "collect", "return", "break", "continue", "expect"]);

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
  let semi = false; // the next token follows a `;`
  for (;;) {
    // Whitespace and comments.
    while (cursor.at < text.length) {
      const c = cursor.peek();
      // Inside {…} in words in quotes, the words are still on one line (§2.6): a line end is S002, and a # is no
      // comment there.
      if (until && (c === "\n" || c === "\r")) throw new SyntaxMistake("these words in quotes have no closing quote on their line", spanOf(cursor.here, cursor.here), "S002");
      // A line end, or a `;`, ends a statement (§7.1).
      if (c === "\n") (broken = true), cursor.next();
      else if (c === ";" && !until) (broken = true), (semi = true), cursor.next();
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
    const before = tokens[tokens.length - 2];
    const fieldName = c === ":" || (before?.type === "punct" && before.value === ".");
    if (prev?.type === "keyword" && (prev.value === "form" || prev.value === "pdf") && !until && !fieldName) {
      // A form's id and a PDF's sha256 are read as they are written; `form` and `pdf` as a field's name (§2.3.2)
      // have a `.` before them or a `:` after.
      let value = "";
      while (cursor.at < text.length && !/\s/.test(cursor.peek()) && cursor.peek() !== "#" && cursor.peek() !== '"') value += cursor.next();
      token = { type: "raw", value };
    } else if (/[A-Za-z_]/.test(c)) {
      let value = "";
      while (cursor.at < text.length && /[A-Za-z0-9_]/.test(cursor.peek())) value += cursor.next();
      token = { type: KEYWORDS.has(value) ? "keyword" : "name", value };
    } else if (/[0-9]/.test(c)) {
      let value = "";
      while (/[0-9]/.test(cursor.peek() ?? "")) value += cursor.next();
      // After a `.`, digits are a tuple's position (§6.17): t.0.1 is position 1 of position 0.
      const position = prev?.type === "punct" && prev.value === ".";
      if (!position && cursor.peek() === "." && /[0-9]/.test(cursor.peek(1) ?? "")) {
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
    tokens.push({ ...token, span: spanOf(from, cursor.here), broken, semi });
    semi = false;
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

  // A field's name: any word, a keyword among them (§2.3.2).
  fieldName() {
    if (this.is("keyword")) return this.take().value;
    return this.name("a field's name");
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

  // A test file (§4.3): no header; imports, declarations, lets and expects.
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
        out.push(...[].concat(this.item()));
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
    if (starts && !next.semi && next.span.line === last.span.endLine) this.mistakes.push(new SyntaxMistake("a statement starts on a line of its own", next.span, "S024"));
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
    if (this.word("import")) return this.import();
    if (this.word("export") || this.word("record") || this.word("enum") || this.word("const") || this.word("native") || (this.word("function") && !this.lambdaAhead())) return this.declaration();
    return this.statement();
  }

  // function( … : a function written in place (§9.11), or a function's type (§9.10).
  lambdaAhead() {
    return this.is("keyword", "function") && this.peek().type === "punct" && this.peek().value === "(";
  }

  import() {
    const start = this.take();
    const file = this.plain();
    let alias = null;
    if (this.word("as")) {
      this.take();
      alias = this.name();
    }
    return this.node("import", start, { path: file.value, pathSpan: file.span, alias });
  }

  // ----- declarations

  declaration() {
    const start = this.token;
    const exported = this.word("export");
    if (exported) this.take();
    let d;
    if (this.word("record")) d = this.record();
    else if (this.word("enum")) d = this.enum();
    else if (this.word("const")) d = this.constant();
    else if (this.word("native")) d = this.native();
    else if (this.word("function")) d = this.function();
    else throw this.mistake(["record", "enum", "const", "function"]);
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
      const fname = this.fieldName();
      this.expect("punct", ":", '":" and the field\'s type');
      const type = this.type();
      fields.push(this.node("field-decl", f, { name: fname, type }));
      if (this.sym(",")) this.take();
    }
    this.take();
    return this.node("record", start, { name, fields });
  }

  enum() {
    const start = this.take();
    const name = this.name();
    this.expect("punct", "{");
    const options = [];
    while (!this.sym("}")) options.push(this.option(false));
    this.take();
    return this.node("enum", start, { name, options });
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
    this.expect("keyword", "function");
    const name = this.name();
    const typeParams = this.typeParams();
    const params = this.params();
    // Without -> type, a native gives no value (§5.5).
    let result = null;
    if (this.sym("->")) {
      this.take();
      result = this.type();
    }
    return this.node("native", start, { name, typeParams, params, result });
  }

  // Type parameters: function first_of<t>(l: list<t>) -> t
  typeParams() {
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
    return typeParams;
  }

  function() {
    const start = this.take();
    const name = this.name();
    const typeParams = this.typeParams();
    const params = this.params();
    let result = null;
    if (this.sym("->")) {
      this.take();
      result = this.type();
    }
    const body = this.block();
    return this.node("function", start, { name, typeParams, params, result, body });
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

  // "<" after list, map or set.
  openAngle(written) {
    if (this.sym("<")) return this.take();
    throw new SyntaxMistake(`this type is written ${written}`, this.token.span, "S010");
  }

  // The ">" that closes a type's "<". In `list<number>= e` the lexer read ">=": its ">" closes, its "=" stays.
  closeAngle() {
    const t = this.token;
    if (t.type === "punct" && t.value === ">=") {
      const mid = { line: t.span.line, col: t.span.col + 1, offset: t.span.start + 1 };
      this.tokens[this.at] = { ...t, value: "=", span: { ...t.span, col: mid.col, start: mid.offset } };
      return;
    }
    this.expect("punct", ">", '">"');
  }

  type() {
    const start = this.token;
    if (this.word("list")) {
      this.take();
      this.openAngle("list<T>");
      const element = this.type();
      this.closeAngle();
      return this.node("type-list", start, { element });
    }
    // map<string, number>: values under keys (§3.10).
    if (this.is("name", "map") && (this.peek().value === "<" || (this.peek().type === "name" && this.peek().value === "of"))) {
      this.take();
      this.openAngle("map<K, V>");
      const key = this.type();
      this.expect("punct", ",", '"," and the type of the values');
      const value = this.type();
      this.closeAngle();
      return this.node("type-map", start, { key, value });
    }
    // set<S>, S an option set: several of its options (§3.8); set<T>: values of one type, each once (§3.12).
    if (this.word("set")) {
      this.take();
      this.openAngle("set<S>");
      const element = this.type();
      this.closeAngle();
      return this.node("type-set", start, { name: element.kind === "type-name" ? element.name : null, element });
    }
    // (number, string): a tuple (§3.11).
    if (this.sym("(")) {
      this.take();
      const elements = [this.type()];
      while (this.sym(",")) {
        this.take();
        elements.push(this.type());
      }
      this.expect("punct", ")", '"," or ")"');
      if (elements.length < 2) throw new SyntaxMistake("a tuple's type names two or more types: (number, string)", this.from(start), "S010");
      return this.node("type-tuple", start, { elements });
    }
    if (this.is("name", "any")) {
      this.take();
      return this.node("type-any", start, {});
    }
    // function(number, string) -> bool: a function as a value (§9.10).
    if (this.lambdaAhead()) {
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
    if (this.token.value === "yes" && this.peek().value === "-" && this.peek(2).value === "no") throw new SyntaxMistake(`the type of true and false is written bool`, this.token.span, "S010");
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
        body.push(...[].concat(this.statement()));
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
    // try { … } catch problem { … }: what a fault inside stops is the try, not the run (§7.18).
    if (this.is("name", "try") && this.peek().type === "punct" && this.peek().value === "{") {
      const start = this.take();
      const then = this.block();
      const catchLine = this.token.span.line;
      if (!this.is("name", "catch")) this.expect("keyword", "catch", '"catch"');
      else this.take();
      let caught = null;
      if (this.token.type === "name") {
        const n = this.token;
        caught = this.node("caught", n, { name: this.name("the name the fault's words go by") });
      }
      return this.node("try", start, { then, caught, catchLine, otherwise: this.block() });
    }
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
          return this.forLoop();
        case "while": {
          // while c { … }: the body again and again, as long as c is true (§7.11.1).
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
    if (t.type === "name") this.otherSpelling();
    if (t.type === "name" || (t.type === "punct" && t.value === "(") || this.lambdaAhead()) return this.assignOrCall();
    // A value on its own, whatever it starts with, is one statement name resolution refuses (S232).
    const value = ["number", "string"].includes(t.type) || (t.type === "punct" && ["[", "-"].includes(t.value)) || (t.type === "keyword" && ["true", "false", "null", "not", "new"].includes(t.value));
    const prevTok = this.tokens[this.at - 1];
    if (value && (t.broken || !prevTok || (prevTok.type === "punct" && prevTok.value === "{"))) return this.node("call-statement", t, { call: this.expr() });
    throw this.mistake(["a statement (ask, let, var, fill, tick, pick, if, match, for, while, try, collect, return, break, continue)", "a call"]);
  }

  // A declaration started with a word Stride does not have: what it writes for it.
  otherSpelling() {
    const t = this.token, next = this.peek();
    if (next.broken) return;
    const after = this.peek(2);
    if (["define", "def", "fn", "func", "fun"].includes(t.value) && next.type === "name" && after.type === "punct" && ["(", "<"].includes(after.value)) throw new SyntaxMistake(`a function is declared with "function": function ${next.value}(…)`, t.span, "S010");
    if (t.value === "options" && next.type === "name" && after.type === "punct" && after.value === "{") throw new SyntaxMistake(`an option set is declared with "enum": enum ${next.value} { … }`, t.span, "S010");
    if (t.value === "use" && next.type === "string") throw new SyntaxMistake(`a library is brought in with "import": import "…"`, t.span, "S010");
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
      names.push(this.fieldName());
    }
    const target = this.node("path", p, { names });
    this.expect("punct", ":", '":" and the question\'s type');
    const q = this.token;
    if (!(this.is("name") && QUESTION_TYPES.includes(q.value))) {
      const hyphen = this.peek().value === "-" && this.peek(2).type === "name" ? `${q.value}-${this.peek(2).value}` : null;
      const written = this.is("name") ? OTHER_QUESTION_TYPES[hyphen] ?? OTHER_QUESTION_TYPES[q.value] : null;
      if (written) throw new SyntaxMistake(`a ${OTHER_QUESTION_TYPES[hyphen] ? hyphen : q.value} question is written ${written}`, q.span, "S010");
      throw this.mistake(QUESTION_TYPES.map((x) => `"${x}"`));
    }
    this.take();
    let set = null;
    if ((q.value === "one_of" || q.value === "any_of") && this.is("name")) set = this.qname();
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
    // let (a, b) = e (§7.3.1): e once, under a hidden name; then each name is its position of it.
    if (this.sym("(")) {
      const names = this.tupleNames();
      this.expect("punct", "=", '"=" and a tuple');
      const value = this.expr();
      const hidden = hiddenName(start);
      const first = this.node("let", start, { name: hidden, type: null, value, destructure: { kind, names: names.map((n) => n.name) } });
      return [first, ...names.map((n, i) => ({ kind, span: n.span, name: n.name, type: null, value: positionOf(hidden, i, n.span), hidden: true }))];
    }
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
      const values = this.armValues();
      this.expect("punct", "=>", '"=>" and a block');
      arms.push(this.node("arm", a, { values, body: this.block() }));
    }
    this.take();
    return this.node("match", start, { subject, arms });
  }

  // An arm's values (§7.10): words in quotes, numbers, or expressions the compiler works out; null for `else`.
  armValues() {
    if (this.word("else")) return (this.take(), null);
    const value = () => {
      if (this.is("string")) return this.plain("words in quotes, or a number");
      const next = this.peek();
      if (this.is("number") && next.type === "punct" && [",", "=>"].includes(next.value)) {
        const t = this.take();
        return { kind: "number", value: t.value, raw: t.raw, span: t.span };
      }
      if (this.sym("=>") || this.sym("}") || this.sym(",")) throw this.mistake("an arm's value");
      return this.or();
    };
    const values = [value()];
    while (this.sym(",")) {
      this.take();
      values.push(value());
    }
    return values;
  }

  // match e { 1 => "one", 2, 3 => "few", else => "many" } (§6.18): a match that gives a value.
  matchExpr() {
    const start = this.take();
    const subject = this.expr();
    this.expect("punct", "{");
    const arms = [];
    while (!this.sym("}")) {
      const a = this.token;
      const values = this.armValues();
      this.expect("punct", "=>", '"=>" and a value');
      arms.push(this.node("arm", a, { values, value: this.expr() }));
      if (this.sym(",")) this.take();
      else if (!this.sym("}") && !this.token.broken) throw this.mistake(['","', '"}"']);
    }
    this.take();
    return this.node("match-expr", start, { subject, arms });
  }

  // (a, b, …): the names a tuple's values go by.
  tupleNames() {
    const open = this.take();
    const names = [];
    do {
      if (names.length) this.take();
      const t = this.token;
      names.push({ name: this.name(), span: t.span });
    } while (this.sym(","));
    this.expect("punct", ")", '"," or ")"');
    if (names.length < 2) throw new SyntaxMistake("a tuple has two or more values: (a, b)", this.from(open), "S010");
    return names;
  }

  // for i in a..b, or for [n,] x in l: what follows `in` decides, a range having `..` after its first bound (§7.11).
  forLoop() {
    const start = this.take();
    // for (a, b) in l (§7.11.2): each item under a hidden name; a and b are its positions.
    const names = this.sym("(") ? this.tupleNames() : null;
    const [index, item] = names ? [null, hiddenName(start)] : this.loopNames();
    this.expect("keyword", "in");
    if (names) {
      const list = this.expr();
      const body = this.block();
      body.unshift(...names.map((n, i) => ({ kind: "let", span: n.span, name: n.name, type: null, value: positionOf(item, i, n.span), hidden: true })));
      return this.node("for-each", start, { index, item, list, body, destructure: names.map((n) => n.name) });
    }
    if (index === null) {
      const at = this.at, found = this.mistakes.length;
      let from = null;
      try {
        from = this.sum();
      } catch (e) {
        if (!(e instanceof SyntaxMistake)) throw e;
      }
      if (from && (this.sym("..") || this.sym("..<"))) {
        // a..b ends with b, a..<b before it.
        const exclusive = this.take().value === "..<";
        const to = this.sum();
        return this.node("for", start, { counter: item, from, to, exclusive, body: this.block() });
      }
      this.at = at;
      this.mistakes.length = found;
    }
    const list = this.expr();
    return this.node("for-each", start, { index, item, list, body: this.block() });
  }

  // The names after `for`, of a loop or a comprehension. `for each x in l` is the spelling of other languages.
  loopNames() {
    const next = this.peek();
    if (this.is("name", "each") && next.type === "name" && !next.broken) throw new SyntaxMistake(`"for each ${next.value} in …" is written "for ${next.value} in …"`, this.token.span, "S010");
    return this.indexAndItem();
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
    // (a, b) = e (§7.5.2): e once, under a hidden name; then each target is given its position of it.
    if (this.sym("=") && target.kind === "tuple") {
      this.take();
      const value = this.expr();
      const hidden = hiddenName(start);
      const first = this.node("let", start, { name: hidden, type: null, value, destructure: { kind: "assign", targets: target.items } });
      return [first, ...target.items.map((x, i) => ({ kind: "assign", span: x.span, target: x, value: positionOf(hidden, i, x.span), hidden: true }))];
    }
    if (this.sym("=")) {
      this.take();
      return this.node("assign", start, { target, value: this.expr() });
    }
    // x += e is x = x + e with x's place worked out once (§7.5).
    for (const op of ["+=", "-=", "*=", "//=", "/=", "%="]) {
      if (this.sym(op)) {
        const opTok = this.take();
        return this.node("assign", start, { target, value: this.expr(), op: op.slice(0, -1), opSpan: opTok.span });
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
      return this.coalesce();
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

  // a ?? b (§6.16): looser than or, tighter than if … then … else.
  coalesce() {
    return this.binaryChain(() => this.or(), ["??"]);
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
    // One comparison: a second one after it, of any kind (an order, ==, in), is S014 at its operator.
    const once = (e) => {
      const n = this.token;
      const another = (n.type === "punct" && ["==", "!=", "<=", ">=", "<", ">"].includes(n.value)) || this.word("in") || (this.word("not") && this.peek().type === "keyword" && this.peek().value === "in");
      if (another) throw new SyntaxMistake("comparisons do not chain: a < b < c is written a < b and b < c", n.span, "S014");
      return e;
    };
    if (t.type === "punct" && ["==", "!=", "<=", ">=", "<", ">"].includes(t.value)) {
      this.take();
      const b = this.sum();
      return once({ kind: "binary", op: t.value, a, b, opSpan: t.span, span: join(a.span, b.span) });
    }
    if (this.word("in")) {
      this.take();
      const b = this.sum();
      return once({ kind: "binary", op: "in", a, b, opSpan: t.span, span: join(a.span, b.span) });
    }
    if (this.word("not") && this.peek().type === "keyword" && this.peek().value === "in") {
      this.take();
      this.take();
      const b = this.sum();
      return once({ kind: "binary", op: "not in", a, b, opSpan: t.span, span: join(a.span, b.span) });
    }
    // x is null, x is empty, x is not None: other languages' tests for no value.
    if (this.is("name", "is") && !t.broken) {
      const not = this.peek().type === "keyword" && this.peek().value === "not";
      const what = this.peek(not ? 2 : 1);
      if ((what.type === "keyword" && what.value === "null") || (what.type === "name" && ["empty", "None", "nil"].includes(what.value))) throw new SyntaxMistake(`"is${not ? " not" : ""} ${what.value}" is written "${not ? "!=" : "=="} null"`, t.span, "S010");
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
      // After a `.`, any word is a field's name (§2.3.2).
      const field = this.sym(".") && ["name", "keyword"].includes(this.peek().type);
      // After a `.`, digits are a tuple's position (§6.17).
      const position = this.sym(".") && this.peek().type === "number" && /^\d+$/.test(this.peek().raw);
      if (field || position || ((this.sym("[") || this.sym("(")) && !t.broken)) deeper();
      if (position) {
        this.take();
        const n = this.take();
        e = { kind: "index", position: true, index: { kind: "number", value: n.value, raw: n.raw, span: n.span }, target: e, opSpan: n.span, span: join(e.span, n.span) };
      } else if (field) {
        this.take();
        const n = this.take();
        e = { kind: "field", name: n.value, target: e, span: join(e.span, n.span), nameSpan: n.span };
      } else if (this.sym("[") && !t.broken) {
        const open = this.take();
        // l[..b] starts at the first item, l[a..] goes to the last (§6.9.3).
        const first = { kind: "number", value: D.fromInt(0), raw: "0", span: open.span };
        const index = this.sym("..") || this.sym("..<") ? { ...first, open: true } : this.expr();
        if (this.sym("..") || this.sym("..<")) {
          // l[a..b] ends with the item b, l[a..<b] before it (§6.9.3)
          const exclusive = this.take().value === "..<";
          const to = !exclusive && this.sym("]") ? { kind: "number", value: D.fromInt(2147483647), raw: "2147483647", span: this.token.span, open: true } : this.expr();
          const end = this.expect("punct", "]");
          e = { kind: "slice", from: index, to, exclusive, target: e, opSpan: open.span, span: join(e.span, end.span) };
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
      if (this.sym(close)) break; // a comma after the last one
      out.push(one());
    }
    return out;
  }

  primary() {
    const t = this.token;
    if (t.type === "number") return (this.take(), { kind: "number", value: t.value, raw: t.raw, span: t.span });
    if (t.type === "string") return this.string();
    // A function written in place (§9.11): function(n: number) -> number { return n * 2 }
    if (this.lambdaAhead()) {
      const start = this.take();
      const params = this.params();
      let result = null;
      if (this.sym("->")) {
        this.take();
        result = this.type();
      }
      const body = this.block();
      return this.node("lambda", start, { params, result, body, typeParams: [] });
    }
    if (t.type === "keyword") {
      if (t.value === "true" || t.value === "false") return (this.take(), { kind: "bool", value: t.value === "true", span: t.span });
      if (t.value === "null") return (this.take(), { kind: "null", span: t.span });
      if (t.value === "match") return this.matchExpr();
      if (t.value === "new") {
        const start = this.take();
        const type = this.qname();
        this.expect("punct", "{");
        const fields = [];
        while (!this.sym("}")) {
          const f = this.token;
          const name = this.fieldName();
          this.expect("punct", ":");
          fields.push(this.node("field-value", f, { name, value: this.expr() }));
          if (this.sym(",")) this.take();
        }
        this.take();
        return this.node("new", start, { type, fields });
      }
    }
    if (t.type === "name") return (this.take(), { kind: "name", name: t.value, span: t.span });
    // A map written out: {"a": 1, "b": 2}, {} (§6.12).
    if (this.sym("{")) {
      const start = this.take();
      const entries = [];
      while (!this.sym("}")) {
        const key = this.expr();
        this.expect("punct", ":", '":" and the value under this key');
        const value = this.expr();
        // {k: v for x in l if c} (§6.12.2): a comprehension of pairs, made a map.
        if (!entries.length && this.word("for")) {
          const pairs = this.comprehension(start, { kind: "tuple", items: [key, value], span: join(key.span, value.span) }, "}");
          pairs.asMap = true;
          return pairs;
        }
        entries.push({ key, value });
        if (!this.sym("}")) this.expect("punct", ",", '"," or "}"');
      }
      this.take();
      return this.node("map", start, { entries });
    }
    if (this.sym("[")) {
      const start = this.take();
      const items = this.args("]");
      // [e for [n,] x in l if c] (§6.12)
      if (items.length === 1 && this.word("for")) return this.comprehension(start, items[0], "]");
      this.expect("punct", "]", '"," or "]"');
      return this.node("list", start, { items });
    }
    if (this.sym("(")) {
      const start = this.take();
      const e = this.expr();
      // (a, b, …): a tuple (§6.17).
      if (this.sym(",")) {
        const items = [e];
        while (this.sym(",")) {
          this.take();
          items.push(this.expr());
        }
        this.expect("punct", ")", '"," or ")"');
        return this.node("tuple", start, { items });
      }
      this.expect("punct", ")", '")"');
      // `bareSpan`: the expression without its brackets, the smallest construct a mistake in it names (§16.2.1).
      return { ...e, span: this.from(start), bareSpan: e.bareSpan ?? e.span, parenthesised: true };
    }
    if (t.type === "punct" && ["+", "-", "*", "/", "<", ">", "==", "!="].includes(t.value)) throw this.mistake("a value");
    // A line that ends on an operator (S015), whatever the next line starts with.
    const before = this.tokens[this.at - 1];
    const onOperator = t.broken && before?.type === "punct" && ["+", "-", "*", "/", "//", "%", "<", "<=", ">", ">=", "==", "!=", "??"].includes(before.value);
    if (this.is("end") || (t.broken && t.type === "keyword") || onOperator) {
      const prev = this.tokens[this.at - 1];
      throw new SyntaxMistake(prev?.type === "punct" ? `"${prev.value}" at the end of the line needs a value after it` : "the line ended where a value was expected", prev?.span ?? t.span, prev?.type === "punct" ? "S015" : "S010");
    }
    throw this.mistake("an expression");
  }

  // The `for`s of a comprehension, after its value, to its closing bracket (§6.12, §6.12.1): each `for` is a
  // comprehension whose value is the one after it (`nested`), the last one's the value written.
  comprehension(start, value, close) {
    const fors = [];
    while (this.word("for")) {
      this.take();
      const [index, item] = this.loopNames();
      this.expect("keyword", "in");
      const list = this.or();
      let condition = null;
      if (this.word("if")) {
        this.take();
        condition = this.or();
      }
      fors.push({ index, item, list, condition });
    }
    this.expect("punct", close, `"${close}"`);
    let node = value;
    for (let i = fors.length - 1; i >= 0; i--) node = this.node("comprehension", start, { value: node, ...fors[i], nested: i < fors.length - 1 });
    return node;
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


// The name a tuple goes by while its values are given to names of the program's (§7.3.1): no name of a program's.
const hiddenName = (t) => `$tuple${t.span.line}_${t.span.col}`;
// Position i of the tuple under a hidden name.
const positionOf = (hidden, i, span) => ({ kind: "index", position: true, target: { kind: "name", name: hidden, span }, index: { kind: "number", value: D.fromInt(i), raw: String(i), span }, opSpan: span, span });

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
