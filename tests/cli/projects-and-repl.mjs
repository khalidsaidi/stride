// rule 4.7 17.13 17.14 17.17
// A project: `stride init` makes stride.json and lib/; a program in a folder under it uses the project's lib/, and a
// folder stride.json names; a project needing a newer Stride says so; `stride test`, `stride check` and `stride fmt`
// with no file take every program in the folder and below, --match choosing tests; a compiled program copied away
// from its source runs, and its tests with it. And `stride repl`: what is typed is kept, expressions show their
// values, mistakes and faults keep nothing, questions are asked as they come.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const top = mkdtempSync(join(tmpdir(), "stride-project-"));
  const dir = join(top, "forms");
  const stride = (args, { cwd = dir, input } = {}) => spawnSync("node", [cli, ...args], { encoding: "utf8", timeout: 30_000, cwd, input });
  const problems = [];
  const check = (what, ok, r) => ok || problems.push(`${what}: exit ${r?.status}, stdout ${JSON.stringify((r?.stdout ?? "").slice(0, 300))}, stderr ${JSON.stringify((r?.stderr ?? "").slice(0, 300))}`);
  try {
    mkdirSync(dir);
    let r = stride(["init"]);
    check("init", r.status === 0 && JSON.parse(readFileSync(join(dir, "stride.json"), "utf8")).stride === "1.0", r);
    r = stride(["init"]);
    check("init again", r.status === 1 && r.stderr.includes("is there already"), r);
    // A library in the project's lib/, one in a folder stride.json names, a program two folders down using both.
    writeFileSync(join(dir, "lib", "money.stride"), 'export function dollars(n: number) -> string {\n  return "${grouped(n, 2)}"\n}\n');
    mkdirSync(join(top, "shared", "lib"), { recursive: true });
    writeFileSync(join(top, "shared", "lib", "names.stride"), 'export function polite(n: string) -> string {\n  return "Dear {n}"\n}\n');
    writeFileSync(join(dir, "stride.json"), JSON.stringify({ stride: "1.0", libraries: ["../shared/lib"] }));
    mkdirSync(join(dir, "pay", "w9"), { recursive: true });
    writeFileSync(join(dir, "pay", "w9", "bill.stride"), 'import "money"\nimport "names" as n\nask who: string "Who"\nask owed: number "Owed"\nprint("{n.polite(who)}: {dollars(owed)}")\n');
    r = stride(["run", "pay/w9/bill.stride", "who=Ada", "owed=1234.5"]);
    check("the project's libraries", r.status === 0 && r.stdout === "Dear Ada: $1,234.50\n", r);
    mkdirSync(join(dir, "pay", "w9", "bill.tests"));
    writeFileSync(join(dir, "pay", "w9", "bill.tests", "ada.json"), JSON.stringify({ answers: { who: "Ada", owed: "10" }, prints: ["Dear Ada: $10.00"] }));
    writeFileSync(join(dir, "pay", "w9", "bill.tests", "bo.json"), JSON.stringify({ answers: { who: "Bo", owed: "2" }, prints: ["Dear Bo: $2.00"] }));
    writeFileSync(join(dir, "lib", "money.test.stride"), 'import "money"\nexpect dollars(1) == "$1.00"\n');
    r = stride(["test"]);
    check("test with no file", r.status === 0 && /3 tests passed in 2 files/.test(r.stdout), r);
    r = stride(["test", "--match", "bo"]);
    check("test --match", r.status === 0 && r.stdout.includes("ok   bo") && !r.stdout.includes("ok   ada"), r);
    r = stride(["test", "pay"]);
    check("test a folder", r.status === 0 && /2 tests passed/.test(r.stdout), r);
    r = stride(["check", "-q"]);
    check("check with no file", r.status === 0 && r.stderr === "", r);
    writeFileSync(join(dir, "pay", "messy.stride"), "let  x=1\nprint( x )\n");
    r = stride(["fmt", "--check", "."]);
    check("fmt --check a folder", r.status === 1 && r.stdout === "pay/messy.stride\n", r);
    r = stride(["fmt", ".", "-q"]);
    check("fmt a folder", r.status === 0 && readFileSync(join(dir, "pay", "messy.stride"), "utf8") === "let x = 1\nprint(x)\n", r);
    // A project needing a newer Stride.
    writeFileSync(join(dir, "stride.json"), JSON.stringify({ stride: "1.9" }));
    r = stride(["run", "pay/w9/bill.stride"]);
    check("a newer Stride needed", r.status === 1 && r.stderr.includes("the project needs Stride 1.9") && r.stderr.includes("upgrade stride"), r);
    writeFileSync(join(dir, "stride.json"), JSON.stringify({ stride: "1.0", libraries: ["../shared/lib"] }));
    // Compiled, copied away from its source and libraries: it runs, and so do its tests.
    r = stride(["compile", "pay/w9/bill.stride", "-o", "bill.sbc", "-q"]);
    const away = join(top, "elsewhere");
    mkdirSync(away);
    cpSync(join(dir, "bill.sbc"), join(away, "bill.sbc"));
    cpSync(join(dir, "pay", "w9", "bill.tests"), join(away, "bill.tests"), { recursive: true });
    r = stride(["run", "bill.sbc", "who=Cy", "owed=3"], { cwd: away });
    check("the compiled program, elsewhere", r.status === 0 && r.stdout === "Dear Cy: $3.00\n", r);
    r = stride(["test", "bill.sbc"], { cwd: away });
    check("its tests, elsewhere", r.status === 0 && /2 tests passed/.test(r.stdout), r);

    // The session.
    const session = 'let names = ["Ada", "Bo"]\nnames[1]\nfunction twice(n: number) -> number {\n  return n * 2\n}\ntwice(21)\nprint("printed once")\nnosuch\n1 / 0\nask age: number "Your age"\n40\nage + 1\n:list\n';
    r = stride(["repl"], { cwd: top, input: session });
    const outLines = r.stdout.split("\n");
    check("the session's values", r.status === 0 && outLines[0] === "Bo" && outLines[1] === "42" && outLines[2] === "printed once" && outLines[3] === "41", r);
    check("the session's mistakes kept nothing", r.stderr.includes("mistake S201") && r.stderr.includes("fault F001") && r.stdout.includes("3  print(\"printed once\")") && !r.stdout.includes("nosuch"), r);
    check("the session asked its question", r.stderr.includes("Your age"), r);
    // A call that changes a list is shown its value and kept, so the list stays changed; another call is not kept.
    r = stride(["repl"], { cwd: top, input: "let l = [1]\nappend(l, 2)\ncount(l)\nremove_at(l, 0)\nl\n:list\n" });
    check("the session keeps a list changed in place", r.status === 0 && r.stdout === "[1, 2]\n2\n1\n[2]\n  1  let l = [1]\n  2  append(l, 2)\n  3  remove_at(l, 0)\n", r);
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
  return problems;
}
