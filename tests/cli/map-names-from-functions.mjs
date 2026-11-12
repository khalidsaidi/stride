// rule 17.6.1
// `stride map` follows a box named by what a Stride function returns: the names its returns may give, from what
// the call gives it. `run_of("Notes", 3)` handed to a helper is the run Notes, Notes_2, Notes_3; `numbered("City", 2)`
// is City_2, also through a let; `yes_box(n)` at the turns of `members[..<2]` is Yes or Yes_2, and never Yes_3; a
// helper given a position the run decides gives each name that fits (`Title_…`); a name made of an option is each
// of the option's names; the boxes of a constant table zipped with answers are its own. Each is credited to the
// answers written into it, and a box no run writes stays not written. A name the compiler can tell nothing of (a
// function that gives back the answer it is given) is still said as some box named as the program runs.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PDF = "0".repeat(64);
const TEXT = ["Notes", "Notes_2", "Notes_3", "Notes_4", "City", "City_2", "City_3", "Zip", "Zip_2", "Member", "Member_2", "Member_3", "Yes", "Yes_2", "Yes_3", "No_1", "No_2", "No_3", "Text1", "Title_1", "Title_2", "W1", "W2", "WD1", "Free"];
const CHECKS = ["Organ heart", "Organ lung", "Organ skin"];
const SOURCE = `form m
pdf ${PDF}
enum organ {
  "heart" "Heart"
  "lung" "Lung"
}
record member {
  name: string
  filed: bool
}
record pair {
  name: string
  date: string
}
const PAIRS = [new pair { name: "W1", date: "WD1" }, new pair { name: "W2", date: "WD2" }]

function run_of(base: string, n: number) -> list<string> {
  return [base] + ["{base}_{k}" for k in 2..n]
}
function fill_lines(boxes: list<string>, text: string) {
  for i, w in split(text ?? "", " ") {
    if i < count(boxes) {
      fill boxes[i] = w
    }
  }
}
function numbered(base: string, k: number) -> string {
  return if k == 1 then base else "{base}_{k}"
}
function yes_box(n: number) -> string {
  return if n == 0 then "Yes" else "Yes_{n + 1}"
}
function no_box(n: number) -> string {
  return "No_{n + 1}"
}
function title_box(n: number) -> string {
  return if n == 0 then "Text1" else "Title_{n}"
}
function same(w: string) -> string {
  return w
}
function ask_city(whose: string, k: number) {
  ask city: string "{whose}: city"
  fill numbered("City", k) = city
}

ask notes: string "Notes"
fill_lines(run_of("Notes", 3), notes)
ask_city("Home", 1) as "home"
ask_city("Mail", 2) as "mail"
ask code: string "ZIP"
let zip_box = numbered("Zip", 2)
fill zip_box = code
var members: list<member>
collect m in members "Another member?" {
  ask m.name: string "Member's name"
  ask m.filed: bool "Did they file?"
}
for n, m in members[..<2] {
  fill numbered("Member", n + 1) = m.name
  if m.filed != null {
    let b = if m.filed then yes_box(n) else no_box(n)
    fill b = "X"
  }
}
var titles: list<string>
collect t in titles "Another title?" {
  ask t: string "Title"
}
for n, t in titles {
  fill title_box(n) = t
}
ask organs: any_of organ "Organs"
for o in organs {
  tick "Organ {o}" when true
}
var witnesses: list<string>
collect w in witnesses "Another witness?" {
  ask w: string "Witness"
}
for (p, w) in zip(PAIRS, witnesses) {
  fill p.name = w
}
ask where: string "Which box?"
fill same(where) = "x"
`;

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "stride-map-"));
  const problems = [];
  try {
    writeFileSync(join(dir, "m.stride"), SOURCE);
    writeFileSync(join(dir, "m.boxes.json"), JSON.stringify({ form: "m", pdf: PDF, boxes: [...TEXT.map((field) => ({ field, kind: "text" })), ...CHECKS.map((field) => ({ field, kind: "check" }))] }));
    const r = spawnSync("node", [cli, "map", "m.stride", "--json"], { cwd: dir, encoding: "utf8", timeout: 30_000 });
    let map;
    try {
      map = JSON.parse(r.stdout);
    } catch {
      return [`stride map --json gave no JSON: ${r.stdout.slice(0, 300)} ${r.stderr.slice(0, 300)}`];
    }
    const question = (key) => map.questions.find((q) => q.key === key);
    const boxes = (key) => (question(key)?.boxes ?? []).map((b) => `${b.direct ? "= " : ""}${b.box}`).join(", ");
    const want = (what, ok, got) => ok || problems.push(`${what}: ${JSON.stringify(got)}`);
    const into = {
      notes: "Notes, Notes_2, Notes_3",
      "home.city": "= City",
      "mail.city": "= City_2",
      code: "= Zip_2",
      "members[…].filed": "Member, Member_2, Yes, Yes_2, No_1, No_2",
      "titles[…]": "Text1, Title_1, Title_2",
      organs: "Organ heart, Organ lung",
      "witnesses[…]": "W1, W2",
    };
    for (const [key, words] of Object.entries(into)) want(`${key} goes into ${words}`, question(key) && boxes(key) === words, question(key) ?? map.questions.map((q) => q.key));
    want("where goes into a box named as the program runs", question("where")?.intoBoxNamedAtRun === true, question("where"));
    want("some box is named as the program runs", map.someBoxNamedAtRun === true, map.someBoxNamedAtRun);
    want("the boxes a name worked out may be", JSON.stringify(map.writtenByNameWorkedOut) === JSON.stringify(["Notes", "Notes_2", "Notes_3", "Member", "Member_2", "Yes", "Yes_2", "No_1", "No_2", "Text1", "Title_1", "Title_2", "W1", "W2", "Organ heart", "Organ lung"]), map.writtenByNameWorkedOut);
    want("the boxes never named are not written", JSON.stringify(map.notWritten) === JSON.stringify(["Notes_4", "City_3", "Zip", "Member_3", "Yes_3", "No_3", "WD1", "Free", "Organ skin"]), map.notWritten);
    want("no box is written from no answer", map.writtenFromNoAnswer.length === 0, map.writtenFromNoAnswer);
    // Every box a run writes is in the map as written.
    const answers = ["notes=a b c d", "home.city=H", "mail.city=M", "code=1", "members[0].name=A", "members[0].filed=yes", "members[0]#another=yes", "members[1].name=B", "members[1].filed=no", "titles[0]=t0", "titles[0]#another=yes", "titles[1]=t1", "organs=heart", "witnesses[0]=w", "where=Notes"];
    const run = spawnSync("node", [cli, "run", "m.stride", "--terminal", "--json", ...answers], { cwd: dir, encoding: "utf8", timeout: 30_000 });
    const wrote = Object.keys(JSON.parse(run.stdout).boxes ?? {});
    const listed = new Set([...map.questions.flatMap((q) => q.boxes.map((b) => b.box)), ...map.writtenFromNoAnswer, ...map.writtenByNameWorkedOut]);
    want("the run writes the boxes the map follows", wrote.length === 14, wrote);
    want("every box the run writes is in the map as written", wrote.every((b) => listed.has(b) && !map.notWritten.includes(b)), wrote.filter((b) => !listed.has(b)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
