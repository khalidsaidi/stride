// `stride lsp` (§17.6): the language server an editor starts, speaking the Language Server Protocol on stdin and
// stdout. As a file is typed it is compiled from what the editor holds, against the header and libraries beside it
// on disk, and every mistake and warning is shown at its place with its labels; it completes keywords, the
// standard library's functions with their signatures, and the names the program declares; it goes to where a name
// is declared, says what a name is, and puts the file in Stride's one layout.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compile, projectOf, STD_PATH, stdSource } from "./compile.mjs";
import { format } from "./format.mjs";
import { KEYWORDS } from "./syntax.mjs";
import { describe } from "./types.mjs";
import { nameSpan } from "./source.mjs";
import { LIBRARY } from "./codes.mjs";

const docs = new Map(); // uri -> { text, good: the last compile that resolved names }

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

const pathOf = (uri) => (uri.startsWith("file:") ? fileURLToPath(uri) : uri);
// A source file on disk as its bytes, so the compiler checks their UTF-8 itself (§1.1); the header and words as text.
const bytes = (p) => (existsSync(p) ? readFileSync(p) : null);
const disk = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);

// A file is a library when it is in one of its project's library folders (§4.7) or in a lib/ folder: its name is its
// path there. Gives { folder, name } or null.
function libraryOf(path, libraries) {
  if (path.endsWith(".test.stride")) return null;
  for (const folder of libraries) {
    const rel = relative(folder, path).replaceAll("\\", "/");
    if (!rel.startsWith("..") && !isAbsolute(rel) && /^[a-z0-9_-]+(\/[a-z0-9_-]+)*\.stride$/.test(rel)) return { folder, name: rel.replace(/\.stride$/, "") };
  }
  const m = path.match(/^(.*[\\/]lib)[\\/]([a-z0-9_-]+(?:[\\/][a-z0-9_-]+)*)\.stride$/);
  return m ? { folder: m[1], name: m[2].replaceAll("\\", "/") } : null;
}

// The file as the editor holds it, compiled the way `stride check` compiles it from disk (§17): a program or a
// script against the header and libraries beside it; a library as the library it is, from its folder, the editor's
// text standing for the file on disk. `texts` gives other files as they are to be read (by path): those the editor
// has open, or a rename's edits. Gives the compile and `own`, the name the compiler gives this file, so its mistakes
// are told from those of other files.
function compileDoc(uri, text, texts = openTexts()) {
  const path = pathOf(uri);
  // The project's libraries, as the command line finds them (§4.7); a stride.json that is not one is said.
  let libraries = [], problem = null;
  try {
    libraries = projectOf(path)?.libraries ?? [];
  } catch (e) {
    problem = e.message;
  }
  // The standard library is read as the compiler reads it (built in, in the one executable).
  const read = (p) => (p === STD_PATH ? stdSource() : resolve(p) === resolve(path) ? text : texts.has(resolve(p)) ? texts.get(resolve(p)) : bytes(p));
  const lib = libraryOf(path, libraries);
  if (lib) {
    const dir = basename(lib.folder) === "lib" ? dirname(lib.folder) : lib.folder;
    return { out: compile(`use "${lib.name}"\n`, "library-check.stride", { dir, read, libraries: [lib.folder, ...libraries] }), own: `lib/${lib.name}.stride`, path, problem };
  }
  const base = path.replace(/\.stride$/, "");
  const header = disk(`${base}.boxes.json`);
  // A header that is not JSON is said at the top of the file, and the file is checked as if it had none.
  let parsed = null;
  try {
    parsed = header ? JSON.parse(header) : null;
  } catch (e) {
    problem = `${basename(base)}.boxes.json is not JSON: ${e.message}`;
  }
  return { out: compile(text, basename(path), { dir: dirname(path), header: parsed, read, libraries }), own: basename(path), path, problem };
}
const openTexts = () => new Map([...docs.values()].filter((d) => d.path).map((d) => [resolve(d.path), d.text]));

// A place in a file, as the protocol counts: lines from 0, and characters in UTF-16 units, where the compiler's
// columns count characters (§1.3).
function range(span, file) {
  const at = (line, col) => {
    const text = file?.line?.(line) ?? "";
    return { line: Math.max(0, line - 1), character: [...text].slice(0, Math.max(0, col - 1)).join("").length + Math.max(0, col - 1 - [...text].length) };
  };
  const line = span?.line ?? 1, col = span?.col ?? 1;
  return { start: at(line, col), end: at(span?.endLine ?? line, span?.endCol ?? col + 1) };
}

