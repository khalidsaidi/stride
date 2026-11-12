// rule 10.2.1 10.2.2 10.3.2 17.6 17.6.1 17.12 W011
// `stride header` lists each PDF field once, with every widget's place: a text box with two widgets, a check box
// whose widgets have their own on values (both of them), a read-only box, and a widget the page's annotations leave
// out. A program finds its header by its form's id; `check` counts the boxes `header` counts; `pick` writes a check
// box's on value; `stride map` lists the boxes a name worked out as the program runs may write apart from those not
// written; `stride run` says which answers' keys no question has.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { widgetsPdf } from "../fixtures/widgets-pdf.mjs";

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "stride-widgets-"));
  const stride = (...args) => spawnSync("node", [cli, ...args], { encoding: "utf8", timeout: 30_000, cwd: dir });
  const problems = [];
  const expect = (args, status, words, where = "both") => {
    const r = stride(...args);
    const text = where === "stdout" ? r.stdout : where === "stderr" ? r.stderr : r.stdout + r.stderr;
    if (r.status !== status || !text.includes(words)) problems.push(`${args.join(" ")}: expected exit ${status} with "${words}" on ${where}, got ${r.status}: ${(r.stdout + r.stderr).slice(0, 400)}`);
    return r;
  };
  try {
    writeFileSync(join(dir, "form-w.pdf"), widgetsPdf());
    expect(["header", "form-w.pdf"], 0, "4 boxes in the form form-w.pdf");
    const header = JSON.parse(readFileSync(join(dir, "form-w.boxes.json"), "utf8"));
    const of = (f) => header.boxes.filter((b) => b.field === f);
    if (header.boxes.length !== 4) problems.push(`the header lists ${header.boxes.length} boxes: ${header.boxes.map((b) => b.field).join(", ")}`);
    if (of("name").length !== 1 || of("name")[0].widgets?.length !== 2) problems.push(`the box with two widgets: ${JSON.stringify(of("name"))}`);
    if (of("sex").length !== 1 || JSON.stringify(of("sex")[0].on) !== '["Female","Male"]' || of("sex")[0].widgets?.map((w) => w.on).join() !== "Female,Male") problems.push(`the check box of two on values: ${JSON.stringify(of("sex"))}`);
    if (of("total")[0]?.readonly !== true) problems.push(`the read-only box: ${JSON.stringify(of("total"))}`);
    if (of("month")[0]?.max !== 2) problems.push(`the box the page's annotations leave out: ${JSON.stringify(of("month"))}`);

    // The program is t.stride; its header is the form's, form-w.boxes.json.
    writeFileSync(
      join(dir, "t.stride"),
      `form form-w\npdf ${header.pdf}\nask who: string "Name"\nask sex: string "Sex"\nfill "name" = who\npick "sex" "Male" when sex == "m"\nfunction put(box: string, v: string) { fill box = v }\nput("month", "05")\n`,
    );
    expect(["check", "t.stride"], 0, "t.stride: no errors (2 questions, 4 boxes in the form)");
    const run = expect(["run", "t.stride", "--terminal", "who=Ada", "sex=m", "whom=Bo", "--json"], 0, '"sex":"Male"', "stdout");
    if (!run.stdout.includes('"code":"W011"') || !run.stdout.includes('no question has the key \\"whom\\"')) problems.push(`run --json does not say the key no question has: ${run.stdout.slice(0, 400)}`);
    writeFileSync(join(dir, "answers.json"), JSON.stringify({ who: "Ada", "color": "x" }));
    expect(["run", "t.stride", "--terminal", "answers.json"], 0, 'answers.json: warning W011: no question has the key "color"', "stderr");
    const quiet = expect(["run", "t.stride", "--terminal", "answers.json"], 0, "name", "stdout");
    if (quiet.stdout.includes("W011")) problems.push("the warning W011 went to stdout");
    // put("month", "05"): the name a helper is given is known at its call, so the box is written from no answer, and
    // the box the program never names is not written.
    expect(["map", "t.stride"], 0, "written from no answer\n  month\n\nnot written\n  total");
    const map = expect(["map", "t.stride", "--json"], 0, '"writtenFromNoAnswer":["month"],"writtenByNameWorkedOut":[],"someBoxNamedAtRun":false,"notWritten":["total"]', "stdout");
    if (!map.stdout.includes('"key":"who","printed":"Name","boxes":[{"box":"name","direct":true}],"intoBoxNamedAtRun":false,"decidesWhatIsAsked":false')) problems.push(`map --json: ${map.stdout}`);
    // An answer asked in a function goes into the box its function writes; one handed to a helper goes into the box
    // the helper is told to write.
    writeFileSync(
      join(dir, "form-w.stride"),
      `form form-w\npdf ${header.pdf}\nfunction sign() {\n  ask who: string "Name"\n  fill "name" = who\n}\nfunction put(box: string, v: string) { fill box = v }\nsign()\nask m: string "Month"\nput("month", m)\n`,
    );
    expect(["map", "form-w.stride"], 0, "sign.who                             = name");
    expect(["map", "form-w.stride"], 0, "m                                    month");
    // With no header of either name, the message names both.
    writeFileSync(join(dir, "u.stride"), `form other\npdf ${header.pdf}\nprint("x")\n`);
    expect(["compile", "u.stride"], 1, "no header u.boxes.json or other.boxes.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
