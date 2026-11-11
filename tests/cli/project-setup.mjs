// rule 17.6 4.6 17.4
// `stride new` without a PDF makes a script and a test of it that pass; with a PDF it makes the form's header, a
// program that compiles against it and a test that passes; nothing is written over. `stride header` reads a PDF's
// boxes and the words beside them; a file that is not a PDF is said so. `stride map` says which box each question's
// answer goes into and which boxes are not written.
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tinyPdf } from "../fixtures/tiny-pdf.mjs";

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "stride-new-"));
  const stride = (...args) => spawnSync("node", [cli, ...args], { encoding: "utf8", timeout: 30_000, cwd: dir });
  const problems = [];
  const expect = (args, status, words) => {
    const r = stride(...args);
    if (r.status !== status || !(r.stdout + r.stderr).includes(words)) problems.push(`${args.join(" ")}: expected exit ${status} with "${words}", got ${r.status}: ${(r.stdout + r.stderr).slice(0, 300)}`);
  };
  try {
    writeFileSync(join(dir, "consent.pdf"), tinyPdf());
    writeFileSync(join(dir, "flat.pdf"), "not a pdf");
    expect(["new", "hello"], 0, "made hello.stride");
    expect(["run", "hello.stride"], 0, "Hello, there");
    expect(["test", "hello.stride"], 0, "1 test passed");
    expect(["new", "hello"], 1, "is there already");
    expect(["new", "bad name"], 2, "is not a form id");
    expect(["new", "consent", "--pdf", "consent.pdf"], 0, "consent.boxes.json");
    expect(["check", "consent.stride"], 0, "no errors (1 question, 2 boxes)");
    expect(["test", "consent.stride"], 0, "1 test passed");
    expect(["map", "consent.stride"], 0, "name                                 = name");
    expect(["map", "consent.stride"], 0, "not written\n  agree");
    expect(["map", "hello.stride"], 1, "is a script");
    const header = JSON.parse(readFileSync(join(dir, "consent.boxes.json"), "utf8"));
    const name = header.boxes.find((b) => b.field === "name"), agree = header.boxes.find((b) => b.field === "agree");
    if (header.form !== "consent" || !/^[0-9a-f]{64}$/.test(header.pdf)) problems.push(`the header's form and pdf: ${header.form} ${header.pdf}`);
    // What the PDF says of each box, and no words worked out from where they stand on the page (§17.6).
    if (name?.kind !== "text" || name.max !== 40 || "near" in name || "printed" in name) problems.push(`the text box: ${JSON.stringify(name)}`);
    if (agree?.kind !== "check" || agree.on !== "Yes" || "near" in agree) problems.push(`the check box: ${JSON.stringify(agree)}`);
    expect(["header", "consent.pdf", "-o", "again.boxes.json"], 0, "2 boxes of consent.pdf");
    if (!existsSync(join(dir, "again.boxes.json"))) problems.push("stride header wrote no again.boxes.json");
    expect(["header", "flat.pdf"], 1, "not a PDF");
    // The PDF where it would go is never written over; the very PDF given, already there, is used as it is.
    writeFileSync(join(dir, "target.pdf"), "the bytes already here");
    expect(["new", "target", "--pdf", "consent.pdf"], 1, "target.pdf is there already");
    if (readFileSync(join(dir, "target.pdf"), "utf8") !== "the bytes already here") problems.push("stride new wrote over target.pdf");
    if (existsSync(join(dir, "target.stride"))) problems.push("stride new wrote target.stride when it refused");
    writeFileSync(join(dir, "same.pdf"), tinyPdf());
    expect(["new", "same", "--pdf", "same.pdf"], 0, "made same.stride");
    // A box's description that is a keyword, or holds braces, quotes and a backslash, still gives a program that
    // compiles, with those words as its question's.
    for (const [form, described] of [["kw", "For"], ["braces", "Name {n}"], ["marks", 'Say "hi" \\ {x} }']]) {
      writeFileSync(join(dir, `${form}-src.pdf`), tinyPdf({ described }));
      expect(["new", form, "--pdf", `${form}-src.pdf`], 0, `made ${form}.stride`);
      expect(["check", `${form}.stride`], 0, "no errors (1 question");
      expect(["test", `${form}.stride`], 0, "1 test passed");
    }
    expect(["header", "none.pdf"], 2, "no such file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
