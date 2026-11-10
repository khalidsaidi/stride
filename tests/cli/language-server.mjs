// rule 17.6 16.2
// `stride lsp` as an editor meets it: a file opened with a mistake gets it at its place with its code; a change
// that mends it clears it; completion offers keywords, the standard library with signatures and the file's own
// names; going to a definition finds the declaration, in a library too, wherever the server was started; hover
// says what a name is; formatting gives the one layout. A library opened on its own is checked as a library, and
// places are counted in UTF-16, as the protocol has them, past a character outside the Basic Multilingual Plane;
// lines ending in a lone CR are navigated as any others; a library's dependency that is not UTF-8 is S001.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The server, run to the end of a fixed exchange, in a child that writes what came back as JSON.
const CHILD = `
const { spawn } = await import("node:child_process");
const [cli, uri] = process.argv.slice(1);
const server = spawn("node", [cli, "lsp"], { cwd: (await import("node:os")).tmpdir() });
let buf = Buffer.alloc(0); const got = []; let waiting = null;
server.stdout.on("data", (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const end = buf.indexOf("\\r\\n\\r\\n"); if (end < 0) break;
    const n = Number(/Content-Length: (\\d+)/.exec(buf.slice(0, end).toString())[1]);
    if (buf.length < end + 4 + n) break;
    got.push(JSON.parse(buf.slice(end + 4, end + 4 + n).toString())); buf = buf.slice(end + 4 + n);
    waiting?.();
  }
});
const send = (m) => { const b = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...m })); server.stdin.write("Content-Length: " + b.length + "\\r\\n\\r\\n"); server.stdin.write(b); };
const next = (pred) => new Promise((ok) => { const look = () => { const i = got.findIndex(pred); if (i >= 0) { const [m] = got.splice(i, 1); waiting = null; ok(m); } else waiting = look; }; look(); });
const out = {};
send({ id: 1, method: "initialize", params: {} }); out.init = (await next((m) => m.id === 1)).result.capabilities;
const bad = 'define twice(n: number) -> number {\\n  return n * 2\\n}\\nlet total = twice(4)\\nprint(totl)\\n';
send({ method: "textDocument/didOpen", params: { textDocument: { uri, text: bad } } });
out.open = (await next((m) => m.method === "textDocument/publishDiagnostics")).params.diagnostics;
const good = bad.replace("totl", "total");
send({ method: "textDocument/didChange", params: { textDocument: { uri }, contentChanges: [{ text: good }] } });
out.mended = (await next((m) => m.method === "textDocument/publishDiagnostics")).params.diagnostics;
send({ id: 2, method: "textDocument/completion", params: { textDocument: { uri }, position: { line: 4, character: 6 } } });
out.completion = (await next((m) => m.id === 2)).result;
send({ id: 3, method: "textDocument/definition", params: { textDocument: { uri }, position: { line: 3, character: 13 } } });
out.definition = (await next((m) => m.id === 3)).result;
send({ id: 4, method: "textDocument/hover", params: { textDocument: { uri }, position: { line: 4, character: 7 } } });
out.hover = (await next((m) => m.id === 4)).result;
send({ method: "textDocument/didChange", params: { textDocument: { uri }, contentChanges: [{ text: "let  x=1\\nprint( x )\\n" }] } });
await next((m) => m.method === "textDocument/publishDiagnostics");
send({ id: 5, method: "textDocument/formatting", params: { textDocument: { uri }, options: {} } });
out.format = (await next((m) => m.id === 5)).result;
const fs = await import("node:fs"), path = await import("node:path"), url = await import("node:url");
const dir = path.dirname(url.fileURLToPath(uri));
fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
const libText = "export define twice(n: number) -> number {\\n  return n * 2\\n}\\n";
fs.writeFileSync(path.join(dir, "lib", "math.stride"), libText);
const libUri = url.pathToFileURL(path.join(dir, "lib", "math.stride")).href;
send({ method: "textDocument/didOpen", params: { textDocument: { uri: libUri, text: libText } } });
out.library = (await next((m) => m.method === "textDocument/publishDiagnostics" && m.params.uri === libUri)).params.diagnostics;
const useUri = url.pathToFileURL(path.join(dir, "uses.stride")).href;
send({ method: "textDocument/didOpen", params: { textDocument: { uri: useUri, text: 'use "math"\\nprint(twice(2))\\n' } } });
await next((m) => m.method === "textDocument/publishDiagnostics" && m.params.uri === useUri);
send({ id: 7, method: "textDocument/definition", params: { textDocument: { uri: useUri }, position: { line: 1, character: 7 } } });
out.libraryDefinition = (await next((m) => m.id === 7)).result;
out.libUri = libUri;
const emojiUri = url.pathToFileURL(path.join(dir, "emoji.stride")).href;
send({ method: "textDocument/didOpen", params: { textDocument: { uri: emojiUri, text: 'print("\\u{1F600}{missing}")\\n' } } });
out.emoji = (await next((m) => m.method === "textDocument/publishDiagnostics" && m.params.uri === emojiUri)).params.diagnostics;
// Lines ended by a lone CR (§1.2): navigation finds the same places.
const crUri = url.pathToFileURL(path.join(dir, "cr.stride")).href;
send({ method: "textDocument/didOpen", params: { textDocument: { uri: crUri, text: "define twice(n: number) -> number {\\r  return n * 2\\r}\\rprint(twice(2))\\r" } } });
out.crDiagnostics = (await next((m) => m.method === "textDocument/publishDiagnostics" && m.params.uri === crUri)).params.diagnostics;
send({ id: 8, method: "textDocument/definition", params: { textDocument: { uri: crUri }, position: { line: 3, character: 8 } } });
out.crDefinition = (await next((m) => m.id === 8)).result;
send({ id: 9, method: "textDocument/hover", params: { textDocument: { uri: crUri }, position: { line: 3, character: 8 } } });
out.crHover = (await next((m) => m.id === 9)).result;
// A library using one on disk that is not UTF-8 (byte FF): the mistake is the other file's, S001, said here.
fs.writeFileSync(path.join(dir, "lib", "bad.stride"), Buffer.concat([Buffer.from('export const LABEL = "'), Buffer.from([0xff]), Buffer.from('"\\n')]));
const consumerText = 'use "bad"\\nexport define label() -> text {\\n  return LABEL\\n}\\n';
fs.writeFileSync(path.join(dir, "lib", "consumer.stride"), consumerText);
const consumerUri = url.pathToFileURL(path.join(dir, "lib", "consumer.stride")).href;
send({ method: "textDocument/didOpen", params: { textDocument: { uri: consumerUri, text: consumerText } } });
out.consumer = (await next((m) => m.method === "textDocument/publishDiagnostics" && m.params.uri === consumerUri)).params.diagnostics;
send({ id: 6, method: "shutdown" }); await next((m) => m.id === 6); send({ method: "exit" });
console.log(JSON.stringify(out));
`;

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "stride-lsp-"));
  const uri = pathToFileURL(join(dir, "doubles.stride")).href;
  const problems = [];
  let out;
  try {
    out = JSON.parse(execFileSync("node", ["--input-type=module", "-e", CHILD, cli, uri], { encoding: "utf8", timeout: 30_000 }));
  } catch (e) {
    return [`the server's exchange did not finish: ${e.message.slice(0, 300)}`];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!out.init.completionProvider || !out.init.definitionProvider || !out.init.hoverProvider || !out.init.documentFormattingProvider) problems.push(`capabilities: ${JSON.stringify(out.init)}`);
  const m = out.open.find((d) => d.severity === 1);
  if (!m || !/^S\d{3}$/.test(m.code) || m.range.start.line !== 4 || m.range.start.character !== 6) problems.push(`the mistake on opening: ${JSON.stringify(out.open)}`);
  if (out.mended.some((d) => d.severity === 1)) problems.push(`mended, still: ${JSON.stringify(out.mended)}`);
  const labels = new Set(out.completion.map((c) => c.label));
  for (const l of ["define", "pad_left", "twice", "total"]) if (!labels.has(l)) problems.push(`completion has no ${l}`);
  if (!out.completion.find((c) => c.label === "pad_left")?.detail?.startsWith("pad_left(t: text")) problems.push("completion gives pad_left no signature");
  if (out.definition?.range?.start?.line !== 0) problems.push(`definition of twice: ${JSON.stringify(out.definition)}`);
  if (!/let total: number/.test(out.hover?.contents?.value ?? "")) problems.push(`hover on total: ${JSON.stringify(out.hover)}`);
  if (out.format?.[0]?.newText !== "let x = 1\nprint(x)\n") problems.push(`formatting: ${JSON.stringify(out.format)}`);
  if (out.library.some((d) => d.severity === 1)) problems.push(`a valid library opened on its own: ${JSON.stringify(out.library)}`);
  if (out.libraryDefinition?.uri !== out.libUri || out.libraryDefinition?.range?.start?.line !== 0) problems.push(`definition into the library: ${JSON.stringify(out.libraryDefinition)}, expected ${out.libUri}`);
  const missing = out.emoji.find((d) => d.code === "S201");
  if (out.crDiagnostics.some((d) => d.severity === 1)) problems.push(`the lone-CR file: ${JSON.stringify(out.crDiagnostics)}`);
  if (out.crDefinition?.range?.start?.line !== 0) problems.push(`definition in the lone-CR file: ${JSON.stringify(out.crDefinition)}`);
  if (!/define twice/.test(out.crHover?.contents?.value ?? "")) problems.push(`hover in the lone-CR file: ${JSON.stringify(out.crHover)}`);
  if (!out.consumer.some((d) => d.code === "S001" && /lib\/bad\.stride/.test(d.message))) problems.push(`a dependency that is not UTF-8: ${JSON.stringify(out.consumer)}`);
  if (missing?.range?.start?.character !== 10 || missing?.range?.end?.character !== 17) problems.push(`the place past an emoji: ${JSON.stringify(out.emoji)}`);
  return problems;
}
