// `stride header` and `stride new` (§17.6): a form's header read from its PDF, and a new program to start from.
//
// The header is what the compiler checks a program against (§10): the PDF's sha256 and its boxes, each with what the
// PDF says of it: its kind, export value, longest length and its maker's description (src/pdf-boxes.mjs). Which
// printed words stand beside a box is not in a PDF; whoever writes the program may add them to the header as each
// box's "near" (§10.6). A new program is the shortest one that compiles against its form: one question filling the
// first text box, and a skip of every other box, each to be replaced with what fills it; with a test of it. Without
// a PDF it is a script (§4.6).
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { compile, projectOf, LANGUAGE } from "./compile.mjs";
import { KEYWORDS } from "./syntax.mjs";
import { LIBRARY } from "./codes.mjs";

// PDF.js, loaded when a PDF is read, never when stride starts. It reads the PDF here, in this process, with its
// worker loaded beside it, so the one executable, with no worker file and no canvas package, reads PDFs too; the
// drawing classes it makes as it loads are given stand-ins, since nothing here draws.
let reader = null;
async function pdfReader() {
  for (const name of ["DOMMatrix", "ImageData", "Path2D"]) globalThis[name] ??= class {};
  // As it loads, PDF.js says it found no canvas package; nothing here needs one.
  const [log, warn] = [console.log, console.warn];
  console.log = console.warn = () => {};
  try {
    globalThis.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    reader ??= (await import("./pdf-boxes.mjs")).pageBoxes;
  } finally {
    [console.log, console.warn] = [log, warn];
  }
  return reader;
}

const FORM_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

// The header of a PDF: { form, pdf, boxes }, or { error }.
export async function headerOf(bytes, form) {
  let boxes;
  try {
    boxes = await (await pdfReader())(bytes);
  } catch (e) {
    return { error: `not a PDF this tool can read: ${e.message}` };
  }
  if (!boxes.length) return { error: "the PDF has no boxes a person fills: it is flat or scanned, and a program has nothing to write" };
  return { form, pdf: createHash("sha256").update(bytes).digest("hex"), boxes };
}

export const writeHeader = (path, header) => writeFileSync(path, `${JSON.stringify(header, null, 1)}\n`);

// The longest start every box's name shares, up to a "." (the program's `fields` line, §4.1).
function prefixOf(names) {
  if (names.length < 2) return "";
  let p = names[0];
  for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
  return p.slice(0, p.lastIndexOf(".") + 1);
}

// Words no name may be: Stride's keywords and the standard library's functions.
const TAKEN = new Set([...KEYWORDS, ...LIBRARY.flatMap((e) => e.names)]);

// A question's name from the words printed beside its box (§2.1): small letters, digits and _, starting with a
// letter, and not a word Stride keeps for itself.
const nameOf = (words) => {
  const n = words.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").split("_").slice(0, 3).join("_");
  const name = /^[a-z]/.test(n) ? n : `answer${n ? `_${n}` : ""}`;
  return TAKEN.has(name) ? `${name}_answer` : name;
};

// Words in quotes as Stride writes them (§2.6): `"`, `\`, `{` and `}` escaped, a line break and a tab by their
// escapes, any other control character by its code; so the words are taken as they are, never as a value put in.
const quote = (t) =>
  `"${[...t]
    .map((c) => {
      if (c === "\\" || c === '"' || c === "{" || c === "}") return `\\${c}`;
      if (c === "\n") return "\\n";
      if (c === "\t") return "\\t";
      const cp = c.codePointAt(0);
      return cp < 0x20 || cp === 0x7f ? `\\u{${cp.toString(16)}}` : c;
    })
    .join("")}"`;

// The program and its first test, for a form's header.
function starter(name, header, withQuestion = true) {
  const fields = [...new Set(header.boxes.map((b) => b.field))];
  const prefix = prefixOf(fields);
  const short = (f) => f.slice(prefix.length);
  // The first text box's question says what the PDF's maker called the box, else the box's own name: words to be
  // replaced by the form's own, as the person writing the program reads them.
  const first = withQuestion ? header.boxes.find((b) => b.kind === "text") : null;
  const says = first ? first.tooltip ?? short(first.field).replace(/\[\d+\]/g, "").split(".").pop() : null;
  const question = first ? nameOf(says) : null;
  const lines = [`form ${name}`, `pdf ${header.pdf}`];
  if (prefix) lines.push(`fields ${quote(prefix)}`);
  lines.push("", "# Every box of the form is written or skipped once on every way through (stride explain S516). Replace", "# each skip with the question and the write that fill its box; stride check says what is still wrong.", "# A question's words are the form's own: write them as the form prints them.", "");
  if (first) lines.push(`ask ${question}: text ${quote(says)}`, `fill ${quote(short(first.field))} = ${question}`, "");
  for (const f of fields) if (!first || f !== first.field) lines.push(`skip ${quote(short(f))} because "not filled yet"`);
  const test = first ? { answers: { [question]: "Ada Lovelace" }, boxes: { [short(first.field)]: "Ada Lovelace" } } : { answers: {}, boxes: {} };
  return { source: `${lines.join("\n")}\n`, test };
}

// A script to start from (§4.6), and its test.
const SCRIPT = (name) => `# ${name}: a script. It has no form line, so it writes no boxes; \`stride new ${name} --pdf <file.pdf>\` starts a
# program that fills a form.
ask name: text "Your name"
print("Hello, {either(name, "there")}")
`;

