// rule 17.6
// The VS Code extension (editors/vscode) against a stand-in for VS Code's API: it starts `stride lsp`, sends
// an open document, turns the server's mistakes into diagnostics at their places, and answers completion, hover,
// definition and formatting through the server, and starts `stride dap` for debugging. Its grammar and manifest are
// well formed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const EXT = fileURLToPath(new URL("../../editors/vscode/", import.meta.url));
const CLI = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));

// In a child: a fake `vscode` module, the extension activated against it, a document opened, the providers asked.
const CHILD = `
const Module = require("node:module");
const [ext, cli] = process.argv.slice(1);
const made = { diagnostics: new Map(), providers: {}, opened: [] };
class Position { constructor(l, c) { this.line = l; this.character = c; } }
class Range { constructor(a, b) { this.start = a; this.end = b; } }
const vscode = {
  Position, Range,
  Location: class { constructor(uri, range) { this.uri = uri; this.range = range; } },
  Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
  DiagnosticRelatedInformation: class { constructor(location, message) { Object.assign(this, { location, message }); } },
  DiagnosticSeverity: { Error: 0, Warning: 1 },
  CompletionItem: class { constructor(label, kind) { Object.assign(this, { label, kind }); } },
  Hover: class { constructor(contents, range) { Object.assign(this, { contents, range }); } },
  MarkdownString: class { constructor(value) { this.value = value; } },
  TextEdit: { replace: (range, newText) => ({ range, newText }) },
  Uri: { parse: (s) => ({ toString: () => s, s }) },
  window: { showErrorMessage: (m) => made.error = m },
  DebugAdapterExecutable: class { constructor(command, args) { Object.assign(this, { command, args }); } },
  debug: {
    registerDebugAdapterDescriptorFactory: (type, f) => (made.debugAdapter = f.createDebugAdapterDescriptor(), {}),
    registerDebugConfigurationProvider: () => ({}),
  },
  workspace: {
    getConfiguration: () => ({ get: () => ["node", cli] }),
    textDocuments: [],
    onDidOpenTextDocument: () => ({}), onDidChangeTextDocument: () => ({}), onDidCloseTextDocument: () => ({}),
  },
  languages: {
    createDiagnosticCollection: () => ({ set: (uri, list) => made.diagnostics.set(uri.s, list), dispose() {} }),
    registerCompletionItemProvider: (l, p) => (made.providers.completion = p, {}),
    registerDefinitionProvider: (l, p) => (made.providers.definition = p, {}),
    registerHoverProvider: (l, p) => (made.providers.hover = p, {}),
    registerDocumentFormattingEditProvider: (l, p) => (made.providers.format = p, {}),
    registerSignatureHelpProvider: (l, p) => (made.providers.signatureHelp = p, {}),
    registerReferenceProvider: (l, p) => (made.providers.references = p, {}),
    registerRenameProvider: (l, p) => (made.providers.rename = p, {}),
  },
};
const load = Module._load;
Module._load = (req, ...rest) => (req === "vscode" ? vscode : load(req, ...rest));
const text = 'function twice(n: number) -> number {\\n  return n * 2\\n}\\nlet total = twice(4)\\nprint(totl)\\n';
const uri = "file:///tmp/editor-test/doubles.stride";
const doc = { uri: { toString: () => uri }, languageId: "stride", version: 1, getText: () => text };
vscode.workspace.textDocuments = [doc];
const context = { subscriptions: [] };
require(ext + "extension.js").activate(context);
const until = (f) => new Promise((ok) => { const t = setInterval(() => { if (f()) { clearInterval(t); ok(); } }, 20); });
(async () => {
  await until(() => made.diagnostics.has(uri));
  const d = made.diagnostics.get(uri)[0];
  const out = { diagnostic: { code: d.code, line: d.range.start.line, character: d.range.start.character, severity: d.severity } };
  out.completion = (await made.providers.completion.provideCompletionItems(doc, new Position(4, 6))).map((i) => i.label);
  out.hover = (await made.providers.hover.provideHover(doc, new Position(3, 5)))?.contents.value;
  out.definition = (await made.providers.definition.provideDefinition(doc, new Position(3, 13)))?.range.start.line;
  out.format = (await made.providers.format.provideDocumentFormattingEdits(doc)).length;
  out.debugAdapter = made.debugAdapter && [made.debugAdapter.command, ...made.debugAdapter.args].slice(-1)[0];
  console.log(JSON.stringify(out));
  require(ext + "extension.js").deactivate();
  process.exit(0);
})();
`;

export function test() {
  const problems = [];
  for (const f of ["package.json", "language-configuration.json", "syntaxes/stride.tmLanguage.json"]) {
    try {
      JSON.parse(readFileSync(EXT + f, "utf8"));
    } catch (e) {
      problems.push(`${f}: ${e.message}`);
    }
  }
  let out;
  try {
    out = JSON.parse(execFileSync("node", ["-e", CHILD, EXT, CLI], { encoding: "utf8", timeout: 30_000 }));
  } catch (e) {
    return [...problems, `the extension did not run: ${e.message.slice(0, 400)}`];
  }
  if (!/^S\d{3}$/.test(out.diagnostic.code) || out.diagnostic.line !== 4 || out.diagnostic.character !== 6 || out.diagnostic.severity !== 0) problems.push(`diagnostic: ${JSON.stringify(out.diagnostic)}`);
  for (const l of ["twice", "total", "pad_left", "function"]) if (!out.completion.includes(l)) problems.push(`completion has no ${l}`);
  // The document still has its mistake (totl), so names are resolved and types not yet worked out.
  if (!/let total/.test(out.hover ?? "")) problems.push(`hover: ${out.hover}`);
  if (out.definition !== 0) problems.push(`definition: ${out.definition}`);
  if (out.format !== 0) problems.push(`formatting a file already in layout gave ${out.format} edits`);
  if (out.debugAdapter !== "dap") problems.push(`the debugger the extension starts: ${out.debugAdapter}`);
  return problems;
}
