// The Stride compiler: a program's source in, its bytecode out, through the phases a compiler goes through.
//
//   1 parse      parse.mjs     the syntax tree (syntax.mjs: a lexer and parser written by hand)
//   2 load       load.mjs      the libraries the program uses, and the standard library
//   3 resolve    resolve.mjs   every name tied to its declaration, through scopes
//   4 check      check.mjs     every expression's type, and what each statement may do
//   5 flow       flow.mjs      what depends on order: vars read before they have a value, returns, which
//                              functions ask or write, unused answers
//   6 lower      lower.mjs     the intermediate form: functions of basic blocks
//   7 form       form.mjs      the boxes the program names, looked up in the form's header
//   8 generate   codegen.mjs   the bytecode, read back by the machine's own loader before it is given out
//
// `stride map` reads the lowered program against the header after these (map.mjs): which boxes each answer goes into.
//
// A phase runs only when those before it found no mistake: a mistake in a name would make every type after it
// wrong, and the person would read a cascade instead of the cause.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath, sep } from "node:path";
import { Diagnostics, SourceFile } from "./source.mjs";
import { load } from "./load.mjs";
import { resolve } from "./resolve.mjs";
import { check } from "./check.mjs";
import { flow } from "./flow.mjs";
import { lower } from "./lower.mjs";
import { checkForm } from "./form.mjs";
import { generate } from "./codegen.mjs";
import { load as loadBytecode } from "../runtime/vm.mjs";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(new URL(import.meta.url)));
export const STD_PATH = join(here, "../lib/std.stride");

// In the one executable the standard library is built in (scripts/build.mjs puts its text in STRIDE_STD);
// run from the repository it is read from lib/std.stride.
/* global STRIDE_STD */
const BUILT_IN_STD = typeof STRIDE_STD === "string" ? STRIDE_STD : null;
export const diskRead = (path) => (path === STD_PATH && BUILT_IN_STD !== null ? BUILT_IN_STD : existsSync(path) ? readFileSync(path) : null); // bytes: checked as UTF-8 (§1.1)
// The standard library's text, built in or on disk (§4.4).
export const stdSource = () => {
  const s = diskRead(STD_PATH);
  return typeof s === "string" ? s : new TextDecoder().decode(s);
};

// Compiles a program. `source` is its text, `name` how it is shown in mistakes, `dir` where its lib/ is.
// Options:
//   header      the form's header ({ form, pdf, boxes }); without it no bytecode is written (a program
//               is only ever compiled against its PDF)
//   read        how files are read (the disk, by default)
//   stdPath     the standard library (lib/std.stride)
//   until       the last phase to run: "flow" stops before lowering, "lower" before the form's boxes are looked up
// Gives { diagnostics, program (the intermediate form), questions, bytecode, phases }.
// The language's version (spec §21): what a program written for it can count on.
export const LANGUAGE = "1.0.0";

export function compile(source, name, { dir = ".", header = null, read = diskRead, stdPath = STD_PATH, until = "generate", depth = 0, trace = false, libraries = [], session = false } = {}) {
  const diagnostics = new Diagnostics();
  const file = new SourceFile(name, source);
  file.depth = depth;
  const out = { diagnostics, program: null, questions: [], bytecode: null, phases: [], resolved: null };
  const phase = (n) => out.phases.push(n);
  return phases(out, file, diagnostics, phase);

  function phases(out, file, diagnostics, phase) {
  const loaded = load(file, diagnostics, { read, libDir: [libDirOf(name, dir), ...libraries.filter((d) => resolvePath(d) !== resolvePath(libDirOf(name, dir)))], stdPath });
  phase("parse");
  phase("load");
  if (!loaded || !diagnostics.empty) return out;

  const resolved = resolve(loaded, diagnostics);
  out.resolved = resolved;
  phase("resolve");
  if (!diagnostics.empty) return out;

  check(resolved, diagnostics);
  phase("check");
  if (!diagnostics.empty) return out;

  flow(resolved, diagnostics, { session });
  phase("flow");
  if (!diagnostics.empty || until === "flow") return out;

  const program = lower(resolved, diagnostics, { trace });
  out.program = program;
  phase("lower");
  if (!diagnostics.empty || until === "lower") return out;

  // A test file has no form (§4.3): no boxes to check.
  let pdf = null;
  // A script has no form either (§4.6): its header is empty, whatever file is beside it.
  if (header || program.test || program.script) {
    pdf = checkForm(program, program.test || program.script ? { form: null, pdf: program.pdf, boxes: [] } : header, diagnostics, { open: !program.test && !program.script && header.open === true, resolved });
    out.questions = pdf.questions;
    out.boxes = pdf.boxes;
    phase("pdf");
    if (!diagnostics.empty) return out;
  }

  if (!pdf) return out;

  out.debug = {};
  out.bytecode = generate(program, pdf, out.debug);
  // The machine reads it back and verifies it before it goes anywhere.
  loadBytecode(out.bytecode);
  phase("generate");
  return out;
  }
}

