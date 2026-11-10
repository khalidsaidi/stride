// Stride in VS Code: starts `stride lsp` (spec §17.6) and speaks the Language Server Protocol to it for .stride
// files: mistakes and warnings as they are typed, completion, signatures, going to a definition, references,
// renaming, hover and the one layout; and debugs with `stride dap` (§17.15). Highlighting is the grammar in syntaxes/.
// Nothing to install beyond the stride command itself.
const vscode = require("vscode");
const { spawn } = require("node:child_process");

let server = null;
let nextId = 1;
const waiting = new Map();

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
  server.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  server.stdin.write(body);
}
// A request's result; requestFull gives the whole answer, an error included.
const requestFull = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
const request = async (method, params) => (await requestFull(method, params)).result ?? null;

const position = (p) => new vscode.Position(p.line, p.character);
const range = (r) => new vscode.Range(position(r.start), position(r.end));
const where = (doc, p) => ({ textDocument: { uri: doc.uri.toString() }, position: { line: p.line, character: p.character } });

function activate(context) {
  const [command, ...args] = vscode.workspace.getConfiguration("stride").get("command") ?? ["stride"];
  server = spawn(command, [...args, "lsp"], { stdio: ["pipe", "pipe", "inherit"] });
  server.on("error", (e) => vscode.window.showErrorMessage(`Stride: could not start "${command} lsp": ${e.message}. Set stride.command.`));
  const diagnostics = vscode.languages.createDiagnosticCollection("stride");
  context.subscriptions.push(diagnostics, { dispose: () => server.kill() });

  let buffer = Buffer.alloc(0);
  server.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/Content-Length: (\d+)/i.exec(buffer.slice(0, end).toString())?.[1]);
      if (buffer.length < end + 4 + length) return;
      const m = JSON.parse(buffer.slice(end + 4, end + 4 + length).toString("utf8"));
      buffer = buffer.slice(end + 4 + length);
      if (m.id !== undefined && waiting.has(m.id)) {
        waiting.get(m.id)(m);
        waiting.delete(m.id);
      } else if (m.method === "textDocument/publishDiagnostics") {
        diagnostics.set(
          vscode.Uri.parse(m.params.uri),
          m.params.diagnostics.map((d) => {
            const x = new vscode.Diagnostic(range(d.range), d.message, d.severity === 1 ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
            x.code = d.code;
            x.source = "stride";
            x.relatedInformation = (d.relatedInformation ?? []).map((r) => new vscode.DiagnosticRelatedInformation(new vscode.Location(vscode.Uri.parse(r.location.uri), range(r.location.range)), r.message));
            return x;
          }),
        );
      }
    }
  });

  // Debugging: `stride dap`, the Debug Adapter Protocol, for launch configurations of type "stride".
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory("stride", {
      createDebugAdapterDescriptor: () => new vscode.DebugAdapterExecutable(command, [...args, "dap"]),
    }),
    vscode.debug.registerDebugConfigurationProvider("stride", {
      resolveDebugConfiguration(folder, config) {
        // F5 with no launch.json: run the Stride file open in the editor.
        if (!config.type && vscode.window.activeTextEditor?.document.languageId === "stride") Object.assign(config, { type: "stride", request: "launch", name: "Run this Stride file", program: "${file}" });
        if (!config.program) return vscode.window.showInformationMessage("Open a .stride file to debug it.").then(() => undefined);
        return config;
      },
    }),
  );

  request("initialize", { processId: process.pid, capabilities: {}, rootUri: null }).then(() => send({ method: "initialized", params: {} }));
  const isStride = (doc) => doc.languageId === "stride";
  const open = (doc) => isStride(doc) && send({ method: "textDocument/didOpen", params: { textDocument: { uri: doc.uri.toString(), languageId: "stride", version: doc.version, text: doc.getText() } } });
  vscode.workspace.textDocuments.forEach(open);
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(open),
    vscode.workspace.onDidChangeTextDocument((e) => isStride(e.document) && send({ method: "textDocument/didChange", params: { textDocument: { uri: e.document.uri.toString(), version: e.document.version }, contentChanges: [{ text: e.document.getText() }] } })),
    vscode.workspace.onDidCloseTextDocument((doc) => isStride(doc) && send({ method: "textDocument/didClose", params: { textDocument: { uri: doc.uri.toString() } } })),
    vscode.languages.registerCompletionItemProvider("stride", {
      async provideCompletionItems(doc, p) {
        const items = (await request("textDocument/completion", where(doc, p))) ?? [];
        return items.map((i) => Object.assign(new vscode.CompletionItem(i.label, (i.kind ?? 1) - 1), { detail: i.detail, documentation: i.documentation }));
      },
    }, "."),
    vscode.languages.registerDefinitionProvider("stride", {
      async provideDefinition(doc, p) {
        const at = await request("textDocument/definition", where(doc, p));
        return at ? new vscode.Location(vscode.Uri.parse(at.uri), range(at.range)) : null;
      },
    }),
    vscode.languages.registerSignatureHelpProvider("stride", {
      async provideSignatureHelp(doc, p) {
        const h = await request("textDocument/signatureHelp", where(doc, p));
        if (!h) return null;
        const help = new vscode.SignatureHelp();
        help.signatures = h.signatures.map((x) => Object.assign(new vscode.SignatureInformation(x.label, x.documentation), { parameters: (x.parameters ?? []).map((q) => new vscode.ParameterInformation(q.label)) }));
        help.activeSignature = h.activeSignature ?? 0;
        help.activeParameter = h.activeParameter ?? 0;
        return help;
      },
    }, "(", ","),
    vscode.languages.registerReferenceProvider("stride", {
      async provideReferences(doc, p, context) {
        const found = (await request("textDocument/references", { ...where(doc, p), context: { includeDeclaration: context.includeDeclaration } })) ?? [];
        return found.map((r) => new vscode.Location(vscode.Uri.parse(r.uri), range(r.range)));
      },
    }),
    vscode.languages.registerRenameProvider("stride", {
      async provideRenameEdits(doc, p, newName) {
        const result = await requestFull("textDocument/rename", { ...where(doc, p), newName });
        if (result.error) throw new Error(result.error.message);
        const edit = new vscode.WorkspaceEdit();
        for (const [uri, edits] of Object.entries(result.result?.changes ?? {})) for (const e of edits) edit.replace(vscode.Uri.parse(uri), range(e.range), e.newText);
        return edit;
      },
    }),
    vscode.languages.registerHoverProvider("stride", {
      async provideHover(doc, p) {
        const h = await request("textDocument/hover", where(doc, p));
        return h ? new vscode.Hover(new vscode.MarkdownString(h.contents.value), h.range && range(h.range)) : null;
      },
    }),
    vscode.languages.registerDocumentFormattingEditProvider("stride", {
      async provideDocumentFormattingEdits(doc) {
        const edits = (await request("textDocument/formatting", { textDocument: { uri: doc.uri.toString() }, options: {} })) ?? [];
        return edits.map((e) => vscode.TextEdit.replace(range(e.range), e.newText));
      },
    }),
  );
}

function deactivate() {
  if (server) send({ method: "exit" });
}

module.exports = { activate, deactivate };
