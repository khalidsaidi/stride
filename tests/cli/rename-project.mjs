// rule 17.16
// Renaming in a project, as an editor does it: the edits the server gives are made to the files, and the project is
// checked and run again. A library's function renamed from one caller is renamed in the library and in every file of
// the project that calls it, the other caller included, and every caller still runs as before; references find every
// caller. A rename that would break the program is refused before any edit: to a word of another language (§2.4), to
// a name already declared where it would capture or be captured, to a standard library name. A library in a folder
// stride.json names is checked as the library it is.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const CHILD = `
const { spawn } = await import("node:child_process");
const { readFileSync } = await import("node:fs");
const [cli, dir] = process.argv.slice(1);
const server = spawn("node", [cli, "lsp"]);
let buf = Buffer.alloc(0); const got = [];
server.stdout.on("data", (c) => { buf = Buffer.concat([buf, c]); for (;;) { const e = buf.indexOf("\\r\\n\\r\\n"); if (e < 0) break; const n = Number(/Content-Length: (\\d+)/.exec(buf.slice(0, e).toString())[1]); if (buf.length < e + 4 + n) break; got.push(JSON.parse(buf.slice(e + 4, e + 4 + n))); buf = buf.slice(e + 4 + n); } });
const send = (m) => { const b = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...m })); server.stdin.write("Content-Length: " + b.length + "\\r\\n\\r\\n"); server.stdin.write(b); };
const wait = (f) => new Promise((ok) => { const t = setInterval(() => { const i = got.findIndex(f); if (i >= 0) { clearInterval(t); ok(got.splice(i, 1)[0]); } }, 10); });
let id = 1;
const ask = async (method, params) => { const n = id++; send({ id: n, method, params }); return (await wait((m) => m.id === n)); };
const open = async (file) => { const uri = "file://" + dir + "/" + file; send({ method: "textDocument/didOpen", params: { textDocument: { uri, text: readFileSync(dir + "/" + file, "utf8") } } }); return (await wait((m) => m.method === "textDocument/publishDiagnostics" && m.params.uri === uri)).params.diagnostics; };
const at = (file, line, character) => ({ textDocument: { uri: "file://" + dir + "/" + file }, position: { line, character } });
await ask("initialize", {});
const out = {};
out.vendor = (await open("vendor/greet.stride")).map((d) => d.code + " " + d.message);
await open("a.stride");
out.refs = (await ask("textDocument/references", { ...at("a.stride", 1, 9), context: { includeDeclaration: true } })).result.map((r) => r.uri.split("/").pop() + ":" + r.range.start.line).sort();
out.rename = (await ask("textDocument/rename", { ...at("a.stride", 1, 9), newName: "double" })).result?.changes ?? null;
out.toWhile = (await ask("textDocument/rename", { ...at("a.stride", 2, 8), newName: "while" })).error?.message;
out.toY = (await ask("textDocument/rename", { ...at("a.stride", 2, 8), newName: "y" })).error?.message;
out.toUpper = (await ask("textDocument/rename", { ...at("a.stride", 2, 8), newName: "upper" })).error?.message;
out.toZ = Object.keys((await ask("textDocument/rename", { ...at("a.stride", 2, 8), newName: "z" })).result?.changes ?? {}).map((u) => u.split("/").pop());
console.log(JSON.stringify(out));
process.exit(0);
`;

// Edits in the protocol's places, made to a file's text.
function applied(text, edits) {
  const offset = ({ line, character }) => text.split("\n").slice(0, line).reduce((n, l) => n + l.length + 1, 0) + character;
  return [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start)).reduce((t, e) => t.slice(0, offset(e.range.start)) + e.newText + t.slice(offset(e.range.end)), text);
}

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "stride-rename-"));
  const problems = [];
  const same = (what, got, wanted) => JSON.stringify(got) !== JSON.stringify(wanted) && problems.push(`${what}: ${JSON.stringify(got)}, expected ${JSON.stringify(wanted)}`);
  try {
    writeFileSync(join(dir, "stride.json"), JSON.stringify({ stride: "1.0", libraries: ["vendor"] }));
    mkdirSync(join(dir, "lib"));
    mkdirSync(join(dir, "vendor"));
    writeFileSync(join(dir, "lib", "maths.stride"), "export define twice(n: number) -> number {\n  return n * 2\n}\n");
    writeFileSync(join(dir, "vendor", "greet.stride"), 'export define hello(who: text) -> text {\n  return "Hello, {who}"\n}\n');
    writeFileSync(join(dir, "a.stride"), 'use "maths"\nlet x = twice(2)\nlet y = x + 1\nprint(x)\nprint(y)\n');
    writeFileSync(join(dir, "b.stride"), 'use "maths"\nuse "greet"\nprint(twice(5))\nprint(hello("Bo"))\n');
    const out = JSON.parse(execFileSync("node", ["--input-type=module", "-e", CHILD, cli, dir], { encoding: "utf8", timeout: 60_000 }));
    same("a library in a folder stride.json names", out.vendor, []);
    same("references from one caller find the other", out.refs, ["a.stride:1", "b.stride:2", "maths.stride:0"]);
    same("the rename's files", Object.keys(out.rename ?? {}).map((u) => u.split("/").pop()).sort(), ["a.stride", "b.stride", "maths.stride"]);
    // The edits made, the project checked and run as before.
    for (const [uri, edits] of Object.entries(out.rename ?? {})) {
      const path = fileURLToPath(uri);
      writeFileSync(path, applied(readFileSync(path, "utf8"), edits));
    }
    const check = spawnSync("node", [cli, "check", "-q"], { cwd: dir, encoding: "utf8" });
    same("the project checked after the rename", [check.status, check.stderr], [0, ""]);
    same("a.stride after", spawnSync("node", [cli, "run", "a.stride"], { cwd: dir, encoding: "utf8" }).stdout, "4\n5\n");
    same("b.stride after", spawnSync("node", [cli, "run", "b.stride"], { cwd: dir, encoding: "utf8" }).stdout, "10\nHello, Bo\n");
    same("the library after", readFileSync(join(dir, "lib", "maths.stride"), "utf8").startsWith("export define double("), true);
    same("to a word of another language", out.toWhile, "while is another language's word, which Stride does not take as a name (§2.4)");
    same("to a name declared there", out.toY?.startsWith("renaming x to y would"), true);
    same("to a standard library name", out.toUpper, "upper is the standard library's upper: another name keeps both");
    same("a local's rename stays in its file", out.toZ, ["a.stride"]);
  } catch (e) {
    problems.push(`the exchange did not finish: ${e.message.slice(0, 400)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
