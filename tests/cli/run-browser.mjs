// rule 17.18
// `stride run` of a program serves its workflow in the browser, on this computer only: the page, its script, the
// form's PDF and the program, compiled again at each load, so an edit saved shows at the next reload; a mistake made
// since is given instead of the program, and mended, the program comes back. A PDF that is not the header's is
// refused when the run starts and at each reload. A program with mistakes is not served at all. Compiled, the
// program is served from its .sbc and its PDF alone, in a folder holding nothing else, and a PDF that is not the one
// compiled in is refused. A script runs in the terminal; options of the other place are usage mistakes.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tinyPdf } from "../fixtures/tiny-pdf.mjs";

// Runs `stride run` in a child, reads the address it prints, asks the server for each thing the page asks for, and
// says what came back; between asks it edits the files as the steps say.
const CHILD = `
const { spawn } = await import("node:child_process");
const fs = await import("node:fs");
const [cli, cwd, steps] = [process.argv[1], process.argv[2], JSON.parse(process.argv[3])];
const out = [];
for (const run of steps) {
  const child = spawn("node", [cli, "run", ...run.args], { cwd, env: { ...process.env, BROWSER: "none" } });
  let stdout = "", stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const url = await new Promise((ok) => {
    const t = setInterval(() => { const m = stdout.match(/http:\\/\\/127\\.0\\.0\\.1:\\d+\\//); if (m) { clearInterval(t); ok(m[0]); } }, 20);
    child.on("exit", () => { clearInterval(t); ok(null); });
  });
  if (!url) { await new Promise((ok) => setTimeout(ok, 50)); out.push({ name: run.name, exit: child.exitCode, stderr }); continue; }
  const got = [];
  for (const s of run.asks) {
    if (s.write) fs.writeFileSync(cwd + "/" + s.write, s.text.replace("{sha}", "1".repeat(64)));
    const r = await fetch(url + s.ask.slice(1));
    const body = Buffer.from(await r.arrayBuffer());
    got.push([s.ask, r.status, r.headers.get("content-type"), body.length, body.toString("utf8").slice(0, 300)]);
  }
  child.kill();
  out.push({ name: run.name, url, got });
}
console.log(JSON.stringify(out));
`;

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "stride-run-browser-"));
  const problems = [];
  try {
    writeFileSync(join(dir, "consent.pdf"), tinyPdf());
    writeFileSync(join(dir, "other.pdf"), Buffer.concat([tinyPdf(), Buffer.from("\n%other\n")]));
    execFileSync("node", [cli, "new", "consent", "--pdf", "consent.pdf", "-q"], { cwd: dir });
    execFileSync("node", [cli, "new", "hello", "-q"], { cwd: dir });
    const source = readFileSync(join(dir, "consent.stride"), "utf8");
    execFileSync("node", [cli, "compile", "consent.stride", "-q"], { cwd: dir });
    // The compiled program alone with its PDF, as it is shared.
    mkdirSync(join(dir, "shared"));
    copyFileSync(join(dir, "consent.sbc"), join(dir, "shared", "consent.sbc"));
    copyFileSync(join(dir, "consent.pdf"), join(dir, "shared", "consent.pdf"));
    writeFileSync(join(dir, "bad.stride"), source.replace('skip "agree"', 'fill "agree" = "x"'));
    writeFileSync(join(dir, "bad.boxes.json"), readFileSync(join(dir, "consent.boxes.json")));
    writeFileSync(join(dir, "bad.pdf"), tinyPdf());
    const steps = [
      { name: "source", args: ["consent.stride", "--port", "0"], asks: [
        { ask: "/" }, { ask: "/app.js" }, { ask: "/app.css" }, { ask: "/form.pdf" }, { ask: "/workflow.sbc" }, { ask: "/pdf.worker.mjs" },
        { ask: "/workflow.sbc", write: "consent.stride", text: source.replace('skip "agree"', 'fill "agree" = "x"') },
        { ask: "/workflow.sbc", write: "consent.stride", text: source },
        { ask: "/workflow.sbc", write: "consent.stride", text: source.replace(/^pdf \S+/m, "pdf {sha}") },
        { ask: "/workflow.sbc", write: "consent.stride", text: source },
      ] },
      { name: "compiled, alone", args: ["consent.sbc", "--port", "0"], asks: [{ ask: "/workflow.sbc" }, { ask: "/form.pdf" }] },
      { name: "today", args: ["consent.stride", "--port", "0", "--today", "2026-02-03"], asks: [{ ask: "/" }] },
      { name: "another PDF", args: ["consent.stride", "--port", "0", "--pdf", "other.pdf"], asks: [] },
      { name: "compiled, another PDF", args: ["consent.sbc", "--port", "0", "--pdf", "../other.pdf"], asks: [] },
      { name: "mistakes", args: ["bad.stride", "--port", "0"], asks: [] },
    ];
    // The compiled runs are in shared/, where there is nothing but the .sbc and its PDF.
    const run = (s) => JSON.parse(execFileSync("node", ["--input-type=module", "-e", CHILD, cli, s.name.startsWith("compiled") ? join(dir, "shared") : dir, JSON.stringify([s])], { encoding: "utf8", timeout: 120_000 }))[0];
    const [src, sbc, today, other, sbcOther, bad] = steps.map(run);
    const want = [/^\/ 200 text\/html/, /^\/app\.js 200 text\/javascript \d{5,}/, /^\/app\.css 200 text\/css \d+/, /^\/form\.pdf 200 application\/pdf \d+/, /^\/workflow\.sbc 200 application\/octet-stream \d+/, /^\/pdf\.worker\.mjs 200 text\/javascript \d+/];
    const line = (g) => g?.slice(0, 4).join(" ");
    want.forEach((re, i) => !re.test(line(src.got?.[i]) ?? "") && problems.push(`from source, ${re}: ${line(src.got?.[i])}`));
    const [, , , , , , mistake, mended, pdfChanged, back] = src.got ?? [];
    if (mistake?.[1] !== 422 || !/mistake S\d{3}/.test(mistake[4])) problems.push(`an edit with a mistake, at the reload: ${JSON.stringify(mistake)}`);
    if (mended?.[1] !== 200) problems.push(`mended, at the reload: ${JSON.stringify(mended)}`);
    if (pdfChanged?.[1] !== 422 || !pdfChanged[4].includes("mistake S501")) problems.push(`a program for another PDF, at the reload: ${JSON.stringify(pdfChanged)}`);
    if (back?.[1] !== 200) problems.push(`put back, at the reload: ${JSON.stringify(back)}`);
    if (sbc.got?.[0]?.[1] !== 200 || sbc.got[0][3] !== readFileSync(join(dir, "consent.sbc")).length || sbc.got?.[1]?.[1] !== 200) problems.push(`the compiled program, with only its PDF: ${JSON.stringify(sbc)}`);
    if (!today.got?.[0]?.[4].includes('<meta name="stride-today" content="2026-02-03">')) problems.push(`--today in the page: ${JSON.stringify(today.got)}`);
    if (other.exit !== 1 || !other.stderr.includes("is not the PDF")) problems.push(`another PDF: ${JSON.stringify(other)}`);
    if (sbcOther.exit !== 1 || !sbcOther.stderr.includes("is not the PDF consent.sbc was compiled for")) problems.push(`the compiled program with another PDF: ${JSON.stringify(sbcOther)}`);
    if (bad.exit !== 1 || !/mistake S\d{3}/.test(bad.stderr)) problems.push(`a program with mistakes is not served: ${JSON.stringify(bad)}`);
    // The terminal, and the usage mistakes of the other place.
    const cmd = (args) => spawnSync("node", [cli, "run", ...args], { cwd: dir, encoding: "utf8", timeout: 30_000, env: { ...process.env, BROWSER: "none" } });
    let r = cmd(["consent.stride", "--terminal", "name=Ada"]);
    if (r.status !== 0 || !r.stdout.includes('name') || !r.stdout.includes('"Ada"')) problems.push(`--terminal: ${r.status} ${r.stdout} ${r.stderr}`);
    r = cmd(["hello.stride", "name=Bo"]);
    if (r.status !== 0 || r.stdout !== "Hello, Bo\n") problems.push(`a script in the terminal: ${r.status} ${JSON.stringify(r.stdout)} ${r.stderr}`);
    for (const [args, says] of [[["consent.stride", "name=Ada"], "are for a run in the terminal"], [["consent.stride", "--json"], "--json is for a run in the terminal"], [["consent.stride", "--trace"], "--trace is for a run in the terminal"], [["consent.stride", "--prompt"], "--prompt is for a run in the terminal"], [["consent.stride", "--terminal", "--pdf", "consent.pdf"], "--pdf is for a run in the browser"], [["consent.stride", "--terminal", "--port", "1"], "--port is for a run in the browser"], [["hello.stride", "--port", "1"], "is a script, which runs in the terminal"]]) {
      r = cmd(args);
      if (r.status !== 2 || !r.stderr.includes(says) || !r.stderr.includes("usage: stride run")) problems.push(`run ${args.join(" ")}: ${r.status} ${r.stderr.slice(0, 300)}`);
    }
  } catch (e) {
    problems.push(`the run did not finish: ${e.message.slice(0, 400)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