// Where a file is on disk: a library by its path, the document by its own address.
const uriOf = (file, doc, unit) => {
  if (unit?.path) return pathToFileURL(isAbsolute(unit.path) ? unit.path : resolve(dirname(doc.path), unit.path)).href;
  if (file?.name?.startsWith("lib/")) return pathToFileURL(resolve(dirname(doc.path), file.name)).href;
  return doc.uri;
};

function check(uri) {
  const doc = docs.get(uri);
  const { out, own: name, path, problem } = compileDoc(uri, doc.text);
  Object.assign(doc, { uri, path, own: name });
  if (out.resolved) doc.good = out;
  // A mistake in another file, or in the header, is shown at the top of this one, with where it is; the line a
  // library is checked through is not the editor's, and says nothing of its own.
  const own = (d) => !d.file || d.file.name === name;
  const unitOf = (file) => out.resolved?.units.find((r) => r.unit.file === file)?.unit;
  const diagnostics = out.diagnostics
    .sorted()
    .filter((d) => d.file?.name !== "library-check.stride")
    .map((d) => ({
      range: range(own(d) ? d.span : null, d.file),
      severity: d.severity === "error" ? 1 : 2,
      code: d.code,
      source: "stride",
      message: own(d) ? d.message : `${d.file?.name}:${d.span?.line}: ${d.message}`,
      relatedInformation: d.notes.filter((n) => n.span).map((n) => ({ location: { uri: uriOf(n.file, doc, unitOf(n.file)), range: range(n.span, n.file) }, message: n.message })),
    }));
  if (problem) diagnostics.unshift({ range: range(null), severity: 1, source: "stride", message: problem });
  send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics } });
}

// The offset of a position in the text: lines end at "\r\n", "\r" or "\n" (§1.2), as the protocol counts them too.
function offsetOf(text, { line, character }) {
  let at = 0;
  for (let l = 0; l < line; l++) {
    const end = text.slice(at).search(/\r\n|\r|\n/);
    if (end < 0) return text.length;
    at += end + (text.startsWith("\r\n", at + end) ? 2 : 1);
  }
  return at + character;
}

// The smallest node of the program's own file at an offset that names something: { node, symbol }. A declaration
// spans its whole statement, so a use or call inside it, being smaller, comes first.
function nameAt(doc, offset) {
  const tree = unitResult(doc)?.unit.tree;
  if (!tree) return null;
  let best = null;
  const seen = new Set();
  const walk = (x) => {
    if (!x || typeof x !== "object" || seen.has(x)) return;
    seen.add(x);
    if (Array.isArray(x)) return x.forEach(walk);
    const s = x.span;
    if (s && typeof s.start === "number" && (offset < s.start || offset > s.end)) return;
    // A name where it is used, a call, or a declaration (a let, a question, a function…) by its own symbol.
    const symbol = x.kind === "name" ? x.symbol : x.kind === "call" ? x.callee : x.symbol?.node === x ? x.symbol : null;
    if (symbol && s && (!best || s.end - s.start <= best.node.span.end - best.node.span.start)) best = { node: x, symbol };
    for (const [k, v] of Object.entries(x)) if (!["symbol", "callee", "type", "file", "scope", "unit", "knownFault", "faultContext"].includes(k)) walk(v);
  };
  walk(tree);
  return best;
}

// The resolved unit of the document itself: the program, or the library being edited.
const unitResult = (doc) => doc.good?.resolved?.units.find((r) => r.unit.file?.name === doc.own) ?? doc.good?.resolved?.units.at(-1);

const entryOf = (name) => LIBRARY.find((e) => e.names.includes(name));

function hoverOf(symbol) {
  const lib = entryOf(symbol.name);
  if (lib && (symbol.kind === "native" || symbol.unit?.std)) return `\`\`\`stride\n${lib.signatures.join("\n")}\n\`\`\`\n${lib.gives}`;
  if (symbol.kind === "function" || symbol.kind === "native") {
    const params = (symbol.params ?? []).map((p) => `${p.name}: ${p.type ? describe(p.type) : "?"}`).join(", ");
    return `\`\`\`stride\ndefine ${symbol.name}(${params})${symbol.result && symbol.result.t !== "none" ? ` -> ${describe(symbol.result)}` : ""}\n\`\`\``;
  }
  return `\`\`\`stride\n${symbol.kind} ${symbol.name}${symbol.type ? `: ${describe(symbol.type)}` : ""}\n\`\`\``;
}

