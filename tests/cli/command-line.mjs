// rule 17.10 17.12
// The command line as most tools have it: --version and -h; --name=value and --name value; -q; `--` ending the
// options, so a file or an expression starting with a dash is taken as it is; a negative number never an option; a
// file name with spaces; an option given twice, without its value, or unknown, a usage mistake naming the command's
// own usage. And the answers a run is given: key=value (an any-of's options with commas), a JSON file, JSON on stdin,
// answers typed in turn with --prompt, a script read from stdin, and what may not be combined.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "stride-cmdline-"));
  const stride = (args, input) => spawnSync("node", [cli, ...args], { encoding: "utf8", timeout: 30_000, cwd: dir, input });
  const problems = [];
  const expect = (args, status, stdout, stderr = null, input) => {
    const r = stride(args, input);
    const outOk = stdout instanceof RegExp ? stdout.test(r.stdout) : r.stdout === stdout;
    const errOk = stderr === null || (stderr instanceof RegExp ? stderr.test(r.stderr) : r.stderr === stderr);
    if (r.status !== status || !outOk || !errOk || /\.mjs:\d+/.test(r.stderr)) problems.push(`${args.join(" ")}${input !== undefined ? ` <<< ${JSON.stringify(input)}` : ""}: expected exit ${status}, stdout ${stdout}, stderr ${stderr}; got ${r.status}, ${JSON.stringify(r.stdout.slice(0, 200))}, ${JSON.stringify(r.stderr.slice(0, 300))}`);
  };
  try {
    // Help and version.
    expect(["--version"], 0, /^stride \d+\.\d+\.\d+ \(build [^)]+\): the language \d+\.\d+\.\d+ \(§21\), bytecode version \d+/, "");
    expect(["version"], 0, /^stride \d/, "");
    expect(["-h"], 0, /^stride .*usage:/s, "");
    expect(["run", "-h"], 0, /^stride run .*--prompt/s, "");
    // Options: = and space, short forms, --, and the mistakes.
    writeFileSync(join(dir, "-odd name.stride"), 'print("odd")\n');
    expect(["run", "--", "-odd name.stride"], 0, "odd\n", "");
    // Only a dash and one letter is a short option: a longer word starting with a dash is an argument.
    expect(["run", "-odd name.stride"], 0, "odd\n", "");
    writeFileSync(join(dir, "-q"), 'print("a file named -q")\n');
    expect(["run", "--", "-q"], 2, "", /a Stride program ends in \.stride/);
    expect(["eval", "1", "--color=never"], 0, "1\n", "");
    expect(["eval", "1", "--use", "a", "--use", "b"], 2, "", /--use is given twice/);
    expect(["eval", "1", "--use"], 2, "", /--use needs a value: --use name/);
    expect(["eval", "1", "--quiet=yes"], 2, "", /--quiet takes no value/);
    expect(["run", "x.stride", "-z"], 2, "", /^stride run: there is no option -z\nusage: stride run .*\nstride help run says more\.\n$/s);
    expect(["eval", "-1"], 0, "-1\n", "");
    expect(["eval", "-abs(2)"], 0, "-2\n", "");
    expect(["eval", "--", "-(1 + 2)"], 0, "-3\n", "");
    expect(["eval", "--today=2026-01-31", "today()"], 0, "2026-01-31\n", "");
    expect(["eval", "--today", "-1", "today()"], 2, "", /--today takes a date written YYYY-MM-DD, and this is "-1"/);
    expect(["nosuch"], 2, "", /^stride: no command nosuch\n/);

    // Answers.
    writeFileSync(join(dir, "greet.stride"), 'options colour {\n  "red" "Red"\n  "green" "Green"\n  "blue" "Blue"\n}\nask name: text "Your name"\nask likes: any-of colour "Colours you like"\nask fav: one-of colour "Your favourite"\nask tea: yes-no "Tea?"\nprint("{name ?? "nobody"}: {join(likes ?? [])}; {fav ?? "none"}; {tea ?? no}")\n');
    expect(["run", "greet.stride", "name=Ada", "likes=red,blue", "fav=green", "tea=yes"], 0, "Ada: red, blue; green; yes\n", "");
    writeFileSync(join(dir, "a.json"), JSON.stringify({ name: "Bo", likes: ["green"] }));
    expect(["run", "greet.stride", "a.json"], 0, "Bo: green; none; no\n", "");
    expect(["run", "greet.stride", "a.json", "name=Cy"], 0, "Cy: green; none; no\n", "");
    expect(["run", "greet.stride", "-"], 0, "Di: red; none; no\n", "", JSON.stringify({ name: "Di", likes: ["red"] }));
    expect(["run", "greet.stride", "--prompt", "-q"], 0, "Ed: red, blue; blue; yes\n", /Your name\n.*Colours you like\n  1\. Red \(red\)/s, "Ed\n1,3\n3\ny\n");
    expect(["run", "greet.stride", "--prompt", "-q"], 0, "nobody: ; none; no\n", null, "\n\n\n\n");
    expect(["run", "greet.stride", "--prompt", "--no-prompt"], 2, "", /opposites/);
    expect(["run", "greet.stride", "a.json", "b.json"], 2, "", /one answers file only/);
    expect(["run", "-"], 0, "3\n", "", "print(1 + 2)\n");
    expect(["run", "-", "-"], 2, "", /stdin holds the program/, "print(1)\n");
    // Not at a terminal and given nothing: nothing is asked, the questions stay unanswered.
    expect(["run", "greet.stride"], 0, "nobody: ; none; no\n", "", "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
