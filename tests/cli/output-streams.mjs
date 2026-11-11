// rule 17.11
// What a command gives goes to stdout, all of it, however it is read; everything about it to stderr. A redirected
// run of four million bytes arrives whole, every time; a reader that stops early ends stride quietly. Warnings,
// mistakes and faults never mix into a program's output; --quiet drops warnings and status, never results, mistakes
// or faults; --json makes stdout one JSON document; colour follows --color and NO_COLOR; a folder or an unwritable
// path is said plainly, never as a stack trace.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "stride-streams-"));
  const stride = (args, options = {}) => spawnSync("node", [cli, ...args], { encoding: "utf8", timeout: 60_000, cwd: dir, ...options });
  const problems = [];
  const check = (what, ok, r) => ok || problems.push(`${what}: exit ${r?.status}, stdout ${JSON.stringify((r?.stdout ?? "").slice(0, 200))}, stderr ${JSON.stringify((r?.stderr ?? "").slice(0, 300))}`);
  try {
    // Every byte, redirected to a file, three times over.
    writeFileSync(join(dir, "big.stride"), 'let w = pad_left("", 1000, "x") + pad_left("", 1000, "x") + pad_left("", 1000, "x") + pad_left("", 1000, "x") + pad_left("", 96, "x")\nfor i in 1..1000 {\n  print(w)\n}\n');
    for (let k = 1; k <= 3; k++) {
      const r = spawnSync("sh", ["-c", `node "${cli}" run big.stride > big.out`], { cwd: dir, encoding: "utf8", timeout: 60_000 });
      const size = statSync(join(dir, "big.out")).size;
      check(`a redirected run, ${k}: ${size} bytes of 4097000`, r.status === 0 && size === 4097000 && r.stderr === "", r);
    }
    // A reader that stops after ten bytes: stride ends at once, quietly.
    const early = spawnSync("/bin/bash", ["-c", `node "${cli}" run big.stride | head -c 10; echo " status \${PIPESTATUS[0]}"`], { cwd: dir, encoding: "utf8", timeout: 60_000 });
    check("a reader that stops early", early.stdout === "xxxxxxxxxx status 0\n" && early.stderr === "", early);

    // Warnings and status on stderr; the program's lines alone on stdout.
    writeFileSync(join(dir, "warn.stride"), 'const UNUSED = 1\nprint("result")\n');
    let r = stride(["run", "warn.stride"]);
    check("a warning", r.status === 0 && r.stdout === "result\n" && r.stderr.includes("warning W003"), r);
    r = stride(["run", "warn.stride", "--quiet"]);
    check("--quiet: no warning, the result kept", r.status === 0 && r.stdout === "result\n" && r.stderr === "", r);
    r = stride(["check", "warn.stride", "-q"]);
    check("-q on check: nothing at all", r.status === 0 && r.stdout === "" && r.stderr === "", r);
    r = stride(["check", "warn.stride"]);
    check("check: the status on stderr", r.status === 0 && r.stdout === "" && /warn\.stride: no errors/.test(r.stderr), r);

    // A mistake: on stderr, nothing on stdout, even with --quiet.
    writeFileSync(join(dir, "bad.stride"), "print(nosuch)\n");
    for (const q of [[], ["-q"]]) {
      r = stride(["run", "bad.stride", ...q]);
      check(`a mistake ${q.join(" ")}`, r.status === 1 && r.stdout === "" && r.stderr.includes("error S201"), r);
    }
    // A fault: the lines before it on stdout, the fault on stderr, even with --quiet.
    writeFileSync(join(dir, "fault.stride"), 'ask n: number "N"\nprint("before")\nprint(10 / n)\n');
    r = stride(["run", "fault.stride", "n=0", "-q"]);
    check("a fault", r.status === 1 && r.stdout === "before\n" && r.stderr.startsWith("error F001: division by zero"), r);

    // --json: one document on stdout, nothing on stderr.
    const json = (args, what, test) => {
      const x = stride([...args, "--json"]);
      let doc = null;
      try {
        doc = JSON.parse(x.stdout);
      } catch {}
      check(`--json ${what}`, doc && x.stdout.trim().split("\n").length === 1 && x.stderr === "" && test(doc, x), x);
    };
    json(["run", "fault.stride", "n=0"], "run with a fault", (d, x) => x.status === 1 && d.ok === false && d.prints[0] === "before" && d.fault.code === "F001" && d.questions[0].key === "n");
    json(["run", "warn.stride"], "run with a warning", (d) => d.ok && d.prints[0] === "result" && d.diagnostics[0].code === "W003");
    json(["check", "bad.stride"], "check with a mistake", (d, x) => x.status === 1 && !d.ok && d.files[0].diagnostics[0].code === "S201");
    json(["compile", "warn.stride", "-o", "w.sbc"], "compile", (d) => d.ok && d.output === "w.sbc" && d.bytes > 0);
    json(["eval", "1 + 1"], "eval", (d) => d.ok && d.value === "2");
    json(["eval", "nosuch"], "eval with a mistake", (d, x) => x.status === 1 && !d.ok && d.diagnostics[0].code === "S201");
    mkdirSync(join(dir, "warn.tests"));
    writeFileSync(join(dir, "warn.tests", "one.json"), JSON.stringify({ prints: ["result"] }));
    json(["test", "warn.stride"], "test", (d) => d.ok && d.files[0].tests[0].name === "one" && d.files[0].tests[0].ok);

    // Colour: always, never, and auto off when not a terminal or NO_COLOR is set.
    r = stride(["run", "bad.stride", "--color=always"]);
    check("--color=always", r.stderr.includes("\x1b["), r);
    for (const [args, env] of [[["--color=never"], {}], [[], {}], [["--color=auto"], { NO_COLOR: "1" }]]) {
      r = stride(["run", "bad.stride", ...args], { env: { ...process.env, ...env } });
      check(`no colour ${args.join(" ")} ${JSON.stringify(env)}`, !r.stderr.includes("\x1b[") && r.stderr.includes("S201"), r);
    }
    r = stride(["run", "bad.stride", "--color=pink"]);
    check("--color=pink", r.status === 2 && r.stderr.includes("--color takes auto, always or never"), r);

    // Files: a folder, an unwritable output, said plainly.
    mkdirSync(join(dir, "folder.stride"));
    r = stride(["run", "folder.stride"]);
    check("a folder named .stride", r.status === 2 && r.stderr.includes("a folder, not a file") && !/\.mjs:\d+/.test(r.stderr), r);
    r = stride(["compile", "warn.stride", "-o", join(dir, "no", "such", "w.sbc")]);
    check("an output whose folder is not there", r.status === 1 && r.stderr.includes("cannot be written (its folder is not there)") && !/\.mjs:\d+/.test(r.stderr), r);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}