// After `name.` (or `a.b.`): what the name holds, the exports of a library kept under it (use "x" as name), or
// the fields of the record it is; null when the text before the cursor is not that.
function members(doc, offset) {
  const before = doc.text.slice(0, offset).match(/([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.([A-Za-z0-9_]*)$/);
  if (!before) return null;
  const chain = before[1].split(".");
  const r = unitResult(doc);
  if (!r) return [];
  const first = r.scope.lookup?.(chain[0]) ?? declared(doc, chain[0], offset);
  if (first?.kind === "module" && chain.length === 1) return [...first.exports.values()].map((x) => ({ label: x.name, kind: x.kind === "function" ? 3 : 6, detail: x.kind === "function" ? signatureOf(x) : x.kind }));
  let type = first?.type ?? null;
  for (const field of chain.slice(1)) type = type?.t === "record" ? type.decl.fields.find((f) => f.name === field)?.type : null;
  if (type?.t === "list") return []; // a list has items, not fields
  return type?.t === "record" ? type.decl.fields.map((f) => ({ label: f.name, kind: 5, detail: f.type ? describe(f.type) : "" })) : [];
}

// The last declaration of a name before an offset, in the document's own file: a let, a var, an answer, a param.
function declared(doc, name, offset) {
  let best = null;
  walkTree(unitResult(doc)?.unit.tree, (x) => {
    if (x.symbol?.node === x && x.symbol.name === name && (x.span?.start ?? 0) <= offset) best = x.symbol;
  });
  return best;
}

// Every node of a tree, once, not through its links to symbols and types.
function walkTree(tree, visit) {
  const seen = new Set();
  const walk = (x) => {
    if (!x || typeof x !== "object" || seen.has(x)) return;
    seen.add(x);
    if (Array.isArray(x)) return x.forEach(walk);
    visit(x);
    for (const [k, v] of Object.entries(x)) if (!["symbol", "callee", "type", "file", "scope", "unit", "knownFault", "faultContext", "itemSymbol", "indexSymbol", "listSymbol"].includes(k)) walk(v);
  };
  walk(tree);
}

const signatureOf = (sym) => entryOf(sym.name) && (sym.kind === "native" || sym.unit?.std) ? entryOf(sym.name).signatures.join(", ") : `${sym.name}(${(sym.params ?? []).map((p) => `${p.name}: ${p.type ? describe(p.type) : "?"}${p.node?.default ? " = …" : ""}`).join(", ")})${sym.result && sym.result.t !== "none" ? ` -> ${describe(sym.result)}` : ""}`;

// Signature help: the call the cursor is in, its signature and which argument the cursor is at.
function signatureHelp(doc, offset) {
  let depth = 0, commas = 0, i = offset - 1;
  for (; i >= 0; i--) {
    const c = doc.text[i];
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) commas++;
    else if (c === "\n" && depth === 0 && doc.text[i - 1] !== ",") break;
  }
  if (i < 0 || doc.text[i] !== "(") return null;
  const name = doc.text.slice(0, i).match(/([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*$/)?.[1];
  if (!name) return null;
  const lib = entryOf(name.split(".").at(-1));
  const r = unitResult(doc);
  const user = name.includes(".") ? r?.scope.lookup?.(name.split(".")[0])?.exports?.get(name.split(".")[1]) : r?.scope.lookup?.(name);
  const sym = user && user.kind === "function" ? user : null;
  const label = sym ? signatureOf(sym) : lib?.signatures[0];
  if (!label) return null;
  const params = sym ? sym.params.map((p) => p.name) : (label.match(/\((.*)\)/)?.[1] ?? "").split(/,\s*/).filter(Boolean).map((x) => x.split(":")[0]);
  return { signatures: [{ label, documentation: sym ? undefined : lib?.gives, parameters: params.map((p) => ({ label: p })) }], activeSignature: 0, activeParameter: Math.min(commas, Math.max(0, params.length - 1)) };
}

// What a name refers to, the same in every compile: the file it is declared in and where, and its name.
const declOf = (ctx, sym) => sym.node?.span && `${uriOf(sym.file, ctx, sym.unit)}#${sym.node.span.line}:${sym.node.span.col}:${sym.name}`;
const targetOf = (x) => (x.kind === "name" ? x.symbol : x.kind === "call" ? x.callee : x.symbol?.node === x ? x.symbol : null);

// Every place in a compile, but the standard library, naming the declaration `decl`: its declaration, its uses, its
// calls; each at the name itself. Gives [{ uri, range }].
function occurrencesIn(ctx, decl) {
  const out = [];
  for (const r of ctx.good?.resolved?.units ?? []) {
    if (r.unit.std) continue;
    walkTree(r.unit.tree, (x) => {
      const target = targetOf(x);
      if (!target || !x.span || target.unit?.std || declOf(ctx, target) !== decl) return;
      // A use names it as written, a library's under its name too (m.twice): the part after the last dot.
      const span = x.kind === "name" && !x.name?.includes?.(".") ? x.span : nameSpan(x.file ?? r.unit.file, x.kind === "call" || x.kind === "name" ? { ...x.span, col: x.span.col + (x.name?.includes?.(".") ? x.name.lastIndexOf(".") + 1 : 0) } : x.span, target.name);
      out.push({ uri: uriOf(r.unit.file, ctx, r.unit), range: range(span, x.file ?? r.unit.file) });
    });
  }
  return out;
}

// The project's files (§4.7): every .stride file under its folder and its library folders, as `stride check` finds
// them; with no project, under the folder that holds the file's lib/, or its own.
function projectFiles(doc) {
  let project = null;
  try {
    project = projectOf(doc.path);
  } catch {}
  const lib = libraryOf(doc.path, project?.libraries ?? []);
  const roots = project ? [project.root, ...project.libraries] : [lib ? dirname(lib.folder) : dirname(doc.path)];
  const found = new Set();
  const walk = (dir) => {
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith(".") || n === "node_modules" || n.endsWith(".tests")) continue;
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".stride")) found.add(resolve(p));
    }
  };
  roots.forEach(walk);
  return [...found];
}

