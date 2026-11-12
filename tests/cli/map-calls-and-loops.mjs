// rule 17.6.1 8.6.2
// `stride map` follows each call of a function on its own: a helper that asks, called `as "agent"` and `as "owner"`,
// lists each call's questions under its own keys; a helper given a box's name writes the box it is given. Questions
// asked in a loop are listed by their key's pattern, `qty[…]`, and the boxes filled from them are theirs. A box
// named from a constant table at a position worked out as the program runs may be any of the table's boxes, and
// only those; a box the program never names stays not written, also beside a name the compiler cannot tell at all.
// An answer summed into a total goes into the total's box; a bool with only a check is used by no box; an answer
// that decides whether a question is asked says so, and is credited with the boxes its branch writes from no
// answer.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PDF = "0".repeat(64);
const BOXES = ["AName", "ACity", "OName", "OCity", "QA", "QP", "Total", "Doc0", "Doc1", "Doc2", "L1", "L2", "Ra1", "Ra2", "Rb1", "Rb2", "PlateCar", "PlateVan", "Fees", "Status", "Spouse", "Free", "Office", "Sign"];
const SOURCE = `form m
pdf ${PDF}
record party {
  name: string
  city: string
}
record product {
  key: string
  box: string
}
const PRODUCTS = [new product { key: "apple", box: "QA" }, new product { key: "pear", box: "QP" }]
const DOC_BOXES = ["Doc0", "Doc1", "Doc2"]
const PLATES: map<string, string> = {"car": "PlateCar", "van": "PlateVan"}

function ask_party(who: string) -> party {
  var p: party
  ask p.name: string "{who}: name"
  ask p.city: string "{who}: city"
  return p
}
function put_party(prefix: string, p: party) {
  fill "{prefix}Name" = p.name
  fill "{prefix}City" = p.city
}
function rows(prefix: string) {
  for i in 1..2 {
    ask v: string "Row {i}"
    fill "{prefix}{i}" = v
  }
}

let agent = ask_party("Agent") as "agent"
let owner = ask_party("Owner") as "owner"
put_party("A", agent)
put_party("O", owner)
var total = 0
for p in PRODUCTS {
  ask qty: number "How many {p.key}?"
  fill p.box = qty
  total = total + (qty ?? 0)
}
fill "Total" = total
for i in 1..2 {
  ask line: string "Line {i}"
  fill "L{i}" = line
}
rows("Ra") as "a"
rows("Rb") as "b"
var docs: list<string>
collect d in docs "Another document?" {
  ask d: string "Document"
}
for n, d in docs {
  if n < count(DOC_BOXES) {
    fill DOC_BOXES[n] = d
  }
}
for kind, box in PLATES {
  ask plate: string "Plate of the {kind}"
  fill box = plate
}
ask ok: bool "I agree" check ok "you must agree"
var fees: list<number> = []
ask extra: number "Extra fee"
append(fees, extra ?? 0)
fill "Fees" = sum(fees)
ask married: bool "Married?"
if married {
  fill "Status" = "M"
  ask spouse: string "Spouse"
  fill "Spouse" = spouse
}
ask where: string "Which box?"
fill where = "x"
`;

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "stride-map-"));
  const problems = [];
  try {
    writeFileSync(join(dir, "m.stride"), SOURCE);
    writeFileSync(join(dir, "m.boxes.json"), JSON.stringify({ form: "m", pdf: PDF, boxes: BOXES.map((field) => ({ field, kind: "text" })) }));
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
      "agent.p.name": "AName",
      "agent.p.city": "ACity",
      "owner.p.name": "OName",
      "owner.p.city": "OCity",
      "qty[…]": "= QA, = QP, Total",
      "line[…]": "= L1, = L2",
      "a.v[…]": "= Ra1, = Ra2",
      "b.v[…]": "= Rb1, = Rb2",
      "docs[…]": "Doc0, Doc1, Doc2",
      "plate[…]": "= PlateCar, = PlateVan",
      extra: "Fees",
      spouse: "= Spouse",
      ok: "",
      married: "Status",
    };
    for (const [key, words] of Object.entries(into)) want(`${key} goes into ${words || "no box"}`, question(key) && boxes(key) === words, question(key) ?? map.questions.map((q) => q.key));
    want("the printed words of each call", question("owner.p.city")?.printed === "Owner: city", question("owner.p.city"));
    want("a bool with only a check decides nothing", question("ok")?.decidesWhatIsAsked === false, question("ok"));
    want("married decides what is asked", question("married")?.decidesWhatIsAsked === true, question("married"));
    want("the collect's question decides what is asked", question("docs[…]#another")?.decidesWhatIsAsked === true, map.questions.map((q) => q.key));
    want("where goes into a box named as the program runs", question("where")?.intoBoxNamedAtRun === true, question("where"));
    want("some box is named as the program runs", map.someBoxNamedAtRun === true, map);
    want("the table's boxes may be written by a name worked out at run time", JSON.stringify(map.writtenByNameWorkedOut) === '["Doc0","Doc1","Doc2"]', map.writtenByNameWorkedOut);
    want("the boxes never named are not written", JSON.stringify(map.notWritten) === '["Free","Office","Sign"]', map.notWritten);
    want("no box is written from no answer", map.writtenFromNoAnswer.length === 0, map.writtenFromNoAnswer);
    // Every key the run asks is listed, by itself or by its pattern.
    const run = spawnSync("node", [cli, "run", "m.stride", "--terminal", "--json", "docs[0]=a", "docs[0]#another=yes", "docs[1]=b", "married=yes"], { cwd: dir, encoding: "utf8", timeout: 30_000 });
    const asked = JSON.parse(run.stdout).questions.map((q) => q.key);
    const fits = (k) => map.questions.some((q) => new RegExp(`^${q.key.split("…").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(k));
    want("every key the run asks is in the map", asked.length > 20 && asked.every(fits), asked.filter((k) => !fits(k)));
    // The words as the terminal shows them.
    const text = spawnSync("node", [cli, "map", "m.stride"], { cwd: dir, encoding: "utf8", timeout: 30_000 }).stdout;
    want("ok is shown as used by no box", /\n {2}ok +\(used by no box\)/.test(text), text);
    want("the name the program cannot tell, once", text.includes("written by a name worked out as the program runs\n  Doc0\n  Doc1\n  Doc2\n  (some box named as the program runs)\n"), text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
