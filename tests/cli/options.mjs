// rule 17.2 17.1 17.5 17.9
// The command line (§17, §17.5): an option the command does not take, one missing its value, more or fewer arguments
// than the command takes, a path to no file, a code that is not one, a test name no test has, and a fuzz count or seed
// that is not a whole number are usage mistakes (exit 2). An expected fault, and a generated program rightly refused
// or stopped at a budget, exit 0. `--1` is an expression, not an option; an answers file that is not JSON is said, not
// a crash.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const stride = (...args) => spawnSync("node", [cli, ...args], { encoding: "utf8", timeout: 20_000 });
  const problems = [];
  const expect = (args, status, out) => {
    const r = stride(...args);
    if (r.status !== status || !(r.stdout + r.stderr).includes(out) || /at .*\.mjs:\d+/.test(r.stderr)) problems.push(`${args.join(" ")}: expected exit ${status} with "${out}", got ${r.status}: ${r.stdout}${r.stderr}`);
  };
  expect(["eval", "1", "--import"], 2, "--import needs a value");
  expect(["eval", "1", "--foo"], 2, "stride eval: there is no option --foo");
  expect(["eval", "1", "--trace"], 2, "stride eval: there is no option --trace");
  expect(["eval", "1", "-o", "x"], 2, "stride eval: there is no option -o");
  expect(["check", "x.stride", "--trace"], 2, "stride check: there is no option --trace");
  expect(["explain", "S999"], 2, "S999 is not a Stride code");
  expect(["explain", "S318", "extra"], 2, "takes 1 argument");
  expect(["version", "extra"], 2, "takes 0 arguments");
  expect(["help"], 0, "stride help <command> says more");
  expect(["help", "run"], 0, "--trace");
  expect(["run", "--help"], 0, "example: stride run");
  expect(["--help"], 0, "usage:");
  expect(["help", "nosuch"], 2, "no command nosuch");
  expect(["nosuch"], 2, "no command nosuch");
  expect(["eval", "1", "--import", "nolib"], 2, "there is no lib/nolib.stride");
  expect(["eval", "--1"], 0, "1");
  expect(["compile", "x.stride", "-o"], 2, "-o needs a value");
  const dir = mkdtempSync(join(tmpdir(), "stride-options-"));
  try {
    const pdf = "0".repeat(64);
    writeFileSync(join(dir, "p.stride"), `form p\npdf ${pdf}\nask n: number "N"\nprint(n)\n`);
    writeFileSync(join(dir, "p.boxes.json"), JSON.stringify({ form: "p", pdf, boxes: [] }));
    writeFileSync(join(dir, "bad.json"), "{ not json");
    expect(["run", join(dir, "p.stride"), "--terminal", join(dir, "none.json")], 2, "no such file");
    expect(["check", join(dir, "none.stride")], 2, "no such file");
    expect(["fmt", join(dir, "none.stride")], 2, "no such file");
    expect(["compile", join(dir, "p.stride"), join(dir, "p.stride")], 2, "stride compile: takes 1 argument, and was given 2");
    expect(["run", join(dir, "p.stride"), "--terminal", join(dir, "bad.json")], 1, "not JSON");
    expect(["test", join(dir, "p.stride")], 1, "no tests in");
    writeFileSync(join(dir, "f.test.stride"), `function half(x: number) -> number {\n  return x / 0\n}\nexpect half(1) faults "F001"\n`);
    expect(["test", join(dir, "f.test.stride")], 0, "expectation passed");
    expect(["test", join(dir, "p.stride"), "nosuch"], 2, "there is no test nosuch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
