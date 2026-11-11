// rule 17.12 17.15 17.11
// One program, one set of answers, every way of running it: key=value words, a JSON file, JSON on stdin, typed at
// the prompt, traced, debugged, as JSON. Each prints the same lines. The answers hold what is easy to lose: keys of a
// question asked in a function call (`ask_person.age`, its `.` inside the key), an any-of's options, words with
// a character beyond the first 64 thousand (an emoji) sitting across the point where stdin is read in two, a
// question whose default would fault (asked at the prompt all the same), and a record printed whole.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROGRAM = `record person {
  name: text
  age: number
}
options colour {
  "red" "Red"
  "blue" "Blue"
}
define ask_person(n: number) -> person {
  ask name: text "Name {n}"
  ask age: number "Age {n}" default 0
  return new person { name: name, age: age }
}
ask likes: any-of colour "Likes"
let p = ask_person(1)
print(p)
print(join(likes))
print(100 / p.age)
`;

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "stride-modes-"));
  const problems = [];
  const stride = (args, input) => spawnSync("node", [cli, ...args], { cwd: dir, encoding: "utf8", input, timeout: 60_000 });
  try {
    writeFileSync(join(dir, "people.stride"), PROGRAM);
    // At the prompt, the answer to "Likes" is "1,2\n": four bytes, so the name's emoji starts at byte 4094 and is
    // read in two parts.
    const name = `${"a".repeat(4090)}😀 Zoë`;
    const answers = { likes: ["red", "blue"], "ask_person.name": name, "ask_person.age": "4" };
    writeFileSync(join(dir, "answers.json"), JSON.stringify(answers));
    const want = `person { name: ${name}, age: 4 }\nred, blue\n25\n`;
    const words = ["likes=red,blue", `ask_person.name=${name}`, "ask_person.age=4"];
    const runs = {
      "key=value": stride(["run", "people.stride", ...words]),
      "a JSON file": stride(["run", "people.stride", "answers.json"]),
      "JSON on stdin": stride(["run", "people.stride", "-"], JSON.stringify(answers)),
      "typed at the prompt": stride(["run", "people.stride", "--prompt", "-q"], `1,2\n${name}\n4\n`),
      traced: stride(["run", "people.stride", ...words, "--trace"]),
      debugged: stride(["debug", "people.stride", ...words], "c\n"),
    };
    for (const [how, r] of Object.entries(runs)) if (r.stdout !== want || r.status !== 0) problems.push(`${how}: exit ${r.status}, stdout ${JSON.stringify(r.stdout.slice(-120))}, stderr ${JSON.stringify(r.stderr.slice(-300))}`);
    const json = stride(["run", "people.stride", ...words, "--json"]);
    let doc = null;
    try {
      doc = JSON.parse(json.stdout);
    } catch {}
    if (!doc || doc.prints.join("\n") + "\n" !== want || doc.questions.find((q) => q.key === "ask_person.age")?.value !== "4") problems.push(`as JSON: ${json.stdout.slice(-300)}`);
    // The default would fault (100 / 0): the prompt asks for the age all the same, and the answer given is used.
    const prompted = runs["typed at the prompt"].stderr;
    if (!prompted.includes("Age 1 [0]")) problems.push(`the prompt did not ask the question whose default faults: ${prompted.slice(-300)}`);
    // Run on its default, it faults, the same in every engine: the run and the debugger say it alike.
    const faulted = [stride(["run", "people.stride", "likes=red", "ask_person.name=Bo"]), stride(["debug", "people.stride", "likes=red", "ask_person.name=Bo"], "c\n")];
    const said = (r) => r.stderr.slice(r.stderr.indexOf("fault F001")).replace(/\n\(debug\)[\s\S]*$/, "").trim();
    if (faulted.some((r) => r.status !== 1) || said(faulted[0]) !== said(faulted[1]) || !said(faulted[0]).includes("at main, people.stride:18:11")) problems.push(`the fault, run and debugged: ${JSON.stringify(said(faulted[0]))} and ${JSON.stringify(said(faulted[1]))}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
