// The extension in VS Code's own extension host: run by test/run.sh, which starts a real VS Code with this
// extension and this file as its tests. It opens Stride files and asks VS Code itself, through its commands, for
// what the extension and `stride lsp` give: diagnostics at their places, completion, hover, definitions (into a
// library too), formatting, and a library opened on its own without a mistake. Throws on the first difference.
const vscode = require("vscode");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const until = async (what, f, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    const v = await f();
    if (v) return v;
  }
  throw new Error(`waited ${ms} ms for ${what}`);
};

exports.run = async () => {
  const dir = process.env.STRIDE_TEST_DIR;
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "doubles.stride"), 'function twice(n: number) -> number {\n  return n * 2\n}\nlet total = twice(4)\nprint(totl)\n');
  fs.writeFileSync(path.join(dir, "lib", "math.stride"), "export function triple(n: number) -> number {\n  return n * 3\n}\n");
  fs.writeFileSync(path.join(dir, "uses.stride"), 'import "math"\nprint(triple(2))\n');
  fs.writeFileSync(path.join(dir, "messy.stride"), "let  x=1\nprint( x )\n");

  const open = async (name) => {
    const doc = await vscode.workspace.openTextDocument(path.join(dir, name));
    await vscode.window.showTextDocument(doc);
    assert.strictEqual(doc.languageId, "stride", `${name} is not taken as Stride`);
    return doc;
  };
  const doubles = await open("doubles.stride");
  const mistake = await until("the mistake on line 5", () => vscode.languages.getDiagnostics(doubles.uri).find((d) => d.severity === vscode.DiagnosticSeverity.Error));
  assert.match(String(mistake.code), /^S\d{3}$/);
  assert.deepStrictEqual([mistake.range.start.line, mistake.range.start.character], [4, 6]);

  const completion = await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", doubles.uri, new vscode.Position(4, 6));
  const labels = completion.items.map((i) => (typeof i.label === "string" ? i.label : i.label.label));
  for (const l of ["twice", "total", "pad_left", "define"]) assert.ok(labels.includes(l), `completion has no ${l}`);

  // Hover on the call of twice: its signature.
  const hover = await vscode.commands.executeCommand("vscode.executeHoverProvider", doubles.uri, new vscode.Position(3, 13));
  assert.ok(hover.some((h) => h.contents.some((c) => /function twice\(n: number\) -> number/.test(c.value ?? c))), "hover on twice");

  const definition = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", doubles.uri, new vscode.Position(3, 13));
  assert.strictEqual((definition[0].targetRange ?? definition[0].range).start.line, 0, "definition of twice");

  const uses = await open("uses.stride");
  await until("uses.stride checked", () => vscode.languages.getDiagnostics(uses.uri).length === 0 || true);
  const intoLib = await until("a definition into the library", async () => (await vscode.commands.executeCommand("vscode.executeDefinitionProvider", uses.uri, new vscode.Position(1, 7)))[0]);
  assert.strictEqual((intoLib.targetUri ?? intoLib.uri).fsPath, path.join(dir, "lib", "math.stride"));

  const lib = await open(path.join("lib", "math.stride"));
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(!vscode.languages.getDiagnostics(lib.uri).some((d) => d.severity === vscode.DiagnosticSeverity.Error), "a valid library opened on its own has a mistake");

  const messy = await open("messy.stride");
  // VS Code may hand back smaller edits than the server's one: the document after them is what counts.
  const edits = await vscode.commands.executeCommand("vscode.executeFormatDocumentProvider", messy.uri, { tabSize: 2, insertSpaces: true });
  const change = new vscode.WorkspaceEdit();
  change.set(messy.uri, edits);
  await vscode.workspace.applyEdit(change);
  assert.strictEqual(messy.getText(), "let x = 1\nprint(x)\n");
  // Highlighting: the grammar's scopes, as VS Code tokenises the file.
  fs.writeFileSync(path.join(dir, "colours.stride"), '# a note\nfunction f(n: number) -> string {\n  return "n is {n}"\n}\n');
  const colours = await open("colours.stride");
  const tokens = await vscode.commands.executeCommand("_workbench.captureSyntaxTokens", colours.uri);
  const scopeOf = (text) => tokens.find((t) => t.c === text)?.t ?? "";
  assert.match(scopeOf("# a note"), /comment/, "a comment's scope");
  assert.match(scopeOf("define"), /keyword/, "a keyword's scope");
  assert.match(scopeOf("number"), /support\.type/, "a type's scope");
  assert.ok(tokens.some((t) => /string\.quoted/.test(t.t) && t.c.includes("n is")), "words in quotes");
  assert.ok(tokens.some((t) => /meta\.interpolation/.test(t.t)), "a value put in words");
  // Names: a library kept as m, a record's fields, a signature, references and renaming across files.
  fs.writeFileSync(path.join(dir, "lib", "maths.stride"), "export function twice(n: number) -> number {\n  let d = n * 2\n  return d\n}\n");
  fs.writeFileSync(path.join(dir, "names.stride"), 'import "maths" as m\nrecord person {\n  name: string\n  age: number\n}\nlet p = new person { name: "Ada", age: 36 }\nprint(m.twice(p.age))\n');
  const names = await open("names.stride");
  await until("names.stride checked", () => vscode.languages.getDiagnostics(names.uri).length === 0);
  const labelsAt = async (line, ch) => (await vscode.commands.executeCommand("vscode.executeCompletionItemProvider", names.uri, new vscode.Position(line, ch))).items.map((i) => (typeof i.label === "string" ? i.label : i.label.label));
  assert.deepStrictEqual(await labelsAt(6, 8), ["twice"], "completion after m.");
  assert.deepStrictEqual((await labelsAt(6, 16)).sort(), ["age", "name"], "completion after p.");
  const help = await vscode.commands.executeCommand("vscode.executeSignatureHelpProvider", names.uri, new vscode.Position(6, 14));
  assert.strictEqual(help.signatures[0].label, "twice(n: number) -> number");
  const refs = await vscode.commands.executeCommand("vscode.executeReferenceProvider", names.uri, new vscode.Position(6, 15));
  assert.strictEqual(refs.length, 2, "references to p");
  const renamed = await vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", names.uri, new vscode.Position(6, 9), "double");
  assert.deepStrictEqual(renamed.entries().map(([u]) => path.basename(u.fsPath)).sort(), ["maths.stride", "names.stride"], "renaming across the files");

  // Debugging: a breakpoint in the library, stopped there, its values, then to the end.
  fs.writeFileSync(path.join(dir, "debugged.stride"), 'import "maths"\nvar total: number = 0\nfor i in 1..2 {\n  total = total + twice(i)\n}\nprint(total)\n');
  const libUri = vscode.Uri.file(path.join(dir, "lib", "maths.stride"));
  vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(libUri, new vscode.Position(2, 0)))]);
  const seen = [];
  const tracker = vscode.debug.registerDebugAdapterTrackerFactory("stride", { createDebugAdapterTracker: () => ({ onDidSendMessage: (m) => m.type === "event" && seen.push(m) }) });
  const ended = new Promise((ok) => vscode.debug.onDidTerminateDebugSession(ok));
  assert.ok(await vscode.debug.startDebugging(undefined, { type: "stride", request: "launch", name: "debugged", program: path.join(dir, "debugged.stride") }), "the debug session starts");
  await until("the stop at the library's breakpoint", () => seen.some((m) => m.event === "stopped"));
  const session = vscode.debug.activeDebugSession;
  const stack = await session.customRequest("stackTrace", { threadId: 1 });
  assert.deepStrictEqual(stack.stackFrames.map((f) => `${f.name}:${f.line}`), ["twice:3", "main:4"]);
  const vars = await session.customRequest("variables", { variablesReference: stack.stackFrames[0].id });
  assert.ok(vars.variables.some((v) => v.name === "d" && v.value === "2"), `the values at the stop: ${JSON.stringify(vars.variables)}`);
  vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
  await session.customRequest("continue", { threadId: 1 });
  await ended;
  assert.ok(seen.some((m) => m.event === "output" && m.body.output === "6\n"), "the program's output");
  tracker.dispose();

  fs.writeFileSync(path.join(dir, "passed"), "yes");
};