// Makes <name>.stride, <name>.tests/first.json and, with a PDF, <name>.boxes.json and <name>.pdf beside it. Gives
// { made: [paths] } or { error, usage }. Nothing is written over.
export async function newProgram(path, pdfPath = null) {
  const name = basename(path).replace(/\.stride$/, "");
  if (!FORM_ID.test(name)) return { error: `"${name}" is not a form id: letters, digits, ., - and _`, usage: true };
  const dir = dirname(path);
  const files = { program: join(dir, `${name}.stride`), test: join(dir, `${name}.tests`, "first.json"), header: join(dir, `${name}.boxes.json`), pdf: join(dir, `${name}.pdf`) };
  // Every file it would write, checked before any is: the PDF too, unless it is the very file given.
  const samePdf = pdfPath && resolve(pdfPath) === resolve(files.pdf);
  for (const f of [files.program, files.test, ...(pdfPath ? [files.header] : []), ...(pdfPath && !samePdf ? [files.pdf] : [])]) if (existsSync(f)) return { error: `${f} is there already; nothing was written` };
  let source, test;
  const made = [];
  if (pdfPath) {
    if (!existsSync(pdfPath)) return { error: `${pdfPath}: no such file`, usage: true };
    const bytes = readFileSync(pdfPath);
    const header = await headerOf(bytes, name);
    if (header.error) return { error: `${pdfPath}: ${header.error}` };
    // What it writes compiles: a starter that does not (words the compiler reads otherwise) gives way to one that
    // only skips; one that still does not is said, and nothing is written.
    const compiles = ({ source }) => !compile(source, `${name}.stride`, { dir, header }).diagnostics.sorted().some((d) => d.severity === "error");
    let start = starter(name, header);
    if (!compiles(start)) start = starter(name, header, false);
    if (!compiles(start)) return { error: `${pdfPath}: a program for it does not compile: ${compile(start.source, `${name}.stride`, { dir, header }).diagnostics.sorted()[0]?.message}` };
    ({ source, test } = start);
    mkdirSync(dir, { recursive: true }); // a folder it names that is not there yet is made
    writeHeader(files.header, header);
    made.push(files.header);
    if (!samePdf) (copyFileSync(pdfPath, files.pdf), made.push(files.pdf));
  } else {
    source = SCRIPT(name);
    test = { answers: { name: "Ada" }, prints: ["Hello, Ada"] };
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(files.program, source);
  mkdirSync(dirname(files.test), { recursive: true });
  writeFileSync(files.test, `${JSON.stringify(test, null, 2)}\n`);
  made.unshift(files.program, files.test);
  return { made, script: !pdfPath };
}

// The files a command works on in the paths it is given (§4.7): a file as it is; a folder, every Stride file in it
// and its folders that the command takes (not hidden folders, node_modules, or a program's .tests/). `check`: the
// programs, scripts and test files, not the libraries (they are checked through what uses them); `test`: the
// programs that have tests and the test files; `fmt`: every .stride file. Gives { files } or { error, usage }.
export function discover(paths, kind) {
  const files = [];
  const isTest = (f) => f.endsWith(".test.stride");
  // A library: in a lib/ folder, or in a folder its project's stride.json names (§4.7).
  const libraries = new Map(); // folder -> its project's library folders
  const projectLibraries = (f) => {
    const dir = dirname(resolve(f));
    if (!libraries.has(dir)) {
      let found = [];
      try {
        found = projectOf(f)?.libraries ?? [];
      } catch {} // said when the file is compiled
      libraries.set(dir, found);
    }
    return libraries.get(dir);
  };
  const inLib = (f) => f.split(/[\\/]/).slice(0, -1).includes("lib") || projectLibraries(f).some((d) => !relative(d, resolve(f)).startsWith(".."));
  const takes = (f) =>
    kind === "fmt" ? true : kind === "check" ? isTest(f) || !inLib(f) : isTest(f) || (!inLib(f) && existsSync(f.replace(/\.stride$/, ".tests")));
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const s = statSync(path);
      if (s.isDirectory()) {
        if (!name.startsWith(".") && name !== "node_modules" && !name.endsWith(".tests")) walk(path);
      } else if (name.endsWith(".stride") && takes(path)) files.push(path);
    }
  };
  for (const p of paths) {
    if (!existsSync(p)) return { error: `${p}: no such file or folder`, usage: true };
    if (statSync(p).isDirectory()) walk(p);
    else if (!p.endsWith(".stride")) return { error: `${p}: not a Stride file (.stride)`, usage: true };
    else files.push(p);
  }
  return { files: [...new Set(files)].map((f) => f.replace(/^\.\//, "")) };
}

// `stride init` (§4.7): stride.json, saying the Stride the project needs, and lib/ for its shared libraries.
export function initProject(folder) {
  const file = join(folder, "stride.json");
  if (existsSync(file)) return { error: `${file} is there already: ${folder} is a project` };
  if (existsSync(folder) && !statSync(folder).isDirectory()) return { error: `${folder}: a file, not a folder`, usage: true };
  const needs = LANGUAGE.split(".").slice(0, 2).join(".");
  mkdirSync(join(folder, "lib"), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ stride: needs }, null, 2)}\n`);
  return { made: [file, join(folder, "lib/")], needs, lib: join(folder, "lib/") };
}
