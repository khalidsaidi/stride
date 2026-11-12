// `stride run` in the browser (§17.18): a program's workflow on this computer, beside its PDF, at
// http://127.0.0.1:<port>/. The page (workflow-page.js, with Stride's runner, runtime/runner.js) is bundled once when
// the server starts. A source program is compiled again each time the page asks for it, so a reload shows the last
// edit; bytecode is served as it is. Only this computer can reach the server, and the page sends nothing anywhere.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { compileFile, headerPathsOf } from "./compile.mjs";
import { load } from "../runtime/vm.mjs";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(new URL(import.meta.url)));
// In the one executable the page, its styles and PDF.js's worker are built in (scripts/build.mjs); else they
// are bundled from the repository when the server starts.
/* global STRIDE_PAGE */
const BUILT_IN = typeof STRIDE_PAGE !== "undefined" ? STRIDE_PAGE : null;
const pdfjsDir = () => dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

const escaped = (t) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const PAGE = (name, today, writing) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escaped(name)}: workflow</title><link rel="stylesheet" href="/app.css">${today ? `<meta name="stride-today" content="${today}">` : ""}${writing ? `<meta name="stride-writing" content="yes">` : ""}</head>
<body>
<header><h1><span class="code">${escaped(name)}</span> workflow</h1>
<p class="line"><span class="status">Loading…</span></p>
<div class="actions"><button type="button" class="quiet" id="questions">Questions</button></div></header>
<div id="viewerContainer"><div id="viewer" class="pdfViewer"></div></div>
<script type="module" src="/app.js"></script>
</body></html>`;

// The page's script and styles, and PDF.js's worker.
export async function bundle() {
  if (BUILT_IN) return BUILT_IN;
  const { build } = await import("esbuild");
  const out = await build({
    entryPoints: [join(here, "workflow-page.js")],
    bundle: true,
    format: "esm",
    target: "es2022",
    write: false,
    outdir: "/",
    loader: { ".json": "json", ".svg": "dataurl", ".png": "dataurl", ".gif": "dataurl", ".cur": "dataurl" },
    logLevel: "silent",
  });
  const file = (ext) => out.outputFiles.find((f) => f.path.endsWith(ext))?.text ?? "";
  return { js: file(".js"), css: file(".css"), worker: readFileSync(join(pdfjsDir(), "legacy/build/pdf.worker.min.mjs"), "utf8") };
}

// Starts the server for a program, its source (`<name>.stride`) or its bytecode (`<name>.sbc`); gives { url, close },
// or { error }. The caller has checked the program compiles and is not a script.
export async function serve(programPath, { pdfPath = null, port = 8080, today = null } = {}) {
  const fromBytecode = programPath.endsWith(".sbc");
  // Beside the program, named as it, or for source, as its form (as its header is, §10.2).
  const named = programPath.replace(/\.(stride|sbc)$/, ".pdf");
  const asForm = !fromBytecode && existsSync(programPath) ? headerPathsOf(programPath, readFileSync(programPath))[1]?.replace(/\.boxes\.json$/, ".pdf") : null;
  const pdfFile = pdfPath ?? (!existsSync(named) && asForm && existsSync(asForm) ? asForm : named);
  if (!existsSync(pdfFile)) return { error: `${pdfFile}: no such file; give the form's PDF with --pdf`, usage: true };
  // The PDF as it is now: read again at every load, with the source and its header, so the three may be replaced
  // together while the run goes on.
  const pdfNow = () => {
    if (!existsSync(pdfFile)) return { why: `${pdfFile}: no such file; put the form's PDF back, or run again with --pdf` };
    const bytes = readFileSync(pdfFile);
    return { bytes, sha: createHash("sha256").update(bytes).digest("hex") };
  };
  // The program, as the page is to be given it: bytecode, or why there is none. Source is compiled at every ask.
  const bytecode = fromBytecode ? readFileSync(programPath) : null;
  const current = () => {
    const pdf = pdfNow();
    if (pdf.why) return pdf;
    const sha = pdf.sha;
    if (fromBytecode) {
      const p = load(bytecode);
      return p.pdf !== sha ? { why: `${pdfFile} is not the PDF ${programPath} was compiled for (its sha256 differs); give the right one with --pdf` } : { bytes: bytecode };
    }
    let out;
    try {
      out = compileFile(programPath);
    } catch (e) {
      if (!e.headerProblem && !e.projectProblem) throw e;
      return { why: e.message };
    }
    if (out.program?.script) return { why: `${programPath} is a script: it runs in the terminal, with stride run (§4.6)` };
    if (out.header && out.header.pdf !== sha) return { why: `${pdfFile} is not the PDF ${programPath}'s header is for (its sha256 differs); run stride header on the right one, or give it with --pdf` };
    if (out.bytecode) return { bytes: Buffer.from(out.bytecode) };
    return { why: out.diagnostics.sorted().filter((d) => d.severity === "error").slice(0, 20).map((d) => d.format({ color: false })).join("\n\n") || `${programPath}: no header ${out.headerPath}` };
  };
  const first = current();
  if (first.why) return { error: first.why };
  const { js, css, worker } = await bundle();
  const name = basename(programPath).replace(/\.(stride|sbc)$/, "");
  const send = (res, type, body, status = 200) => (res.writeHead(status, { "content-type": type, "cache-control": "no-store" }), res.end(body));
  // Whatever goes wrong answering one request is said to that request; the run goes on.
  const server = createServer((req, res) => {
    try {
      answer(req, res);
    } catch (e) {
      send(res, "text/plain; charset=utf-8", `stride run: ${e.message}`, 500);
    }
  });
  function answer(req, res) {
    // Only a page opened at this computer's own address is answered: another site's page, pointed here by a name
    // of its own, is not given the program or the PDF.
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) return send(res, "text/plain", "not here", 403);
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/") return send(res, "text/html; charset=utf-8", PAGE(name, today, !fromBytecode));
    if (path === "/app.js") return send(res, "text/javascript", js);
    if (path === "/app.css") return send(res, "text/css", css);
    if (path === "/form.pdf") {
      const pdf = pdfNow();
      return pdf.why ? send(res, "text/plain; charset=utf-8", pdf.why, 404) : send(res, "application/pdf", pdf.bytes);
    }
    if (path === "/pdf.worker.mjs") return send(res, "text/javascript", worker);
    if (path.startsWith("/standard_fonts/") && !BUILT_IN) {
      const f = join(pdfjsDir(), "standard_fonts", path.slice("/standard_fonts/".length).replace(/[^A-Za-z0-9_.-]/g, ""));
      return existsSync(f) ? send(res, "application/octet-stream", readFileSync(f)) : send(res, "text/plain", "", 404);
    }
    if (path === "/workflow.sbc") {
      // The program as it stands now; its mistakes, or why it may not be given, when it has them.
      const now = current();
      return now.bytes ? send(res, "application/octet-stream", now.bytes) : send(res, "text/plain; charset=utf-8", now.why, 422);
    }
    send(res, "text/plain", "not here", 404);
  }
  return new Promise((done) => {
    server.once("error", (e) => done({ error: e.code === "EADDRINUSE" ? `port ${port} is in use; give another with --port` : e.message }));
    server.listen(port, "127.0.0.1", () => done({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() }));
  });
}
