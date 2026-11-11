// rule 17.18 17.11
// The workflow in a real (headless) browser, as a person meets it, from source and compiled:
// - a program that fills and ticks from no answer: the downloaded PDF holds what the terminal says it wrote, and
//   its print is in the browser's console;
// - a question whose default would fault after it: the question is asked; answered, the PDF holds the result;
//   kept at its default, the fault is shown after it and said in the console in full (code, place, calls), and Back
//   reaches the question to change it;
// - a print after an answer: in the console;
// - the PDF, its header and the source replaced together while the run goes on: the reload serves the new PDF and
//   the program for it; the PDF taken away: the page says so;
// - words that are not JSON: compile and run refuse them with the file's name, and at a reload the page says so
//   instead of hanging;
// - a check: its message appears as the answer comes to fail it and goes as it comes to pass, without leaving the
//   question; an answer that cannot be read says so the same way; after Next, the end lists what still needs a look;
// - the PDF replaced between the page's two requests: the page refuses the PDF it got, never shows it under the
//   workflow it holds;
// - a print that stays the same while a fault comes and goes is logged once; the fault each time, in full.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tinyPdf } from "../fixtures/tiny-pdf.mjs";

// In a child: each scenario starts `stride run`, opens the page in a headless Chromium, does its steps, and says
// what the page, its console and the downloaded PDF held.
const CHILD = `
const { spawn } = await import("node:child_process");
const fs = await import("node:fs");
const [cli, cwdBase, pw, pdfjsPath, shell, scenarios] = process.argv.slice(1);
const { chromium } = await import(pw);
const pdfjs = await import(pdfjsPath);
const browser = await chromium.launch({ executablePath: shell });
const results = {};
for (const sc of JSON.parse(scenarios)) {
  const cwd = cwdBase + "/" + (sc.dir ?? "");
  const child = spawn("node", [cli, "run", sc.file, "--port", "0"], { cwd, env: { ...process.env, BROWSER: "none" } });
  let stdout = "";
  child.stdout.on("data", (c) => (stdout += c));
  const url = await new Promise((ok) => { const t = setInterval(() => { const m = stdout.match(/http:\\/\\/127\\.0\\.0\\.1:\\d+\\//); if (m) { clearInterval(t); ok(m[0]); } }, 20); setTimeout(() => ok(null), 20000); });
  const out = { console: [], errors: [], seen: [] };
  if (!url) { results[sc.name] = { failed: "did not serve" }; child.kill(); continue; }
  const page = await browser.newPage({ acceptDownloads: true });
  page.on("console", (m) => out.console.push(m.type() + " " + m.text()));
  page.on("pageerror", (e) => out.errors.push(e.message));
  try {
  // The PDF replaced on disk after the page has its workflow and before it has its PDF.
  if (sc.swapPdf) await page.route("**/form.pdf", async (route) => { fs.writeFileSync(cwd + "/" + sc.swapPdf.file, Buffer.from(sc.swapPdf.base64, "base64")); await route.continue(); });
  await page.goto(url);
  for (const st of sc.steps) {
    if (st.write) { fs.writeFileSync(cwd + "/" + st.write, st.base64 ? Buffer.from(st.text, "base64") : st.text); continue; }
    if (st.remove) { fs.renameSync(cwd + "/" + st.remove, cwd + "/" + st.remove + ".gone"); continue; }
    if (st.reload) { await page.reload(); await page.waitForTimeout(800); continue; }
    if (st.text !== undefined) { await page.waitForSelector("aside.questions .body input", { timeout: 20000 }); await page.fill("aside.questions .body input", st.text); continue; }
    if (st.next) { await page.click("aside.questions .nav .next"); await page.waitForTimeout(200); continue; }
    if (st.back) { await page.click("aside.questions .nav button.quiet"); await page.waitForTimeout(200); continue; }
    if (st.panel) { await page.waitForTimeout(300); out.seen.push(await page.textContent("aside.questions")); continue; }
    if (st.page) { await page.waitForTimeout(300); out.seen.push(await page.textContent("body")); continue; }
    if (st.download) {
      await page.waitForTimeout(300);
      const [d] = await Promise.all([page.waitForEvent("download"), page.click("#download")]);
      const path = cwd + "/" + sc.name.replace(/\\W/g, "_") + "-" + st.download + ".pdf";
      await d.saveAs(path);
      const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(path)), verbosity: 0 }).promise;
      const f = await doc.getFieldObjects();
      out[st.download] = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v[0].value]));
    }
  }
  } catch (e) {
    out.failed = e.message.split("\\n")[0];
    out.seen.push(await page.textContent("body").catch(() => ""));
  }
  await page.close();
  child.kill();
  results[sc.name] = out;
}
await browser.close();
console.log(JSON.stringify(results));
process.exit(0);
`;

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "stride-page-"));
  const problems = [];
  const stride = (args, cwd = dir) => spawnSync("node", [cli, ...args], { cwd, encoding: "utf8", timeout: 30_000 });
  try {
    const base = join(homedir(), ".cache/ms-playwright");
    const found = existsSync(base) ? readdirSync(base).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop() : null;
    if (!found) return ["no headless Chromium in ~/.cache/ms-playwright: npx playwright install chromium-headless-shell"];
    const shell = join(base, found, "chrome-headless-shell-linux64/chrome-headless-shell");
    // Each program beside its own copy of the PDF and header.
    const program = (name, body, pdf = tinyPdf()) => {
      writeFileSync(join(dir, `${name}.pdf`), pdf);
      execFileSync("node", [cli, "header", `${name}.pdf`, "-q"], { cwd: dir });
      const sha = JSON.parse(readFileSync(join(dir, `${name}.boxes.json`), "utf8")).pdf;
      writeFileSync(join(dir, `${name}.stride`), `form ${name}\npdf ${sha}\n\n${body}`);
      return sha;
    };
    program("constant", 'fill "name" = "Ada"\ntick "agree" when true\nprint("ready")\n');
    program("faulty", 'ask n: number "Full name" default 0\nfunction tenth(d: number) -> number {\n  return 10 / d\n}\nfill "name" = tenth(n)\n');
    program("prints", 'ask who: string "Full name"\nfill "name" = who\nprint("seen: {who}")\n');
    program("moving", 'ask who: string "Full name"\nfill "name" = who\n');
    program("checked", 'ask n: number "Full name" check n >= 18 "Must be at least 18"\nfill "name" = n\n');
    program("swapped", 'ask who: string "Full name"\nfill "name" = who\n');
    program("stable", 'ask n: number "Full name"\nprint("same")\nif n == 0 {\n  fail("zero")\n}\nfill "name" = n\n');
    for (const n of ["constant", "faulty"]) execFileSync("node", [cli, "compile", `${n}.stride`, "-q"], { cwd: dir });
    // The compiled ones alone with their PDFs.
    mkdirSync(join(dir, "shared"));
    for (const n of ["constant", "faulty"]) for (const ext of ["sbc", "pdf"]) copyFileSync(join(dir, `${n}.${ext}`), join(dir, "shared", `${n}.${ext}`));
    // A new edition of the moving form's PDF, its header and the source for it, to put in place together.
    const newPdf = tinyPdf({ label: "Full name" });
    const edition = Buffer.concat([newPdf, Buffer.from("\n%new edition\n")]);
    writeFileSync(join(dir, "edition.pdf"), edition);
    execFileSync("node", [cli, "header", "edition.pdf", "-o", "edition.boxes.json", "-q"], { cwd: dir });
    const editionHeader = JSON.parse(readFileSync(join(dir, "edition.boxes.json"), "utf8"));
    const movingSource = readFileSync(join(dir, "moving.stride"), "utf8").replace(/^pdf \S+/m, `pdf ${editionHeader.pdf}`);
    const scenarios = [
      { name: "no questions, source", file: "constant.stride", steps: [{ panel: true }, { download: "pdf" }] },
      { name: "no questions, compiled", file: "constant.sbc", dir: "shared", steps: [{ panel: true }, { download: "pdf" }] },
      { name: "default faults, answered", file: "faulty.stride", steps: [{ text: "2" }, { next: true }, { download: "pdf" }] },
      { name: "default faults, kept then mended", file: "faulty.sbc", dir: "shared", steps: [{ panel: true }, { next: true }, { panel: true }, { back: true }, { text: "4" }, { next: true }, { download: "pdf" }] },
      { name: "prints", file: "prints.stride", steps: [{ text: "Ada" }, { next: true }, { download: "pdf" }] },
      { name: "new edition", file: "moving.stride", steps: [{ write: "moving.pdf", text: edition.toString("base64"), base64: true }, { write: "moving.boxes.json", text: JSON.stringify({ ...editionHeader, form: "moving" }) }, { write: "moving.stride", text: movingSource }, { reload: true }, { text: "Bo" }, { next: true }, { download: "pdf" }, { remove: "moving.pdf" }, { reload: true }, { page: true }] },
      { name: "a check", file: "checked.stride", steps: [{ text: "17" }, { panel: true }, { text: "20" }, { panel: true }, { text: "15" }, { panel: true }, { next: true }, { panel: true }, { back: true }, { text: "30" }, { next: true }, { panel: true }] },
      { name: "unreadable", file: "checked.stride", steps: [{ text: "abc" }, { panel: true }, { next: true }, { panel: true }, { download: "pdf" }] },
      { name: "the PDF replaced between the requests", file: "swapped.stride", swapPdf: { file: "swapped.pdf", base64: tinyPdf({ label: "Different name" }).toString("base64") }, steps: [{ page: true }] },
      { name: "a stable print", file: "stable.stride", steps: [{ text: "1" }, { text: "0" }, { text: "2" }, { text: "0" }] },
      { name: "a changing print", file: "prints.stride", steps: [{ text: "Ada" }, { text: "Bo" }] },
    ];
    const r = spawnSync("node", ["--input-type=module", "-e", CHILD, cli, dir, pathToFileURL(join(repo, "node_modules/playwright-core/index.mjs")).href, pathToFileURL(join(repo, "node_modules/pdfjs-dist/legacy/build/pdf.mjs")).href, shell, JSON.stringify(scenarios)], { encoding: "utf8", timeout: 300_000 });
    let got;
    try {
      got = JSON.parse(r.stdout.trim().split("\n").pop());
    } catch {
      return [`the browser runs did not finish: ${r.stderr.slice(0, 600)}`];
    }
    const want = (what, ok, detail) => ok || problems.push(`${what}: ${JSON.stringify(detail)}`);
    const terminal = JSON.parse(stride(["run", "constant.stride", "--terminal", "--json"]).stdout);
    for (const how of ["no questions, source", "no questions, compiled"]) {
      const g = got[how];
      want(`${how}: the PDF holds what the terminal wrote`, g.pdf?.name === terminal.boxes.name && g.pdf?.agree === "Yes" && terminal.boxes.name === "Ada", { browser: g.pdf, terminal: terminal.boxes });
      want(`${how}: the print in the console`, g.console.includes("log ready"), g.console);
      want(`${how}: no page errors`, !g.errors.length, g.errors);
    }
    const answered = got["default faults, answered"];
    want("a question whose default faults, answered: the PDF holds 10 / 2", answered.pdf?.name === "5", answered);
    const mended = got["default faults, kept then mended"];
    want("its question is asked first", mended.seen[0]?.includes("Full name"), mended.seen);
    want("kept at its default, the fault is shown after it", mended.seen[1]?.includes("These questions stopped working"), mended.seen);
    want("the fault in the console in full", mended.console.some((c) => c.startsWith("error error F001: division by zero") && /at tenth, faulty\.stride:6:\d+/.test(c) && /called from main, faulty\.stride:8:\d+/.test(c)), mended.console);
    want("Back to the question, changed: the PDF holds 10 / 4", mended.pdf?.name === "2.5", mended);
    want("a print after an answer, in the console", got.prints.console.includes("log seen: Ada"), got.prints.console);
    const moved = got["new edition"];
    want("the PDF, its header and the source replaced together: served at the reload", moved.pdf?.name === "Bo" && !moved.errors.length, moved);
    want("the PDF taken away: said in the page", moved.seen[0]?.includes("moving.pdf: no such file"), moved.seen);
    const check = got["a check"].seen;
    const says = (t) => t?.includes("Must be at least 18");
    want("17: the check's message, at once", says(check[0]), check);
    want("20: the message gone", check[1] && !says(check[1]), check);
    want("15: the message back", says(check[2]), check);
    want("Next with it failing: the end lists it", check[3]?.includes("These answers need a look") && says(check[3]), check);
    want("mended to 30: the end lists nothing", check[4] && !check[4].includes("These answers need a look") && !says(check[4]), check);
    const unread = got.unreadable;
    want("abc: said to be unreadable, at once", unread.seen[0]?.includes("This could not be read: not a number"), unread.seen);
    want("Next: the end lists it", unread.seen[1]?.includes("These answers need a look") && unread.seen[1]?.includes("not a number"), unread.seen);
    want("abc: no box value, as the terminal", (unread.pdf?.name ?? "") === "", unread.pdf);
    const swap = got["the PDF replaced between the requests"];
    want("the PDF replaced between the requests: refused in the page", swap.seen[0]?.includes("is not the one this workflow is for") && !swap.seen[0]?.includes("Different name"), swap);
    const stable = got["a stable print"].console;
    want("a stable print, logged once while a fault comes and goes", stable.filter((c) => c === "log same").length === 1, stable);
    want("the fault, each time it comes, in full", stable.filter((c) => c.startsWith("error error F013: zero\n  at main, stable.stride:7:")).length === 2, stable);
    const changing = got["a changing print"].console;
    want("a changing print, each time", changing.includes("log seen: Ada") && changing.includes("log seen: Bo"), changing);
    // Bytecode where source is needed: a usage mistake, never an internal one.
    for (const c of ["compile", "map"]) {
      const x = stride([c, "shared/constant.sbc"]);
      want(`${c} of bytecode`, x.status === 2 && x.stderr.includes("source") && x.stderr.includes(`usage: stride ${c}`) && !x.stderr.includes("Cannot read"), [x.status, x.stderr]);
    }
  } catch (e) {
    problems.push(`the runs did not finish: ${e.message.slice(0, 400)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