// A file compiled as the editor would compile it, with `texts` for the files read.
function contextOf(path, texts) {
  const uri = pathToFileURL(path).href;
  const text = texts.get(path) ?? bytes(path)?.toString("utf8") ?? "";
  const { out, own } = compileDoc(uri, text, texts);
  return { uri, path, own, good: out.resolved ? out : null, out };
}

// The compiles a symbol can be named in: the document's own; for one a library declares, every file of the project
// too, since any of them may use it.
function contextsFor(doc, symbol, texts = openTexts()) {
  const own = { uri: doc.uri, path: resolve(doc.path), own: doc.own, good: doc.good, out: doc.good };
  if (!symbol.unit?.library) return [own];
  return [own, ...projectFiles(doc).filter((p) => p !== own.path).map((p) => contextOf(p, texts))];
}

// Every place the symbol is named, in the file and, for a library's, in every file of the project that uses it.
function occurrences(doc, symbol) {
  const decl = declOf(doc, symbol);
  const seen = new Set();
  return contextsFor(doc, symbol)
    .flatMap((ctx) => occurrencesIn(ctx, decl))
    .filter((o) => {
      const k = `${o.uri}:${o.range.start.line}:${o.range.start.character}`;
      return !seen.has(k) && seen.add(k);
    });
}

// What each name in a compile refers to, in the order the names stand: each declaration by its place among the
// compile's declarations, so a rename, which changes no order, must leave it the same.
function bindings(ctx) {
  const decls = [];
  const uses = [];
  for (const r of ctx.good?.resolved?.units ?? []) {
    if (r.unit.std) continue;
    walkTree(r.unit.tree, (x) => {
      const target = targetOf(x);
      if (!target || !x.span) return;
      if (target.unit?.std || target.kind === "native" || !target.node?.span) return uses.push([uriOf(r.unit.file, ctx, r.unit), `std:${target.name}`]);
      const d = { file: uriOf(target.file, ctx, target.unit), at: target.node.span.start };
      if (!decls.some((e) => e.file === d.file && e.at === d.at)) decls.push(d);
      uses.push([uriOf(r.unit.file, ctx, r.unit), d]);
    });
  }
  // Declarations are numbered by where they stand in their file, which a rename does not change.
  decls.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.at - b.at));
  const rank = (d) => decls.findIndex((e) => e.file === d.file && e.at === d.at);
  return uses.map(([file, d]) => `${file} ${typeof d === "string" ? d : rank(d)}`).join("\n");
}
const mistakesOf = (ctx) => (ctx.out?.diagnostics.sorted() ?? []).filter((d) => d.severity === "error");

