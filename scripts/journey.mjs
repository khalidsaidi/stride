// The whole journey of someone writing Stride, end to end, with nothing but the installed command (§17.17): run as
//
//   node scripts/journey.mjs [--vscode <path to VS Code's code binary>] [--no-build]
//   node scripts/journey.mjs --windows <Windows' node.exe of this node's version> [--no-build]
//
// It builds stride, installs it into an empty home folder, and, in a folder outside the repository, with the
// repository off the PATH: learns from the built-in guide; starts a project; writes a program that uses a library;
// gives it input every way; tests the project; debugs it; makes a PDF workflow from its PDF, runs it in a browser
// (headless Chromium), fills it there and reads its boxes; compiles it and runs the compiled workflow in a
// folder holding only it and its PDF; compiles the script and runs it, and its tests, in another folder without its
// source; writes the VS Code extension, installs it into a real VS Code and runs it there (with
// --vscode); and upgrades by installing again. Each step says what it checked; the first that fails stops it, exit 1.
// With --windows, from WSL: it builds stride.exe, installs it with scripts/install.ps1 into an empty folder on
// Windows' disk, and runs every step with that stride.exe, on Windows; the workflow is filled in a headless Chromium
// run by Windows' node on Windows, as a Windows user's browser would be. VS Code is not run on Windows.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const argv = process.argv.slice(2);
const vscode = argv.includes("--vscode") ? argv[argv.indexOf("--vscode") + 1] : null;
const windows = argv.includes("--windows") ? argv[argv.indexOf("--windows") + 1] : null;
const winPath = (p) => execFileSync("wslpath", ["-w", p], { encoding: "utf8" }).trim();
const home = mkdtempSync(windows ? "/mnt/c/Users/Public/stride-journey-" : join(tmpdir(), "stride-home-"));
const work = join(home, "work");
mkdirSync(work);
const env = { HOME: home, PATH: `${home}/.local/bin:/usr/bin:/bin`, LANG: "C.UTF-8" };
// The installed command, and how it is installed.
const installed = windows ? join(home, "bin", "stride.exe") : `${home}/.local/bin/stride`;
const dist = join(repo, windows ? "dist/stride.exe" : "dist/stride");
const install = () =>
  windows
    ? spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", winPath(join(repo, "scripts/install.ps1")), "-Dest", winPath(join(home, "bin"))], { encoding: "utf8", timeout: 120_000 })
    : spawnSync("sh", [join(repo, "scripts/install.sh")], { env, encoding: "utf8" });
const shownInstalled = windows ? winPath(installed) : installed;
let step = 0;
const ok = (what) => console.log(`ok ${++step}  ${what}`);
const stop = (what, r) => {
  console.log(`FAIL ${++step}  ${what}${r ? `\n  exit ${r.status}\n  stdout: ${(r.stdout ?? "").slice(0, 600)}\n  stderr: ${(r.stderr ?? "").slice(0, 600)}` : ""}`);
  rmSync(home, { recursive: true, force: true }); // exiting here skips the finally below
  process.exit(1);
};
const stride = (args, { cwd = work, input } = {}) => spawnSync(windows ? installed : "stride", args, { cwd, env: windows ? process.env : env, input, encoding: "utf8", timeout: 120_000 });
const expect = (what, r, test) => (test(r) ? ok(what) : stop(what, r));
const write = (path, text) => (mkdirSync(join(work, path, ".."), { recursive: true }), writeFileSync(join(work, path), text));

