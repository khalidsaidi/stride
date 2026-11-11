// rule 17.16
// The language server's help with names: after `m.` a library kept as m offers what it exports, after `p.` a
// record's fields; inside a call's brackets, its signature and which argument the cursor is at; every place a name is
// used, in every file; renaming one in every file, refusing a name of the standard library and a keyword.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const CHILD = `
const { spawn } = await import("node:child_process");
const [cli, uri, text] = process.argv.slice(1);
const server = spawn("node", [cli, "lsp"]);
let buf = Buffer.alloc(0); const got = [];
server.stdout.on("data", (c) => { buf = Buffer.concat([buf, c]); for (;;) { const e = buf.indexOf("\\r\\n\\r\\n"); if (e < 0) break; const n = Number(/Content-Length: (\\d+)/.exec(buf.slice(0, e).toString())[1]); if (buf.length < e + 4 + n) break; got.push(JSON.parse(buf.slice(e + 4, e + 4 + n))); buf = buf.slice(e + 4 + n); } });
const send = (m) => { const b = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...m })); server.stdin.write("Content-Length: " + b.length + "\\r\\n\\r\\n"); server.stdin.write(b); };
const wait = (f) => new Promise((ok) => { const t = setInterval(() => { const i = got.findIndex(f); if (i >= 0) { clearInterval(t); ok(got.splice(i, 1)[0]); } }, 10); });
let id = 1;
const ask = async (method, params) => { const n = id++; send({ id: n, method, params }); return (await wait((m) => m.id === n)); };
await ask("initialize", {});
send({ method: "textDocument/didOpen", params: { textDocument: { uri, text } } });
await wait((m) => m.method === "textDocument/publishDiagnostics");
const at = (line, character) => ({ textDocument: { uri }, position: { line, character } });
const where = (r) => r.uri.split("/").pop() + ":" + r.range.start.line + ":" + r.range.start.character + "-" + r.range.end.character;
const out = {};
out.capabilities = (await ask("initialize", {})).result.capabilities;
out.module = (await ask("textDocument/completion", at(6, 8))).result.map((i) => i.label);
out.fields = (await ask("textDocument/completion", at(6, 16))).result.map((i) => i.label + ":" + i.detail);
out.signature = (await ask("textDocument/signatureHelp", at(6, 14))).result;
out.signature2 = (await ask("textDocument/signatureHelp", at(7, 23))).result;
out.refs = (await ask("textDocument/references", { ...at(6, 15), context: { includeDeclaration: true } })).result.map(where);
out.libRefs = (await ask("textDocument/references", { ...at(6, 9), context: { includeDeclaration: true } })).result.map(where);
const rename = (await ask("textDocument/rename", { ...at(6, 9), newName: "double" })).result.changes;
out.rename = Object.entries(rename).map(([u, edits]) => u.split("/").pop() + ":" + edits.map((e) => e.range.start.line + ":" + e.range.start.character + "=" + e.newText).join(","));
out.renameStd = (await ask("textDocument/rename", { ...at(7, 8), newName: "pad" })).error?.message;
out.renameKeyword = (await ask("textDocument/rename", { ...at(6, 15), newName: "function" })).error?.message;
console.log(JSON.stringify(out));
process.exit(0);
`;

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "stride-lsp-nav-"));
  const problems = [];
  try {
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "lib", "maths.stride"), "export function twice(n: number) -> number {\n  return n * 2\n}\n");
    const text = 'import "maths" as m\nrecord person {\n  name: string\n  age: number\n}\nlet p = new person { name: "Ada", age: 36 }\nprint(m.twice(p.age))\nprint(pad_left(p.name, 9, "."))\n';
    writeFileSync(join(dir, "main.stride"), text);
    const out = JSON.parse(execFileSync("node", ["--input-type=module", "-e", CHILD, cli, pathToFileURL(join(dir, "main.stride")).href, text], { encoding: "utf8", timeout: 30_000 }));
    const same = (what, got, wanted) => JSON.stringify(got) !== JSON.stringify(wanted) && problems.push(`${what}: ${JSON.stringify(got)}, expected ${JSON.stringify(wanted)}`);
    same("capabilities", [!!out.capabilities.signatureHelpProvider, out.capabilities.referencesProvider, out.capabilities.renameProvider], [true, true, true]);
    same("after m.", out.module, ["twice"]);
    same("after p.", out.fields, ["name:string", "age:number"]);
    same("a library function's signature", [out.signature?.signatures[0].label, out.signature?.activeParameter], ["twice(n: number) -> number", 0]);
    same("the standard library's, at its second argument", [out.signature2?.signatures[0].label, out.signature2?.activeParameter], ['pad_left(t: string, width: number, padding: string = " ") -> string', 1]);
    same("references to p", out.refs, ["main.stride:5:4-5", "main.stride:6:14-15", "main.stride:7:15-16"]);
    same("references to a library's function", out.libRefs, ["maths.stride:0:16-21", "main.stride:6:8-13"]);
    same("renaming it in both files", out.rename.sort(), ["main.stride:6:8=double", "maths.stride:0:16=double"]);
    same("renaming the standard library's", out.renameStd, "pad_left is the standard library's: it is not renamed");
    same("renaming to a keyword", out.renameKeyword, "function is not a name Stride takes (§2.1)");
  } catch (e) {
    problems.push(`the exchange did not finish: ${e.message.slice(0, 300)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