// A rename, as edits by file, or why it is refused: the new name must be a name (§2.1), not a word of the language,
// and not the standard library's; and the program, with the edits made, must have no
// mistake it did not have and every name in it must refer to what it did. Every file it is checked in is
// checked so.
function renameOf(doc, symbol, name) {
  if (symbol.unit?.std || symbol.kind === "native") return { error: `${symbol.name} is the standard library's: it is not renamed` };
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || KEYWORDS.has(name)) return { error: `${name} is not a name Stride takes (§2.1)` };
  if (entryOf(name)) return { error: `${name} is the standard library's ${name}: another name keeps both` };
  if (name === symbol.name) return { changes: {} };
  const before = contextsFor(doc, symbol);
  const decl = declOf(doc, symbol);
  const changes = {};
  const seen = new Set();
  for (const o of before.flatMap((ctx) => occurrencesIn(ctx, decl))) {
    const k = `${o.uri}:${o.range.start.line}:${o.range.start.character}`;
    if (!seen.has(k) && seen.add(k)) (changes[o.uri] ??= []).push({ range: o.range, newText: name });
  }
  // The files with the edits made, and every compile checked again with them.
  const texts = openTexts();
  for (const [uri, edits] of Object.entries(changes)) {
    const path = resolve(pathOf(uri));
    const text = texts.get(path) ?? (path === resolve(doc.path) ? doc.text : bytes(path)?.toString("utf8") ?? "");
    texts.set(path, applyEdits(text, edits));
  }
  const after = before.map((ctx) => contextOf(ctx.path, texts));
  for (let i = 0; i < before.length; i++) {
    const was = new Set(mistakesOf(before[i]).map((d) => `${d.code}:${d.message}`));
    const now = mistakesOf(after[i]).find((d) => !was.has(`${d.code}:${d.message.replaceAll(name, symbol.name)}`));
    if (now) return { error: `renaming ${symbol.name} to ${name} would give ${basename(after[i].path)} a mistake: ${now.message}` };
    if (bindings(before[i]) !== bindings(after[i])) return { error: `renaming ${symbol.name} to ${name} would change what a name refers to in ${basename(after[i].path)}: ${name} is already a name there` };
  }
  return { changes };
}

// Text with edits made, each a range in the protocol's places (lines from 0, UTF-16 units), none overlapping.
function applyEdits(text, edits) {
  const at = (pos) => offsetOf(text, pos);
  return [...edits].sort((a, b) => at(b.range.start) - at(a.range.start)).reduce((t, e) => t.slice(0, at(e.range.start)) + e.newText + t.slice(at(e.range.end)), text);
}

function completions(doc, offset = null) {
  const after = offset === null ? null : members(doc, offset);
  if (after) return after;
  const items = [...KEYWORDS].map((k) => ({ label: k, kind: 14 }));
  for (const e of LIBRARY) for (const [i, n] of e.names.entries()) items.push({ label: n, kind: 3, detail: e.signatures[i] ?? e.signatures[0], documentation: e.gives });
  const seen = new Set(items.map((i) => i.label));
  const r = unitResult(doc);
  const add = (sym) => {
    if (!sym?.name || seen.has(sym.name)) return;
    seen.add(sym.name);
    items.push({ label: sym.name, kind: { function: 3, record: 22, options: 13, const: 21, answer: 6, let: 6, var: 6, param: 6 }[sym.kind] ?? 6, detail: sym.kind });
  };
  for (const sym of r?.scope.names.values() ?? []) add(sym);
  const walked = new Set();
  const walk = (x) => {
    if (!x || typeof x !== "object" || walked.has(x)) return;
    walked.add(x);
    if (Array.isArray(x)) return x.forEach(walk);
    if (x.symbol?.node === x) add(x.symbol);
    for (const [k, v] of Object.entries(x)) if (!["symbol", "callee", "type", "file", "scope", "unit"].includes(k)) walk(v);
  };
  walk(r?.unit.tree);
  return items;
}