// Where `import` looks (§4.5): lib/ beside a program; for a test file beside a library (§4.3), inside lib/ or a folder
// of it, that lib/ itself.
function libDirOf(name, dir) {
  const parts = resolvePath(dir).split(sep);
  const at = parts.lastIndexOf("lib");
  return name.endsWith(".test.stride") && at >= 0 ? parts.slice(0, at + 1).join(sep) : join(dir, "lib");
}

// The project a file is in (§4.7): the nearest folder above it holding stride.json, or null. Gives { root, needs,
// libraries: the folders its programs' `import` also looks in }, or throws (projectProblem) when stride.json is not one,
// or asks for a Stride these tools are not.
export function projectOf(path) {
  for (let dir = resolvePath(dirname(path)); ; dir = dirname(dir)) {
    const file = join(dir, "stride.json");
    if (existsSync(file)) {
      let p;
      try {
        p = JSON.parse(readFileSync(file, "utf8"));
      } catch (e) {
        throw Object.assign(new Error(`${file} is not JSON: ${e.message}`), { projectProblem: true });
      }
      const needs = typeof p?.stride === "string" ? p.stride.match(/^(\d+)\.(\d+)$/) : null;
      if (!needs) throw Object.assign(new Error(`${file}: "stride" is the version of Stride the project needs, MAJOR.MINOR, as "1.0"`), { projectProblem: true });
      const [major, minor] = LANGUAGE.split(".").map(Number);
      if (Number(needs[1]) !== major || Number(needs[2]) > minor) throw Object.assign(new Error(`${file}: the project needs Stride ${p.stride}, and these tools are Stride ${LANGUAGE}${Number(needs[1]) === major ? "; upgrade stride" : ""}`), { projectProblem: true });
      const extra = p.libraries ?? [];
      if (!Array.isArray(extra) || extra.some((x) => typeof x !== "string")) throw Object.assign(new Error(`${file}: "libraries" is a list of folders, as ["../shared/lib"]`), { projectProblem: true });
      return { root: dir, needs: p.stride, libraries: [join(dir, "lib"), ...extra.map((x) => resolvePath(dir, x))] };
    }
    if (dirname(dir) === dir) return null;
  }
}

// Compiles the file at `path`, with its header beside it (headerPathsOf), and its project's libraries (§4.7).
export function compileFile(path, options = {}) {
  const project = projectOf(path);
  if (project) options = { libraries: project.libraries, ...options };
  const source = readFileSync(path);
  const paths = headerPathsOf(path, source);
  const headerPath = paths.find((p) => existsSync(p)) ?? paths[0];
  let header = options.header ?? null;
  // A header that is not JSON is the file's own mistake, said with its name.
  if (!header && existsSync(headerPath)) {
    try {
      header = JSON.parse(readFileSync(headerPath, "utf8"));
    } catch (e) {
      throw Object.assign(new Error(`${headerPath} is not JSON: ${e.message}`), { headerProblem: true });
    }
  }
  return { ...compile(source, basename(path), { dir: dirname(path), header, ...options }), headerPath, headerPaths: paths, header };
}

// Where a program's header may be (§10.2): beside it, named as the program (<program>.boxes.json), or as its form
// (<form id>.boxes.json, the id its form line gives), in that order.
export function headerPathsOf(path, source) {
  const base = path.replace(/\.stride$/, "");
  const text = typeof source === "string" ? source : new TextDecoder().decode(source);
  const form = text.replace(/^\uFEFF/, "").match(/^form[ \t]+([A-Za-z0-9][A-Za-z0-9_.-]*)[ \t]*(?:#.*)?$/m)?.[1];
  const paths = [`${base}.boxes.json`];
  if (form && form !== basename(base)) paths.push(join(dirname(path), `${form}.boxes.json`));
  return paths;
}