try {
  // 1. Build and install.
  if (!argv.includes("--no-build")) execFileSync("node", [join(repo, "scripts/build.mjs"), ...(windows ? ["--windows", windows] : [])], { stdio: "ignore" });
  const built = execFileSync(dist, ["--version"], { encoding: "utf8" }).trim();
  let r = install();
  expect(`install into an empty folder${windows ? ", on Windows" : ""}`, r, (x) => x.status === 0 && x.stdout.includes(shownInstalled) && !x.stdout.includes("(was"));
  expect("the installed stride is the build", stride(["--version"]), (x) => x.stdout.trim() === built);

  // 2. Learn.
  expect("stride help", stride(["help"]), (x) => x.status === 0 && x.stdout.includes("stride repl") && x.stdout.includes("--terminal") && !x.stdout.includes("preview"));
  expect("no preview command", stride(["preview", "x.stride"]), (x) => x.status === 2 && x.stderr.startsWith("stride: no command preview"));
  expect("the built-in guide", stride(["guide", "coming-from"]), (x) => x.status === 0 && x.stdout.includes("Lists, records and maps are shared"));
  expect("a guide topic", stride(["guide", "positions"]), (x) => x.stdout.startsWith("## Positions count from 0"));
  expect("the library's docs", stride(["doc", "pad_left"]), (x) => x.stdout.includes('pad_left("7", 3, "0") gives 007'));
  expect("trying an expression", stride(["eval", "1 / 3 * 3"]), (x) => x.stdout === "0.9999999999999999999999999999999999\n");
  expect("a session", stride(["repl"], { input: "let x = 20\nx + 1\n" }), (x) => x.stdout === "21\n");

  // 3. A project, a library, a program that uses it.
  expect("stride init", stride(["init", "-q"]), (x) => x.status === 0 && existsSync(join(work, "stride.json")));
  write("lib/shares.stride", 'export record person {\n  name: string\n  owes: number\n}\nexport function share(total: number, n: number) -> number {\n  if total < 0 {\n    fail("a bill is never below zero")\n  }\n  return round(total / n, 2)\n}\n');
  write("bills/split.stride", 'import "shares"\nask total: number "The bill"\nvar people: list<string>\ncollect who in people "Another person?" {\n  ask who: string "Name"\n}\nlet part = share(total, count(people))\nfor name in people {\n  print("{name} owes {fixed(part, 2)}")\n}\n');
  expect("check the program", stride(["check", "-q"]), (x) => x.status === 0 && x.stderr === "");
  // 4. Input, every way.
  expect("answers as key=value", stride(["run", "bills/split.stride", "total=90", "people[0]=Ada", "people[0]#another=yes", "people[1]=Bo", "people[1]#another=no"]), (x) => x.stdout === "Ada owes 45.00\nBo owes 45.00\n");
  write("answers.json", JSON.stringify({ total: "100", "people[0]": "Ada", "people[0]#another": "yes", "people[1]": "Bo", "people[1]#another": "yes", "people[2]": "Cy", "people[2]#another": "no" }));
  expect("answers from a file", stride(["run", "bills/split.stride", "answers.json"]), (x) => x.stdout === "Ada owes 33.33\nBo owes 33.33\nCy owes 33.33\n");
  expect("answers on stdin", stride(["run", "bills/split.stride", "-"], { input: readFileSync(join(work, "answers.json"), "utf8") }), (x) => x.stdout.split("\n").length === 4);
  expect("answers typed in turn", stride(["run", "bills/split.stride", "--prompt"], { input: "60\nAda\nyes\nBo\nno\n" }), (x) => x.stdout === "Ada owes 30.00\nBo owes 30.00\n" && x.stderr.includes("The bill"));
  expect("a fault, on stderr", stride(["run", "bills/split.stride", "total=-10", "people[0]=Ada"]), (x) => x.status === 1 && x.stdout === "" && x.stderr.includes("error F013: a bill is never below zero"));
  // 5. Tests.
  write("bills/split.tests/two.json", JSON.stringify({ answers: { total: "90", "people[0]": "Ada", "people[0]#another": "yes", "people[1]": "Bo", "people[1]#another": "no" }, prints: ["Ada owes 45.00", "Bo owes 45.00"] }));
  write("bills/split.tests/nobody.json", JSON.stringify({ answers: { total: "-1", "people[0]": "Ada" }, fault: "F013" }));
  write("lib/shares.test.stride", 'import "shares"\nexpect share(10, 3) == 3.33\nexpect share(-1, 2) faults "F013"\n');
  expect("the project's tests", stride(["test"]), (x) => x.status === 0 && x.stdout.includes("4 tests passed in 2 files"));
  // 6. Debugging.
  expect("the debugger", stride(["debug", "bills/split.stride", "total=90", "people[0]=Ada", "people[0]#another=no"], { input: "b lib/shares.stride:9\nc\np n\nwhere\nc\n" }), (x) => x.status === 0 && x.stderr.includes("breakpoint at lib/shares.stride:9") && x.stderr.includes("n = 1") && x.stderr.includes("    main  split.stride:7") && x.stdout === "Ada owes 90.00\n");
  expect("the trace", stride(["run", "bills/split.stride", "total=8", "people[0]=Ada", "--trace"]), (x) => x.stderr.includes("→ share(total = 8, n = 1)") && x.stdout === "Ada owes 8.00\n");
  // 7. A PDF workflow: the header from the PDF, the source, the workflow in the browser, its tests, compiled.
  const { tinyPdf } = await import(join(repo, "tests/fixtures/tiny-pdf.mjs"));
  writeFileSync(join(work, "consent-form.pdf"), tinyPdf({ parent: "top" })); // its boxes top.name and top.agree: the program has fields "top."
  expect("stride new from a PDF", stride(["new", "forms/consent", "--pdf", "consent-form.pdf"]), (x) => x.status === 0 && x.stderr.includes("stride run forms/consent.stride") && !x.stderr.includes("preview"));
  expect("its test", stride(["test", "forms/consent.stride"]), (x) => x.status === 0);
  expect("its map", stride(["map", "forms/consent.stride"]), (x) => x.stdout.includes("= name") && x.stdout.includes("not written"));
  const pdfjs = await import(join(repo, "node_modules/pdfjs-dist/legacy/build/pdf.mjs"));
  // `stride run <file>` in the browser, the browser left closed; a headless browser answers the question in the
  // page and reads its boxes, named as the program writes them (stride.boxes(), the fields prefix taken off); gives
  // what its box "name" holds and the page's errors.
  const inBrowser = async (file, cwd, saveTo) => {
    const server = spawn(windows ? installed : "stride", ["run", file, "--port", "0"], { cwd, env: { ...(windows ? process.env : env), BROWSER: "none" } });
    const url = await new Promise((done, fail) => {
      let text = "";
      server.stdout.on("data", (c) => {
        text += c;
        const m = text.match(/http:\/\/127\.0\.0\.1:\d+\//);
        if (m) done(m[0]);
      });
      setTimeout(() => fail(new Error(`stride run ${file} did not start serving`)), 30_000);
    });
    const fill = async (chromium, launch, url, saveTo) => {
      const browser = await chromium.launch(launch);
      const page = await browser.newPage({ acceptDownloads: true });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(url);
      await page.waitForSelector("aside.questions input", { timeout: 20_000 });
      await page.fill("aside.questions input", "Ada Lovelace");
      await page.waitForTimeout(300);
      const boxes = await page.evaluate(() => window.stride.boxes());
      await browser.close();
      return { errors, value: boxes.name ?? null };
    };
    let filled;
    if (windows) {
      // On Windows, by Windows' node: the server listens on Windows' own 127.0.0.1, which only Windows reaches.
      cpSync(join(repo, "node_modules/playwright-core"), join(home, "driver/node_modules/playwright-core"), { recursive: true });
      const browsers = "C:\\Users\\Public\\stride-browsers";
      const wenv = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers, WSLENV: "PLAYWRIGHT_BROWSERS_PATH/w" };
      spawnSync(windows, [winPath(join(home, "driver/node_modules/playwright-core/cli.js")), "install", "chromium-headless-shell"], { env: wenv, encoding: "utf8", timeout: 600_000 });
      writeFileSync(join(home, "driver/fill.cjs"), `const { chromium } = require("playwright-core");\nconst fill = ${fill.toString()};\nfill(chromium, {}, process.argv[2], process.argv[3]).then((e) => console.log(JSON.stringify(e)), (e) => { console.log(JSON.stringify([e.message])); });\n`);
      const driven = spawnSync(windows, [winPath(join(home, "driver/fill.cjs")), url, winPath(saveTo)], { cwd: join(home, "driver"), env: wenv, encoding: "utf8", timeout: 180_000 });
      try {
        filled = JSON.parse(driven.stdout.trim().split("\n").pop());
      } catch {
        filled = { value: null, errors: [`the Windows browser did not run: ${driven.stderr.slice(0, 400)}`] };
      }
    } else {
      const { chromium } = await import(join(repo, "node_modules/playwright-core/index.mjs"));
      const base = `${process.env.HOME}/.cache/ms-playwright`;
      const shell = readdirSync(base).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop();
      filled = await fill(chromium, { executablePath: `${base}/${shell}/chrome-headless-shell-linux64/chrome-headless-shell` }, url, saveTo);
    }
    server.kill();
    return { value: filled.value, errors: filled.errors };
  };
  let b = await inBrowser("forms/consent.stride", work, join(work, "filled.pdf"));
  b.value === "Ada Lovelace" && !b.errors.length ? ok("stride run: the workflow in a browser, answered there, the box filled") : stop(`stride run in the browser: the downloaded PDF holds ${JSON.stringify(b.value)}; ${JSON.stringify(b.errors)}`);
  expect("the same program in the terminal", stride(["run", "forms/consent.stride", "--terminal", "name=Ada Lovelace"]), (x) => x.status === 0 && x.stdout.includes('"Ada Lovelace"'));
  expect("compile the workflow", stride(["compile", "forms/consent.stride", "-o", "consent.sbc", "-q"]), (x) => x.status === 0 && existsSync(join(work, "consent.sbc")));
  // The compiled workflow in a folder holding nothing but it and its PDF.
  const alone = join(home, "only-the-pdf");
  mkdirSync(alone);
  cpSync(join(work, "consent.sbc"), join(alone, "consent.sbc"));
  cpSync(join(work, "forms/consent.pdf"), join(alone, "consent.pdf"));
  b = await inBrowser("consent.sbc", alone, join(alone, "filled.pdf"));
  b.value === "Ada Lovelace" && !b.errors.length && readdirSync(alone).sort().join(",") === "consent.pdf,consent.sbc" ? ok("stride run consent.sbc: the compiled workflow, with only its PDF, in a browser") : stop(`the compiled workflow in the browser: ${JSON.stringify(b.value)}; ${JSON.stringify(b.errors)}`);
  writeFileSync(join(alone, "other.pdf"), Buffer.concat([tinyPdf({ parent: "top" }), Buffer.from("\n%other\n")]));
  expect("a PDF it was not compiled for, refused", stride(["run", "consent.sbc", "--pdf", "other.pdf"], { cwd: alone }), (x) => x.status === 1 && x.stderr.includes("is not the PDF consent.sbc was compiled for"));
  // 8. Sharing a compiled program.
  expect("compile", stride(["compile", "bills/split.stride", "-o", "split.sbc"]), (x) => x.status === 0);
  const away = join(home, "elsewhere");
  mkdirSync(away);
  cpSync(join(work, "split.sbc"), join(away, "split.sbc"));
  cpSync(join(work, "bills/split.tests"), join(away, "split.tests"), { recursive: true });
  expect("the compiled program, without its source", stride(["run", "split.sbc", "total=9", "people[0]=Ada"], { cwd: away }), (x) => x.stdout === "Ada owes 9.00\n");
  expect("its tests, without its source", stride(["test", "split.sbc"], { cwd: away }), (x) => x.status === 0 && x.stdout.includes("2 tests passed"));
  // 9. The editor.
  expect("the VS Code extension", stride(["vscode", "-q"]), (x) => x.status === 0 && readdirSync(work).some((f) => f.endsWith(".vsix")));
  if (vscode && !windows) {
    const app = join(vscode, "..");
    const vsixFile = join(work, readdirSync(work).find((f) => f.endsWith(".vsix")));
    const exts = join(home, "vscode-extensions");
    r = spawnSync(join(app, "code"), [join(app, "resources/app/out/cli.js"), "--extensions-dir", exts, "--user-data-dir", join(home, "vscode-user"), "--install-extension", vsixFile], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 120_000 });
    expect("installed into VS Code", r, (x) => x.stdout.includes("was successfully installed"));
    // The extension as installed, against the installed stride.
    const extension = join(exts, readdirSync(exts).find((d) => d.includes("stride")));
    r = spawnSync("sh", [join(repo, "editors/vscode/test/run.sh"), vscode], { env: { ...process.env, STRIDE_COMMAND: installed, STRIDE_EXTENSION: extension }, encoding: "utf8", timeout: 400_000 });
    expect("the installed extension in VS Code", r, (x) => x.stdout.includes("the extension passed in VS Code"));
  }
  // 10. Upgrading. Installing again over the same build says both are that build. Over an older stride, it replaces it
  // and names both: the older one is this build with another build's name in it (the same length, so the executable
  // is whole), since an older build of these sources cannot be made here.
  r = install();
  const name = built.replace(/:.*/, "");
  expect("reinstall: the same build", r, (x) => x.status === 0 && x.stdout.includes(`${name} (was ${name})`));
  const id = name.match(/build ([^)]+)\)/)[1];
  const older = "2026-01-01." + "0".repeat(id.length - 11);
  writeFileSync(installed, Buffer.from(readFileSync(installed).toString("latin1").replaceAll(id, older), "latin1"), { mode: 0o755 });
  expect("the older stride runs, and names its build", stride(["--version"]), (x) => x.stdout.includes(`(build ${older})`));
  r = install();
  expect("upgrade from another build", r, (x) => x.status === 0 && x.stdout.includes(`${name} (was ${name.replace(id, older)})`));
  expect("the new build, after", stride(["--version"]), (x) => x.stdout.trim() === built);
  console.log(`the journey passed: ${step} steps`);
} catch (e) {
  stop(e.message);
} finally {
  rmSync(home, { recursive: true, force: true });
}