function handle(m) {
  const p = m.params ?? {};
  switch (m.method) {
    case "initialize":
      return send({ id: m.id, result: { capabilities: { textDocumentSync: 1, completionProvider: { triggerCharacters: ["."] }, signatureHelpProvider: { triggerCharacters: ["(", ","] }, definitionProvider: true, referencesProvider: true, renameProvider: true, hoverProvider: true, documentFormattingProvider: true }, serverInfo: { name: "stride" } } });
    case "shutdown":
      return send({ id: m.id, result: null });
    case "exit":
      return process.exit(0);
    case "textDocument/didOpen":
      docs.set(p.textDocument.uri, { text: p.textDocument.text, good: null });
      return check(p.textDocument.uri);
    case "textDocument/didChange": {
      const doc = docs.get(p.textDocument.uri) ?? { good: null };
      doc.text = p.contentChanges.at(-1).text;
      docs.set(p.textDocument.uri, doc);
      return check(p.textDocument.uri);
    }
    case "textDocument/didClose":
      docs.delete(p.textDocument.uri);
      return send({ method: "textDocument/publishDiagnostics", params: { uri: p.textDocument.uri, diagnostics: [] } });
    case "textDocument/completion":
      {
        const doc = docs.get(p.textDocument.uri);
        return send({ id: m.id, result: doc ? completions(doc, offsetOf(doc.text, p.position)) : [] });
      }
    case "textDocument/signatureHelp": {
      const doc = docs.get(p.textDocument.uri);
      return send({ id: m.id, result: doc ? signatureHelp(doc, offsetOf(doc.text, p.position)) : null });
    }
    case "textDocument/references": {
      const doc = docs.get(p.textDocument.uri);
      const found = doc && nameAt(doc, offsetOf(doc.text, p.position));
      if (!found || found.symbol.unit?.std) return send({ id: m.id, result: [] });
      const all = occurrences(doc, found.symbol);
      const decl = found.symbol.node?.span;
      return send({ id: m.id, result: all.filter((o) => p.context?.includeDeclaration !== false || !decl || o.range.start.line !== decl.line - 1 || o.uri !== uriOf(found.symbol.file, doc, found.symbol.unit)).map(({ uri, range }) => ({ uri, range })) });
    }
    case "textDocument/rename": {
      const doc = docs.get(p.textDocument.uri);
      const found = doc && nameAt(doc, offsetOf(doc.text, p.position));
      if (!found) return send({ id: m.id, error: { code: -32803, message: "nothing here to rename" } });
      const r = renameOf(doc, found.symbol, p.newName);
      return r.error ? send({ id: m.id, error: { code: -32803, message: r.error } }) : send({ id: m.id, result: { changes: r.changes } });
    }
    case "textDocument/definition": {
      const doc = docs.get(p.textDocument.uri);
      const found = doc && nameAt(doc, offsetOf(doc.text, p.position));
      const span = found?.symbol.node?.span;
      if (!span || found.symbol.kind === "native") return send({ id: m.id, result: null });
      return send({ id: m.id, result: { uri: uriOf(found.symbol.file, doc, found.symbol.unit), range: range(span, found.symbol.file) } });
    }
    case "textDocument/hover": {
      const doc = docs.get(p.textDocument.uri);
      const found = doc && nameAt(doc, offsetOf(doc.text, p.position));
      return send({ id: m.id, result: found ? { contents: { kind: "markdown", value: hoverOf(found.symbol) }, range: range(found.node.span, found.node.file) } : null });
    }
    case "textDocument/formatting": {
      const doc = docs.get(p.textDocument.uri);
      const out = doc && format(doc.text, basename(fileURLToPath(p.textDocument.uri)));
      if (!out?.text || out.text === doc.text) return send({ id: m.id, result: [] });
      const lines = doc.text.split("\n");
      return send({ id: m.id, result: [{ range: { start: { line: 0, character: 0 }, end: { line: lines.length, character: 0 } }, newText: out.text }] });
    }
    default:
      if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `stride lsp does not do ${m.method}` } });
  }
}

// Messages framed by Content-Length, as the protocol has them.
export function serve() {
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.slice(0, end).toString())?.[1]);
      // A header with no Content-Length says nothing of what follows: it is dropped, and reading goes on.
      if (!Number.isFinite(length)) {
        buffer = buffer.slice(end + 4);
        send({ id: null, error: { code: -32700, message: "a message without Content-Length" } });
        continue;
      }
      if (buffer.length < end + 4 + length) return;
      const raw = buffer.slice(end + 4, end + 4 + length).toString("utf8");
      buffer = buffer.slice(end + 4 + length);
      let message;
      try {
        message = JSON.parse(raw);
      } catch (e) {
        send({ id: null, error: { code: -32700, message: `not JSON: ${e.message}` } });
        continue;
      }
      try {
        handle(message);
      } catch (e) {
        if (message.id !== undefined) send({ id: message.id, error: { code: -32603, message: e.message } });
      }
    }
  });
  return new Promise(() => {});
}
