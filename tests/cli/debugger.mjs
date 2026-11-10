// rule 17.15
// The debugger. At the terminal: it stops before the first line; a breakpoint on a line in the program or in a
// library stops there in every turn; a line where no statement starts is refused; print, locals and where show the
// values and the calls; step goes into a call, next over it, out of it; the program's prints go to stdout. Through
// the Debug Adapter Protocol, as an editor drives it: initialize, launch, breakpoints (verified or not), stopped
// events, the stack, the values (a record's fields and a list's items as children), stepping, output, and the end.
// A program given by a relative path stops at its library's lines given by their full path.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// An editor's side of a DAP session, in a child, as JSON lines of what came back.
const CHILD = `
const { spawn } = await import("node:child_process");
const [cli, program, lib] = process.argv.slice(1);
const dap = spawn("node", [cli, "dap"]);
let buf = Buffer.alloc(0); const got = []; let seq = 1;
dap.stdout.on("data", (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const e = buf.indexOf("\\r\\n\\r\\n"); if (e < 0) break;
    const n = Number(/Content-Length: (\\d+)/.exec(buf.slice(0, e).toString())[1]);
    if (buf.length < e + 4 + n) break;
    got.push(JSON.parse(buf.slice(e + 4, e + 4 + n).toString())); buf = buf.slice(e + 4 + n);
  }
});
const send = (command, args = {}) => { const s = seq++; const b = Buffer.from(JSON.stringify({ seq: s, type: "request", command, arguments: args })); dap.stdin.write("Content-Length: " + b.length + "\\r\\n\\r\\n"); dap.stdin.write(b); return s; };
const wait = (f) => new Promise((ok, no) => { const t0 = Date.now(); const t = setInterval(() => { const i = got.findIndex(f); if (i >= 0) { clearInterval(t); ok(got.splice(i, 1)[0]); } else if (Date.now() - t0 > 15000) { clearInterval(t); no(new Error("waited for " + f)); } }, 10); });
const reply = (s) => wait((m) => m.type === "response" && m.request_seq === s);
const ev = (name) => wait((m) => m.type === "event" && m.event === name);
const out = {};
out.init = (await reply(send("initialize", { adapterID: "stride" }))).body;
await ev("initialized");
await reply(send("launch", { program, answers: { who: "Ada" } }));
out.breaks = (await reply(send("setBreakpoints", { source: { path: program }, breakpoints: [{ line: 7 }, { line: 1 }] }))).body.breakpoints;
await reply(send("setBreakpoints", { source: { path: lib }, breakpoints: [{ line: 2 }] }));
await reply(send("configurationDone"));
out.first = (await ev("stopped")).body.reason;
const frames = (await reply(send("stackTrace", { threadId: 1 }))).body.stackFrames;
out.firstFrame = frames.map((f) => f.name + ":" + f.line + ":" + (f.source?.path ?? "").split("/").pop());
const values = (await reply(send("variables", { variablesReference: frames[0].id }))).body.variables;
out.values = values.map((v) => v.name + "=" + v.value);
const p = values.find((v) => v.name === "p");
out.fields = p ? (await reply(send("variables", { variablesReference: p.variablesReference }))).body.variables.map((v) => v.name + "=" + v.value) : null;
out.evaluate = (await reply(send("evaluate", { expression: "total", frameId: frames[0].id }))).body.result;
await reply(send("continue", { threadId: 1 }));
await ev("stopped");
const inLib = (await reply(send("stackTrace", { threadId: 1 }))).body.stackFrames;
out.libFrames = inLib.map((f) => f.name + ":" + f.line + ":" + (f.source?.path ?? "").split("/").pop());
await reply(send("stepOut", { threadId: 1 }));
await ev("stopped");
out.afterOut = (await reply(send("stackTrace", { threadId: 1 }))).body.stackFrames.map((f) => f.name + ":" + f.line);
await reply(send("setBreakpoints", { source: { path: program }, breakpoints: [] }));
await reply(send("setBreakpoints", { source: { path: lib }, breakpoints: [] }));
await reply(send("continue", { threadId: 1 }));
out.output = (await ev("output")).body.output;
out.exit = (await ev("exited")).body.exitCode;
await ev("terminated");
await reply(send("disconnect"));
console.log(JSON.stringify(out));
process.exit(0);
`;

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "stride-debug-"));
  const problems = [];
  try {
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "lib", "maths.stride"), "export define twice(n: number) -> number {\n  let d = n * 2\n  return d\n}\n");
    writeFileSync(join(dir, "sum.stride"), 'use "maths"\nrecord person {\n  name: text\n}\nask who: text "Who"\nlet p = new person { name: who }\nvar total: number = 0\nfor i in 1..3 {\n  total = total + twice(i)\n}\nprint("{p.name}: {total}")\n');
    // At the terminal.
    const session = "list\nb 3\nb 9\nb lib/maths.stride:3\nc\np i\nlocals\nc\np d\nc\np i\ndelete lib/maths.stride:3\ns\nwhere\nn\np d\no\ndelete 9\nc\n";
    const r = spawnSync("node", [cli, "debug", "sum.stride", "who=Ada"], { cwd: dir, encoding: "utf8", input: session, timeout: 30_000 });
    const e = r.stderr;
    const want = [
      "stopped before its first line",
      "sum.stride:5  ask who: text \"Who\"",
      "→   5  ask who: text \"Who\"",
      "no statement starts on sum.stride:3",
      "stopping at sum.stride:9",
      "stopping at lib/maths.stride:3",
      "breakpoint at sum.stride:9  total = total + twice(i)",
      "i = 1",
      "  p = person { name: \"Ada\" }",
      "breakpoint at lib/maths.stride:3  return d",
      "d = 2",
      "breakpoint at sum.stride:9",
      "i = 2",
      "no longer stopping at lib/maths.stride:3",
      "lib/maths.stride:2  let d = n * 2",
      "  → twice  lib/maths.stride:2",
      "    main  sum.stride:9",
      "lib/maths.stride:3  return d",
      "d = 4",
      "breakpoint at sum.stride:9  total = total + twice(i)",
      "the program ended",
    ];
    let at = 0;
    for (const w of want) {
      const i = e.indexOf(w, at);
      if (i < 0) {
        problems.push(`the terminal debugger: expected, in order, ${JSON.stringify(w)} after ${JSON.stringify(e.slice(Math.max(0, at - 80), at))}; all of it:\n${e}`);
        break;
      }
      at = i + w.length;
    }
    if (r.status !== 0 || r.stdout !== "Ada: 12\n") problems.push(`the terminal debugger's run: exit ${r.status}, stdout ${JSON.stringify(r.stdout)}`);

    // A program in a folder, given by its relative path, with its library in lib/ beside it: a breakpoint on the
    // library's line, given by its full path, as an editor gives it, stops there.
    mkdirSync(join(dir, "bills", "lib"), { recursive: true });
    writeFileSync(join(dir, "bills", "lib", "half.stride"), "export define half(n: number) -> number {\n  return n / 2\n}\n");
    writeFileSync(join(dir, "bills", "main.stride"), 'use "half"\nprint(half(8))\n');
    const nested = spawnSync("node", [cli, "debug", "bills/main.stride"], { cwd: dir, encoding: "utf8", input: `b ${join(dir, "bills", "lib", "half.stride")}:2\nc\nwhere\nc\n`, timeout: 30_000 });
    if (!nested.stderr.includes("stopping at") || !nested.stderr.includes("breakpoint at lib/half.stride:2") || !nested.stderr.includes("main.stride:2") || nested.stdout !== "4\n") problems.push(`a library breakpoint for a program in a folder: stdout ${JSON.stringify(nested.stdout)}, stderr ${JSON.stringify(nested.stderr)}`);

    // Through DAP.
    let out;
    try {
      out = JSON.parse(spawnSync("node", ["--input-type=module", "-e", CHILD, cli, join(dir, "sum.stride"), join(dir, "lib", "maths.stride")], { encoding: "utf8", timeout: 40_000 }).stdout);
    } catch (x) {
      return [...problems, `the DAP session did not finish: ${x.message}`];
    }
    const same = (what, got, wanted) => JSON.stringify(got) !== JSON.stringify(wanted) && problems.push(`DAP ${what}: ${JSON.stringify(got)}, expected ${JSON.stringify(wanted)}`);
    same("initialize", out.init.supportsConfigurationDoneRequest, true);
    same("breakpoints", out.breaks.map((b) => [b.line, b.verified]), [[7, true], [1, false]]);
    same("the first stop", out.first, "breakpoint");
    same("its frame", out.firstFrame, ["main:7:sum.stride"]);
    same("its values", out.values, ['who="Ada"', 'p=person { name: "Ada" }']);
    same("a record's fields", out.fields, ['name="Ada"']);
    same("evaluate", out.evaluate, undefined);
    same("in the library", out.libFrames, ["twice:2:maths.stride", "main:9:sum.stride"]);
    same("after step out", out.afterOut, ["main:9"]);
    same("the output", out.output, "Ada: 12\n");
    same("the exit", out.exit, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
