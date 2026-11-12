// rule 17.18
// One program, one set of answers, one date, run in every place: in the browser from its source and from its
// compiled .sbc (a headless browser answering in the page, its boxes read from the page), and in the terminal from
// both. Every run writes the same boxes with the same values: the page holds what the terminal says it
// wrote, and the date the page used is the run's --today.
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tinyPdf } from "../fixtures/tiny-pdf.mjs";

const TODAY = "2026-02-03";

// In a child: `stride run <file>` in the browser, a headless Chromium answering each question in the page, the
// boxes read from the page.
const CHILD = `
const { spawn } = await import("node:child_process");
const [cli, cwd, file, pw, pdfjsPath, shell, out, answers] = process.argv.slice(1);
const { chromium } = await import(pw);
const pdfjs = await import(pdfjsPath);
const child = spawn("node", [cli, "run", file, "--port", "0", "--today", "${TODAY}"], { cwd, env: { ...process.env, BROWSER: "none" } });
let stdout = "";
child.stdout.on("data", (c) => (stdout += c));
const url = await new Promise((ok) => { const t = setInterval(() => { const m = stdout.match(/http:\\/\\/127\\.0\\.0\\.1:\\d+\\//); if (m) { clearInterval(t); ok(m[0]); } }, 20); });
const browser = await chromium.launch({ executablePath: shell });
const page = await browser.newPage({ acceptDownloads: true });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(url);
for (const a of JSON.parse(answers)) {
  await page.waitForSelector("aside.questions .nav .next", { timeout: 20000 });
  if (a.text !== undefined) await page.fill("aside.questions .body input", a.text);
  else await page.check('aside.questions .body input[value="' + a.choose + '"]');
  await page.click("aside.questions .nav .next");
}
await page.waitForTimeout(300);
const boxes = await page.evaluate(() => window.stride.boxes());
await browser.close();
child.kill();
console.log(JSON.stringify({ errors, boxes }));
process.exit(0);
`;

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "stride-run-agree-"));
  const problems = [];
  try {
    const base = join(homedir(), ".cache/ms-playwright");
    const found = existsSync(base) ? readdirSync(base).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop() : null;
    if (!found) return ["no headless Chromium in ~/.cache/ms-playwright: npx playwright install chromium-headless-shell"];
    const shell = join(base, found, "chrome-headless-shell-linux64/chrome-headless-shell");
    writeFileSync(join(dir, "consent.pdf"), tinyPdf());
    execFileSync("node", [cli, "header", "consent.pdf", "-q"], { cwd: dir });
    const sha = JSON.parse(readFileSync(join(dir, "consent.boxes.json"), "utf8")).pdf;
    writeFileSync(join(dir, "consent.stride"), `form consent\npdf ${sha}\n\nask full_name: string "Full name"\nask agrees: bool "I agree to the terms"\nif agrees {\n  fill "name" = "{full_name}, {today()}"\n}\ntick "agree" when agrees\n`);
    execFileSync("node", [cli, "compile", "consent.stride", "-q"], { cwd: dir });
    const answers = [{ text: "Ada Lovelace" }, { choose: "yes" }];
    const browserRun = (file, out) => {
      const r = spawnSync("node", ["--input-type=module", "-e", CHILD, cli, dir, file, pathToFileURL(join(repo, "node_modules/playwright-core/index.mjs")).href, pathToFileURL(join(repo, "node_modules/pdfjs-dist/legacy/build/pdf.mjs")).href, shell, join(dir, out), JSON.stringify(answers)], { encoding: "utf8", timeout: 120_000 });
      try {
        return JSON.parse(r.stdout.trim().split("\n").pop());
      } catch {
        return { errors: [r.stderr.slice(0, 400)], boxes: null };
      }
    };
    const terminal = (file) => JSON.parse(spawnSync("node", [cli, "run", file, "--terminal", "--json", "--today", TODAY, "full_name=Ada Lovelace", "agrees=yes"], { cwd: dir, encoding: "utf8" }).stdout).boxes;
    const want = { name: `Ada Lovelace, ${TODAY}`, agree: "Yes" };
    const runs = { "the terminal, from source": terminal("consent.stride"), "the terminal, compiled": terminal("consent.sbc") };
    for (const [how, file] of [["the browser, from source", "consent.stride"], ["the browser, compiled", "consent.sbc"]]) {
      const b = browserRun(file, `${file}.filled.pdf`);
      if (b.errors.length) problems.push(`${how}: the page's errors: ${JSON.stringify(b.errors)}`);
      runs[how] = b.boxes;
    }
    for (const [how, boxes] of Object.entries(runs)) if (JSON.stringify({ name: boxes?.name, agree: boxes?.agree }) !== JSON.stringify(want)) problems.push(`${how} wrote ${JSON.stringify(boxes)}, expected ${JSON.stringify(want)}`);
  } catch (e) {
    problems.push(`the runs did not finish: ${e.message.slice(0, 400)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
