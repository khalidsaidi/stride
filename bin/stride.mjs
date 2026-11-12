#!/usr/bin/env node
// stride: the Stride compiler, machine and tools on the command line (the language: docs/spec.md; how to
// write programs: docs/guide.md, `stride guide`; coming from another language: `stride guide coming-from`).
//
//   Every command, with its options and an example, is in COMMANDS below: `stride help`, `stride help <command>`.
//
// The command line (§17.10): `stride <command> [option | argument]…`; an option is `--name`, `--name=value`, or a
// dash and one letter; `--` ends the options. What a command gives is written to stdout; mistakes, warnings, faults,
// the trace and what a command did (status) to stderr (§17.11); --quiet drops warnings and status, --json makes
// stdout one JSON document.
//
// A program is checked against its form's header (<file>.boxes.json beside it: the PDF's boxes, written by
// `stride header`), as a C program is against its headers.
// Only `header`, `new` and `run` in the browser read a PDF, and nothing needs the network. scripts/build.mjs makes
// this one executable; scripts/install.sh installs it.
import { existsSync, readFileSync, writeFileSync, statSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { compile, compileFile, projectOf, LANGUAGE } from "../src/compile.mjs";
import { find as findInLibrary, setup as exampleSetup, EXAMPLE_TODAY } from "../src/library.mjs";
import { format } from "../src/format.mjs";
import { runTests, parseDigits, todayMistake, expectResults } from "../src/test.mjs";
import { CODES } from "../src/codes.mjs";
import { SourceFile, Diagnostics, KIND, plural, faultWords } from "../src/source.mjs";
import { parseExpression } from "../src/syntax.mjs";
import { showFunction } from "../src/ir.mjs";
import { VERSION, OP_NAME } from "../runtime/bytecode.mjs";
import { holdsItself } from "../runtime/values.mjs";
import { disassemble, load, run, boxValues, stringOf } from "../runtime/vm.mjs";

// ----- output (§17.11): results to stdout, everything about them to stderr

let quiet = false; // --quiet: no warnings, no status
let jsonOut = false; // --json: what went wrong is the document's error (§16.2)
let colours = { out: false, err: false };
const paint = (code, stream) => (s) => (colours[stream] ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint(1, "out"), green = paint(32, "out"), red = paint(31, "out");
const errRed = paint(31, "err"), errGreen = paint(32, "err");
const out = (text) => process.stdout.write(`${text}\n`); // what the command gives
const err = (text) => process.stderr.write(`${text}\n`); // mistakes, warnings, faults, the trace
const status = (text) => !quiet && err(text); // what the command did

// The build of these tools: the language, the bytecode, and the build's own identity (scripts/build.mjs puts it
// in; from the repository, "source").
/* global STRIDE_BUILD */
const BUILD = typeof STRIDE_BUILD === "string" ? STRIDE_BUILD : "source";

// ----- the commands (§17): how each is written, what it does, the options it takes, an example

// An option: [what it is, the name of its value, or null when it takes none].
const COMMANDS = {
  __proto__: null,
  run: ["stride run <file.stride|file.sbc> [--pdf <file.pdf>] [--port N]  |  stride run <file.stride|file.sbc|-> --terminal [answers.json|-] [key=value …]", "Runs a program in the browser: its workflow beside its PDF, the questions one at a time, the filled PDF to download. A source program is checked and compiled first, and again at each reload, so saving and reloading shows a change; a compiled one needs only its PDF. With --terminal, or for a script, it runs in the terminal: answers come from a JSON file, from stdin (-), as key=value arguments, or, at a terminal with none of those, are asked there one at a time; a script prints what it prints, a program also says the questions it asked and the boxes it wrote. `-` as the file reads a script from stdin.", { "--terminal": ["run a program in the terminal, not the browser", null], "--pdf": ["in the browser: the form's PDF; else <file>.pdf beside the program", "file.pdf"], "--port": ["in the browser: the port to serve on, 0 for any free one; else 8080", "N"], "--trace": ["in the terminal: each statement as it runs, with its line and the values it changes, on stderr", null], "--today": ["the date today() gives", "YYYY-MM-DD"], "--prompt": ["in the terminal: ask the questions one at a time, reading the answers from stdin, terminal or not", null], "--no-prompt": ["in the terminal: never ask: questions without an answer stay unanswered", null], "--json": ["in the terminal: one JSON document: questions, prints, boxes, fault", null] }, "stride run consent.stride"],
  check: ["stride check [path …]", "Every check the compiler makes, writing nothing: a program against its form's header, a script, a test file; a folder, every one in it. No path: the folder you are in. run and compile make these checks first, so check is never needed before them.", { "--json": ["one JSON document: each file and its mistakes and warnings", null] }, "stride check w9.stride"],
  compile: ["stride compile <file.stride> [-o <file.sbc>]", "Compiles to bytecode, beside the source or to -o: the program, the library code it uses, its questions, the boxes each answer goes into, its words and its form's PDF fingerprint; everything a run needs but the PDF. It needs no answers and opens nothing. Share the .sbc with its PDF: stride run file.sbc.", { "--output": ["where the bytecode goes", "file.sbc"], "--json": ["one JSON document: the bytecode written, or the mistakes", null] }, "stride compile w9.stride -o w9.sbc"],
  test: ["stride test [path …] | stride test <file.stride> [name …]", "Tests: a program's in <file>.tests/ (answers in; boxes, prints and faults compared), a test file's expects; a folder, every program with tests and every test file in it. No path: the folder you are in. After one program, names choose its tests.", { "--today": ["the date today() gives, unless a test gives its own", "YYYY-MM-DD"], "--match": ["only the tests whose name holds these words", "words"], "--json": ["one JSON document: every test and what went wrong", null] }, "stride test"],
  eval: ['stride eval "<expression>"', "The value of one expression, with the standard library and, with --import, a library. An expression starting with a dash and a letter is given after --: stride eval -- -x.", { "--import": ["a library of lib/ to use", "name"], "--today": ["the date today() gives", "YYYY-MM-DD"], "--json": ["one JSON document: the value, or the mistakes or fault", null] }, 'stride eval "pad_left(\\"7\\", 3, \\"0\\")"'],
  repl: ["stride repl", "A session to try Stride in: declarations and statements are kept, each expression's value is shown, questions are asked as they come. :help, :list, :reset, :quit.", { "--import": ["a library of lib/ to use", "name"], "--today": ["the date today() gives", "YYYY-MM-DD"] }, "stride repl"],
  debug: ["stride debug <file.stride> [answers.json|-] [key=value …]", "Runs the program under a debugger at the terminal: break at lines, step in, over and out, see the values and the calls. help lists its commands.", { "--today": ["the date today() gives", "YYYY-MM-DD"] }, "stride debug w9.stride"],
  explain: ["stride explain <code>", "What a mistake, warning or fault means and what to do, from the spec.", {}, "stride explain W009"],
  doc: ["stride doc [word]", "The standard library: every function whose name or description holds the word, with its signature, what it gives, and an example; with no word, all of them.", {}, "stride doc date"],
  guide: ["stride guide [topic]", "How to write Stride: the guide, built in. With a topic, the part whose heading holds it; `stride guide coming-from` for someone who knows Go, Java, JavaScript or Python; `stride guide topics` lists them.", {}, "stride guide coming-from"],
  new: ["stride new <name> [--pdf <file.pdf>]", "A new program to start from: <name>.stride, a test in <name>.tests/, and, with --pdf, the form's header <name>.boxes.json read from the PDF.", { "--pdf": ["the form's PDF, whose boxes the program fills", "file.pdf"] }, "stride new w9 --pdf fw9.pdf"],
  init: ["stride init [folder]", "Makes a folder a project: stride.json, saying the Stride it needs, and lib/ for the libraries its programs share.", {}, "stride init"],
  header: ["stride header <file.pdf> [-o <file.boxes.json>]", "The form's header from its PDF: its sha256 and each box (each field once, with every widget's place) as the PDF gives it: its kind, export values, longest length, whether it is read-only and its maker's description. It works nothing out: the words printed beside a box are yours to add.", { "--output": ["where the header goes; else beside the PDF", "file.boxes.json"] }, "stride header fw9.pdf -o w9.boxes.json"],
  map: ["stride map <file.stride>", "Which boxes each question's answer goes into (as given, or deciding what is written), the boxes written from no answer, those a name worked out as the program runs may write, and those not written.", { "--json": ["one JSON document", null] }, "stride map w9.stride"],
  asm: ["stride asm <file.stride|file.sbc>", "The instructions, with their source lines.", { "--ir": ["the intermediate form instead", null] }, "stride asm w9.stride"],
  fmt: ["stride fmt <path …>", "Puts the files in Stride's one layout, comments kept; a folder, every .stride file in it.", { "--check": ["only says which files are not in it", null] }, "stride fmt ."],
  lsp: ["stride lsp", "The language server, for editors: mistakes as you type, completion, signatures, going to a definition, references, renaming, what a name is.", {}, "stride lsp"],
  dap: ["stride dap", "The debugger for editors (the Debug Adapter Protocol): breakpoints, stepping, the calls and their values.", {}, "stride dap"],
  vscode: ["stride vscode [-o <file.vsix>]", "Writes the VS Code extension, to install with: code --install-extension stride.vsix", { "--output": ["where it goes; else stride-<version>.vsix here", "file.vsix"] }, "stride vscode"],
  help: ["stride help [command]", "These commands, or one command's options and an example.", {}, "stride help run"],
  version: ["stride version", "The tools' version, the language's (§21) and the bytecode's, and the build.", {}, "stride version"],
};
// Taken by every command (§17.10).
const COMMON = { "--help": ["this command's help", null], "--quiet": ["no warnings and no status lines; never what the command gives, nor its mistakes or faults", null], "--color": ["colour: auto (at a terminal, without NO_COLOR), always or never", "auto|always|never"] };
const SHORT = { "-h": "--help", "-q": "--quiet", "-o": "--output" };
// How many arguments each command takes.
const ARGS = { run: [1, Infinity], check: [0, Infinity], compile: [1, 1], test: [0, Infinity], eval: [1, 1], repl: [0, 0], debug: [1, Infinity], explain: [1, 1], doc: [0, 1], guide: [0, 1], new: [1, 1], init: [0, 1], header: [1, 1], map: [1, 1], asm: [1, 1], fmt: [1, Infinity], lsp: [0, 0], dap: [0, 0], vscode: [0, 0], help: [0, 1], version: [0, 0] };

const USAGE = `stride ${LANGUAGE}: the Stride tools\n\nusage:\n${Object.values(COMMANDS).map(([u]) => `  ${u}`).join("\n")}\n\nstride help <command> says more; stride guide says how to write Stride.`;
function helpOf(command) {
  const [usage, does, options, example] = COMMANDS[command];
  const all = { ...options, ...COMMON };
  const short = (o) => Object.keys(SHORT).find((k) => SHORT[k] === o);
  const opts = Object.entries(all).map(([o, [w, v]]) => `  ${`${short(o) ? `${short(o)}, ` : ""}${o}${v ? `=${v}` : ""}`.padEnd(28)} ${w}`).join("\n");
  return `${usage}\n\n${does}\n\noptions:\n${opts}\n\nexample: ${example}`;
}

// A usage mistake (§17.5, §17.10): what is wrong, the command's own usage, and where to read more; exit 2.
function usage(command, what) {
  err(COMMANDS[command] ? `stride ${command}: ${what}\nusage: ${COMMANDS[command][0]}\nstride help ${command} says more.` : `stride: ${what}\n${USAGE}`);
  return 2;
}

// The computer's browser, opened at a run's address (§17.18): the one $BROWSER names, none when it is "none";
// else Windows' own when this is WSL, else xdg-open's. When none can be opened, the address is said to open by hand.
function openBrowser(url) {
  const chosen = process.env.BROWSER;
  if (chosen === "none") return;
  let wsl = false;
  try {
    wsl = /microsoft/i.test(readFileSync("/proc/sys/kernel/osrelease", "utf8"));
  } catch {}
  const [cmd, ...rest] = chosen ? [chosen, url] : wsl ? ["cmd.exe", "/c", "start", "", url] : ["xdg-open", url];
  const child = spawn(cmd, rest, { stdio: "ignore", detached: true });
  child.on("error", () => status(`open ${url} in your browser`));
  child.unref();
}

// What went wrong, said: on stderr, or with --json as the one document, { ok: false, error } (§16.2). A failure said
// is the exit status, even if a reader stops reading after it (§17.11).
function fail(message, code = 1) {
  if (jsonOut) out(JSON.stringify({ ok: false, error: message }));
  else err(message);
  process.exitCode = code;
  return code;
}

// The words of a command line, read by its command's options (§17.10). Gives { flags, values, args } or { mistake }.
function parseArgs(command, words) {
  const own = { ...(COMMANDS[command]?.[2] ?? {}), ...COMMON };
  const flags = new Set();
  const values = new Map();
  const args = [];
  let ended = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (ended) {
      args.push(w);
      continue;
    }
    if (w === "--") {
      ended = true;
      continue;
    }
    const long = w.match(/^(--[A-Za-z][A-Za-z0-9-]*)(?:=(.*))?$/s);
    const short = /^-[A-Za-z]$/.test(w) ? w : null;
    if (!long && !short) {
      args.push(w); // a word, `-`, `-1`, `-abs(1)`: an argument
      continue;
    }
    const name = long ? long[1] : SHORT[short] ?? short;
    const written = long ? long[1] : short; // a mistake names the option as it was written
    const spec = own[name];
    if (!spec) return { mistake: `there is no option ${long ? long[1] : short}${Object.keys(own).some((o) => o.startsWith((long?.[1] ?? short).slice(0, 4))) ? `; it takes ${Object.keys(own).filter((o) => o !== "--help").join(", ")}` : ""}` };
    if (flags.has(name) || values.has(name)) return { mistake: `${written} is given twice` };
    if (spec[1]) {
      let v = long?.[2];
      if (v === undefined) {
        if (i + 1 >= words.length) return { mistake: `${written} needs a value: ${written} ${spec[1]}` };
        v = words[++i];
      }
      values.set(name, v);
    } else {
      if (long?.[2] !== undefined) return { mistake: `${written} takes no value` };
      flags.add(name);
    }
  }
  return { flags, values, args };
}

// A path as a file stride can read (§17.5): one that names nothing is a usage mistake; a folder, or one it may not
// read, is said plainly.
function readable(path, what = "file") {
  if (!existsSync(path)) return { error: `${path}: no such ${what}`, usage: true };
  const s = statSync(path);
  if (what === "file" && s.isDirectory()) return { error: `${path}: a folder, not a file`, usage: true };
  try {
    readFileSync(path, { flag: "r" }).length;
  } catch (e) {
    return { error: `${path}: cannot be read (${e.code === "EACCES" ? "permission denied" : e.code ?? e.message})` };
  }
  return {};
}

const faultJSON = (f) => (f ? { code: f.code, message: f.message, file: f.file ?? null, line: f.line ?? null, column: f.column ?? null, stack: (f.stack ?? []).map((x) => ({ function: x.function, file: x.file ?? null, line: x.line ?? null, column: x.column ?? null })) } : null);

// A program with no file of its own (one read from stdin, an eval, a session) stands in the folder you are in: its
// `import` looks in lib/ there and in that folder's project (§4.7), as a file's there would. Throws as projectOf does.
const here = () => ({ dir: process.cwd(), libraries: projectOf(`${process.cwd()}/stdin.stride`)?.libraries ?? [] });

// The program a command works on: compiled from source (a file, or a script given on stdin), or read from bytecode.
// Its warnings are said on stderr, or kept for the JSON document; its mistakes are given back.
function program(file, { needBytecode = true, warnings = null, source = null, options = {} } = {}) {
  if (source === null) {
    const r = readable(file);
    if (r.error) return r;
  }
  // A compiled file the loader refuses (another version, cut short, …) is the file's mistake, said plainly (§18.1).
  if (file.endsWith(".sbc")) {
    try {
      return { p: load(readFileSync(file)) };
    } catch (e) {
      return { error: `${file}: not a program this machine can run: ${e.message}` };
    }
  }
  if (source === null && !file.endsWith(".stride")) return { error: `${file}: a Stride program ends in .stride, a compiled one in .sbc`, usage: true };
  let out;
  try {
    out = source !== null ? { ...compile(source, "stdin.stride", { ...here(), ...options }), header: null } : compileFile(file, options);
  } catch (e) {
    if (e.headerProblem || e.projectProblem) return { error: e.message };
    throw e;
  }
  const ws = out.diagnostics.warnings;
  if (warnings) warnings.push(...ws);
  else if (!quiet) for (const w of ws) err(`${w.format({ color: colours.err })}\n`);
  if (!out.diagnostics.empty) return { out, mistakes: out.diagnostics.sorted().filter((d) => d.severity === "error") };
  if (!out.header && needBytecode && !out.program?.test && !out.program?.script) return { out, error: `${file}: no header ${(out.headerPaths ?? [out.headerPath]).join(" or ")}; write it with stride header <form.pdf>` };
  return { out, p: out.bytecode ? load(out.bytecode) : null };
}

// Mistakes for a person, on stderr: the first 20 in order of place, then how many more (§16.1).
const SHOWN = 20;
function report(mistakes) {
  process.exitCode = 1;
  for (const m of mistakes.slice(0, SHOWN)) err(`${m.format({ color: colours.err })}\n`);
  if (mistakes.length > SHOWN) err(`and ${mistakes.length - SHOWN} more`);
  err(errRed(`${mistakes.length} error${mistakes.length === 1 ? "" : "s"}`));
}

// ----- answers (§17.12)

// One line from stdin, or null at its end: read as it comes, so a terminal's answers are read as they are typed. The
// bytes are decoded as a stream, so a character split between two reads arrives whole.
let pending = "";
const decoder = new StringDecoder("utf8");
function readLine() {
  const buf = Buffer.alloc(4096);
  for (;;) {
    const nl = pending.indexOf("\n");
    if (nl >= 0) {
      const line = pending.slice(0, nl).replace(/\r$/, "");
      pending = pending.slice(nl + 1);
      return line;
    }
    const n = readSome(buf);
    if (n === 0) {
      pending += decoder.end();
      if (!pending) return null;
      const line = pending;
      pending = "";
      return line;
    }
    pending += decoder.write(buf.subarray(0, n));
  }
}
function readSome(buf) {
  for (;;) {
    try {
      return readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (e.code === "EAGAIN") continue;
      if (e.code === "EOF") return 0;
      throw e;
    }
  }
}
// All of stdin, as bytes: a program read from it is checked as UTF-8 by the compiler, as a file's is (§1.1).
function readAllBytes() {
  const chunks = [Buffer.from(pending, "utf8")];
  pending = "";
  const buf = Buffer.alloc(65536);
  for (let n; (n = readSome(buf)) > 0; ) chunks.push(Buffer.from(buf.subarray(0, n)));
  return Buffer.concat(chunks);
}
// Bytes as UTF-8 text, or null when they are not.
const utf8 = (bytes) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

// key=value (§17.12): the key is a question's key as §8.6 writes it, so the `=` that ends it is the first one outside
// quoted words and outside brackets (`person(n=1).age=37` gives person(n=1).age). A word is key=value when it starts
// with a letter or _ and holds such an `=`; any other word is an answers file (a file whose name would read as
// key=value is given as ./name). Gives [key, value] or null.
function assignment(word) {
  if (!/^[A-Za-z_]/.test(word)) return null;
  let depth = 0;
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (c === '"') {
      for (i++; i < word.length && word[i] !== '"'; i++) if (word[i] === "\\") i++;
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "=" && depth === 0) return [word.slice(0, i), word.slice(i + 1)];
  }
  return null;
}

// The answers a run is given: a JSON file, or `-` for JSON on stdin; then key=value words, each overriding.
// Gives { answers, given, error }; `given` is whether any source of answers was named.
function answersFrom(words, { stdinTaken }) {
  let answers = {};
  let given = false;
  const pairs = [];
  for (const w of words) {
    const kv = assignment(w);
    if (kv) {
      pairs.push(kv);
      continue;
    }
    if (given) return { error: `one answers file only, and ${w} is a second`, usage: true };
    given = true;
    let text;
    if (w === "-") {
      if (stdinTaken) return { error: "stdin holds the program: its answers come from a file or as key=value", usage: true };
      text = utf8(readAllBytes());
      if (text === null) return { error: "stdin: the answers are not UTF-8" };
    } else {
      const r = readable(w);
      if (r.error) return r;
      text = utf8(readFileSync(w));
      if (text === null) return { error: `${w}: the answers are not UTF-8` };
    }
    try {
      answers = parseDigits(text);
    } catch (e) {
      return { error: `${w === "-" ? "stdin" : w}: not JSON: ${e.message}` };
    }
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) return { error: `${w === "-" ? "stdin" : w}: the answers are a JSON object of question keys` };
  }
  for (const [k, v] of pairs) answers[k] = v;
  return { answers, given: given || pairs.length > 0, pairs: new Set(pairs.map(([k]) => k)) };
}

// The keys of answers given that no question of the program has (§17.12): not asked in the run, and not the key of
// any of its questions, whatever the turns of loops ([n]), the call (#2) and the function it is asked in.
function unknownKeys(p, keys, steps) {
  const asked = new Set(steps.map((s) => s.key));
  const bare = (k) => k.replace(/\[[^\]]*\]/g, "").replace(/#(\d+|any|another)(?=\.|$)/g, "");
  const names = (p.questions ?? []).map((q) => bare(q.name));
  const last = (k) => k.split(".").pop();
  return keys.filter((k) => {
    if (asked.has(k)) return false;
    const b = bare(k);
    return !names.some((n) => b === n || b.endsWith(`.${n}`) || last(b) === last(n));
  });
}

// One answer given as words (key=value, or typed at a prompt) to an options question (§17.12): words that are one of
// its values are that value; at a prompt, else a number is the option of that number. An any_of answer is one value,
// or values separated by commas; an option whose value holds a comma, alongside others, is given in JSON.
function optionWords(question, words, numbered) {
  const options = question.options ?? [];
  const one = (w) => (options.some((o) => o.value === w) ? w : numbered && /^\d+$/.test(w) && options[Number(w) - 1] ? options[Number(w) - 1].value : w);
  if (question.type === "one_of") return one(words);
  if (words === "") return [];
  if (options.some((o) => o.value === words)) return [words];
  return words.split(",").map(one);
}

// key=value answers to any_of questions are made lists as the run reaches them (§17.12).
function asOptions(p, answers, keys, runOnce) {
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of runOnce(answers).steps) {
      if (s.question.type === "any_of" && keys.has(s.key) && typeof answers[s.key] === "string") {
        answers[s.key] = optionWords(s.question, answers[s.key], false);
        changed = true;
      }
    }
  }
}

// The questions a run reaches without an answer, asked one at a time on stderr and answered on stdin (§17.12):
// each run again from the start with the answers so far, as the page does, so a question is asked even when the run
// would stop at a fault after it. What is typed is the answer as typed (§8.7), but for these: an empty line leaves
// the question unanswered; y and n are yes and no; an option may be given by its number. The end of stdin leaves the
// rest unanswered.
function prompt(answers, runOnce) {
  const asked = new Set();
  for (;;) {
    const r = runOnce(answers);
    const s = r.steps.find((x) => !(x.key in answers) && !asked.has(x.key));
    if (!s) return;
    asked.add(s.key);
    const q = s.question;
    const options = q.options ?? [];
    const hint = { bool: "yes or no", date: "YYYY-MM-DD", number: "a number", one_of: "a number or the value", any_of: "numbers or values, with commas" }[q.type] ?? "words";
    // A person is shown yes and no for a bool, as they type them.
    const offered = typeof s.default === "boolean" ? (s.default ? "yes" : "no") : stringOf(s.default);
    err(`${s.printed || s.key}${s.default !== undefined && s.default !== null ? ` [${offered}]` : ""}`);
    options.forEach((o, i) => err(`  ${i + 1}. ${o.printed} (${o.value})`));
    process.stderr.write(`  ${hint}> `);
    const line = readLine();
    // An answer from a terminal was echoed as it was typed; one from a pipe is shown, so the questions read in turn.
    if (!process.stdin.isTTY) err(line ?? "");
    if (line === null) return;
    if (line === "") continue;
    if (q.type === "one_of" || q.type === "any_of") answers[s.key] = optionWords(q, line, true);
    else if (q.type === "bool") answers[s.key] = /^[yY]$/.test(line) ? "yes" : /^[nN]$/.test(line) ? "no" : line;
    else answers[s.key] = line;
  }
}

// ----- the command line

async function main(argv) {
  let [command, ...rest] = argv;
  // `stride --help`, `-h`, `--version` (§17.10).
  if (command === "--help" || command === "-h") command = "help";
  if (command === "--version") command = "version";
  if (command === undefined) return err(USAGE), 2;
  if (!COMMANDS[command]) return usage(null, `no command ${command}`);
  // --help anywhere before -- is the command's help (§17.10).
  const end = rest.indexOf("--");
  if ((end < 0 ? rest : rest.slice(0, end)).some((a) => a === "--help" || a === "-h")) return out(helpOf(command)), 0;
  const parsed = parseArgs(command, rest);
  if (parsed.mistake) return usage(command, parsed.mistake);
  const { flags, values, args } = parsed;
  quiet = flags.has("--quiet");
  const when = values.get("--color") ?? "auto";
  if (!["auto", "always", "never"].includes(when)) return usage(command, `--color takes auto, always or never, and was given ${when}`);
  const tty = (s) => !!s.isTTY && !process.env.NO_COLOR;
  colours = { out: when === "always" || (when === "auto" && tty(process.stdout)), err: when === "always" || (when === "auto" && tty(process.stderr)) };
  const json = flags.has("--json");
  jsonOut = json;
  // --today is a real day, YYYY-MM-DD from 0001 to 9999, checked before anything runs; never replaced by today's.
  if (values.has("--today")) {
    const why = todayMistake(values.get("--today"));
    if (why) return usage(command, `--today ${why}`);
  }
  const today = values.get("--today") ?? null;
  const [least, most] = ARGS[command];
  if (args.length < least || args.length > most) return usage(command, `takes ${least === most ? least : most === Infinity ? `${least} or more` : `${least} to ${most}`} argument${most === 1 ? "" : "s"}, and was given ${args.length}`);
  const fileError = (r) => (r.usage ? usage(command, r.error) : fail(r.error));

  switch (command) {
    case "version":
      out(`stride ${LANGUAGE} (build ${BUILD}): the language ${LANGUAGE} (§21), bytecode version ${VERSION}, on Node ${process.versions.node}, ${process.platform}-${process.arch}`);
      return 0;
    case "help":
      if (!args.length) return out(USAGE), 0;
      if (!COMMANDS[args[0]]) return usage("help", `no command ${args[0]}`);
      return out(helpOf(args[0])), 0;

    case "guide": {
      const { guide } = await import("../src/guide.mjs");
      const text = guide(args[0] ?? null);
      if (text === null) return usage("guide", `no part of the guide is about "${args[0]}"; stride guide topics lists them`);
      out(text);
      return 0;
    }

    case "header": {
      // The form's header from its PDF (§17.6), beside the PDF or at -o; the form's id is the header's name.
      const pdfPath = args[0];
      const r = readable(pdfPath);
      if (r.error) return fileError(r);
      const to = values.get("--output") ?? `${pdfPath.replace(/\.pdf$/i, "")}.boxes.json`;
      if (!to.endsWith(".boxes.json")) return usage("header", `the header's file ends in .boxes.json, and ${to} does not`);
      const { headerOf, writeHeader } = await import("../src/project.mjs");
      const header = await headerOf(readFileSync(pdfPath), basename(to).replace(/\.boxes\.json$/, ""));
      if (header.error) return fail(`${pdfPath}: ${header.error}`);
      const w = writing(to, () => writeHeader(to, header));
      if (w) return fail(w);
      status(`${to}: ${plural(header.boxes.length, "box", "boxes")} in the form ${pdfPath}, pdf ${header.pdf}`);
      return 0;
    }
    case "new": {
      // A program to start from (§17.6): with --pdf, against that form; else a script.
      const { newProgram } = await import("../src/project.mjs");
      const made = await newProgram(args[0], values.get("--pdf") ?? null);
      if (made.error) return made.usage ? usage("new", made.error) : fail(made.error);
      const name = made.made[0];
      const sbc = name.replace(/\.stride$/, ".sbc");
      status(`made ${made.made.join(", ")}\n\n  stride run ${name}${made.script ? "            what it prints" : `            the workflow in your browser, beside the PDF; save and reload to see a change`}\n  stride test ${name}           its tests, in ${made.made[1].replace(/\/[^/]*$/, "/")}${made.script ? "" : `\n  stride compile ${name}        ${sbc}, to share with its PDF: stride run ${sbc}`}`);
      return 0;
    }
    case "init": {
      const { initProject } = await import("../src/project.mjs");
      const made = initProject(args[0] ?? ".");
      if (made.error) return made.usage ? usage("init", made.error) : fail(made.error);
      status(`made ${made.made.join(", ")}: a project needing Stride ${made.needs}; its programs share the libraries in ${made.lib}`);
      return 0;
    }
    case "lsp": {
      // The language server, for editors, on stdin and stdout (§17.6).
      const { serve } = await import("../src/lsp.mjs");
      return serve();
    }
    case "dap": {
      const { serveDap } = await import("../src/debug.mjs");
      return serveDap();
    }
    case "vscode": {
      const { vsix } = await import("../src/vsix.mjs");
      const to = values.get("--output") ?? `stride-${LANGUAGE}.vsix`;
      const w = writing(to, () => writeFileSync(to, vsix()));
      if (w) return fail(w);
      status(`${to}: the VS Code extension; install it with: code --install-extension ${to}`);
      return 0;
    }
    case "map": {
      // The program against its form (form.mjs): each question and the boxes its answer
      // goes into, the boxes written from no answer, the boxes not written. It reads the source.
      if (args[0].endsWith(".sbc")) return usage("map", `${args[0]} is compiled: map reads the program's .stride source`);
      const warnings = json ? [] : null;
      const r = program(args[0], { warnings });
      if (r.error) return fileError(r);
      if (r.mistakes) return json ? (out(JSON.stringify({ ok: false, diagnostics: [...warnings, ...r.mistakes].map((d) => d.toJSON()), questions: [], writtenFromNoAnswer: [], writtenByNameWorkedOut: [], notWritten: [] })), 1) : (report(r.mistakes), 1);
      if (r.out.program?.script) return fail(`${args[0]} is a script: it writes no boxes (§4.6)`);
      const short = (b) => b.slice(r.p.prefix.length);
      const byKey = new Map();
      for (const l of r.out.links) byKey.set(l.key, [...(byKey.get(l.key) ?? []), l]);
      const linked = new Set(r.out.links.map((l) => l.box));
      const written = [...r.out.written].filter((b) => !linked.has(b));
      // A box a name worked out as the program runs may write is not said to be left unwritten.
      const byName = [...new Set(r.out.header.boxes.map((b) => b.field))].filter((b) => !r.out.written.has(b) && r.out.byName?.has(b));
      const skipped = [...new Set(r.out.header.boxes.map((b) => b.field))].filter((b) => !r.out.written.has(b) && !r.out.byName?.has(b));
      if (json) {
        out(JSON.stringify({ ok: true, diagnostics: warnings.map((d) => d.toJSON()), questions: [...r.out.keys].map(([key, { printed }]) => ({ key, printed, boxes: (byKey.get(key) ?? []).map((l) => ({ box: short(l.box), direct: l.direct })), intoBoxNamedAtRun: !!r.out.intoNamed?.has(key) })), writtenFromNoAnswer: written.map(short), writtenByNameWorkedOut: byName.map(short), notWritten: skipped.map(short) }));
        return 0;
      }
      out(bold("question → the boxes its answer goes into (= as given)"));
      for (const [key, { printed }] of r.out.keys) {
        const into = byKey.get(key) ?? [];
        out(`  ${key.padEnd(36)} ${[...into.map((l) => `${l.direct ? "= " : ""}${short(l.box)}`), ...(r.out.intoNamed?.has(key) ? ["(a box named as the program runs)"] : [])].join(", ") || "(no box: it decides what is asked)"}${printed ? `   "${printed.slice(0, 50)}"` : ""}`);
      }
      if (written.length) out(`${bold("\nwritten from no answer")}\n  ${written.map(short).join("\n  ")}`);
      if (byName.length) out(`${bold("\nwritten by a name worked out as the program runs")}\n  ${byName.map(short).join("\n  ")}`);
      if (skipped.length) out(`${bold("\nnot written")}\n  ${skipped.map(short).join("\n  ")}`);
      return 0;
    }
    case "doc": {
      // The standard library (§14): signatures, what each gives, examples the suite runs (lib/std.stride).
      const found = findInLibrary(args[0] ?? "");
      if (!found.length) return usage("doc", `no function of the standard library is named or described by "${args[0]}"`);
      for (const e of found) {
        out(`${bold(e.signatures.join(", "))}    ${e.section}`);
        out(`  ${e.gives}`);
        for (const x of e.examples) out(`  example: ${x.text}`);
        out("");
      }
      if (found.some((e) => e.examples.some((x) => /\b(warm|cool|people|colour|person)\b/.test(x.expr)))) out(`The examples use:\n${exampleSetup().replace(/^/gm, "  ")}\nand today() is ${EXAMPLE_TODAY}.`);
      return 0;
    }
    case "explain": {
      // What a code means, as the spec says it (§16.4, §13.4).
      const code = args[0].toUpperCase();
      const c = CODES[code];
      if (!c) return usage("explain", `${code} is not a Stride code; codes are S001…, W001…, F001…`);
      out(`${bold(code)}: ${c.when}`);
      if (c.explanation) out(`\n${c.explanation}`);
      return 0;
    }

    case "compile": {
      const file = args[0];
      // Only source compiles; bytecode is compiled already (§17.18).
      if (file.endsWith(".sbc")) return usage("compile", `${file} is compiled already: compile takes the program's .stride source`);
      const warnings = json ? [] : null;
      const r = program(file, { warnings });
      if (r.error) return fileError(r);
      const diagnostics = () => [...(warnings ?? []), ...(r.mistakes ?? [])].map((d) => d.toJSON());
      if (r.mistakes) return json ? (out(JSON.stringify({ ok: false, diagnostics: diagnostics(), output: null, bytes: 0, questions: 0, boxes: 0 })), 1) : (report(r.mistakes), 1);
      const to = values.get("--output") ?? file.replace(/\.stride$/, ".sbc");
      const w = writing(to, () => writeFileSync(to, r.out.bytecode));
      if (w) return fail(w);
      if (json) out(JSON.stringify({ ok: true, diagnostics: diagnostics(), output: to, bytes: r.out.bytecode.length, questions: r.p.questions.length, boxes: r.p.boxes.length }));
      else status(`${file} → ${to}: ${plural(r.p.questions.length, "question")}, ${plural(r.p.boxes.length, "box", "boxes")}, ${plural(r.p.functions.length, "function")}, ${plural(r.out.bytecode.length, "byte")}`);
      return 0;
    }
    case "check": {
      // Each file named, and every program, script and test file in each folder named; none: this folder (§17.13).
      const { discover } = await import("../src/project.mjs");
      const found = discover(args.length ? args : ["."], "check");
      if (found.error) return fileError(found);
      if (!found.files.length) return usage("check", `${args.join(" ") || "this folder"}: no Stride programs to check`);
      const files = [];
      let bad = 0;
      for (const file of found.files) {
        const warnings = json ? [] : null;
        const r = program(file, { warnings });
        const diagnostics = [...(warnings ?? []), ...(r.mistakes ?? [])];
        const ok = !r.mistakes && !r.error;
        if (!ok) bad++;
        if (json) files.push({ file, ok, error: r.error ?? null, diagnostics: diagnostics.map((d) => d.toJSON()) });
        else if (r.error) err(r.error);
        else if (r.mistakes) report(r.mistakes);
        else {
          status(`${errGreen(`${file}: no errors`)}${r.p ? ` (${plural(r.p.questions.length, "question")}, ${plural(r.p.boxes.length, "box", "boxes")} in the form)` : ""}`);
        }
      }
      if (json) out(JSON.stringify({ ok: bad === 0, files }));
      else if (found.files.length > 1) status(bad ? errRed(`${bad} of ${found.files.length} files have errors`) : errGreen(`${plural(found.files.length, "file")}, no mistakes`));
      return bad ? 1 : 0;
    }

    case "run":
    case "debug": {
      // The program: a file, or with `-` a script read from stdin (§17.12).
      const file = args[0];
      const fromStdin = file === "-" && command === "run";
      const warnings = json ? [] : null;
      const stdinSource = fromStdin ? readAllBytes() : null;
      const r = fromStdin ? program("stdin.stride", { warnings, source: stdinSource }) : program(file, { warnings });
      if (r.error) return fileError(r);
      // Where it runs (§17.18): a program in the browser, unless --terminal; a script in the terminal. An option of
      // the other place is a usage mistake.
      if (command === "run") {
        const form = r.p ? !!r.p.form : !!r.out?.header;
        const browser = form && !flags.has("--terminal");
        if (browser) {
          const terminalOnly = [...(args.length > 1 ? [`answers (${args[1]})`] : []), ...["--prompt", "--no-prompt", "--json", "--trace"].filter((o) => flags.has(o))];
          if (terminalOnly.length) return usage("run", `${terminalOnly[0]} ${terminalOnly[0].startsWith("answers") ? "are" : "is"} for a run in the terminal; ${file} runs in the browser, where the answers are given in the page: add --terminal`);
        } else {
          const there = ["--pdf", "--port"].find((o) => values.has(o));
          if (there) return usage("run", form ? `${there} is for a run in the browser, and --terminal runs ${file} in the terminal` : `${there} is for a program's run in the browser; ${fromStdin ? "a program read from stdin" : file} is a script, which runs in the terminal`);
        }
        if (browser) {
          if (r.mistakes) return report(r.mistakes), 1;
          const port = values.has("--port") ? Number(values.get("--port")) : 8080;
          if (!Number.isInteger(port) || port < 0 || port > 65535) return usage("run", `--port takes a port, 1 to 65535, or 0 for any free one, and was given ${values.get("--port")}`);
          const { serve } = await import("../src/serve.mjs");
          const served = await serve(file, { pdfPath: values.get("--pdf") ?? null, port, today });
          if (served.error) return served.usage ? usage("run", served.error) : fail(served.error);
          out(served.url);
          status(`${file}: the workflow is at ${served.url} (only this computer can reach it)${file.endsWith(".stride") ? "; save the source and reload to see a change" : ""}; stop with Ctrl-C`);
          openBrowser(served.url);
          return new Promise(() => {});
        }
      }
      if (r.mistakes) return json ? (out(JSON.stringify({ ok: false, diagnostics: [...warnings, ...r.mistakes].map((d) => d.toJSON()), questions: [], prints: [], boxes: {}, fault: null })), 1) : (report(r.mistakes), 1);
      const given = answersFrom(args.slice(1), { stdinTaken: fromStdin });
      if (given.error) return given.usage ? usage(command, given.error) : fail(given.error);
      const answers = given.answers;
      if (flags.has("--prompt") && flags.has("--no-prompt")) return usage(command, "--prompt and --no-prompt are opposites");
      if (command === "debug") {
        if (!file.endsWith(".stride")) return usage("debug", "the debugger follows the source: give the .stride file");
        // Answers first, at a terminal without any given; then the debugger's commands, on the same stdin.
        asOptions(r.p, answers, given.pairs ?? new Set(), (a) => run(r.p, a, { today }));
        if (!given.given && process.stdin.isTTY) prompt(answers, (a) => run(r.p, a, { today }));
        const { debugTerminal } = await import("../src/debug.mjs");
        return debugTerminal(file, answers, { today });
      }
      const runOnce = (a) => run(r.p, a, { today });
      asOptions(r.p, answers, given.pairs ?? new Set(), runOnce);
      // At a terminal with no answers given, or with --prompt, the questions are asked as the run reaches them.
      if (flags.has("--prompt") || (!flags.has("--no-prompt") && !given.given && !fromStdin && process.stdin.isTTY && !json)) {
        const typed = new Set();
        prompt(answers, (a) => {
          for (const k of Object.keys(a)) typed.add(k);
          return runOnce(a);
        });
      }
      // --trace on a source file follows the program as written, line by line (§17.7), on stderr; on
      // bytecode, the machine's instructions.
      let result;
      if (flags.has("--trace") && !file.endsWith(".sbc")) {
        const plain = fromStdin ? { ...compile(stdinSource, "stdin.stride", { trace: true }) } : compileFile(file, { trace: true, ...(r.out.header ? {} : { header: { form: null, pdf: "0".repeat(64), boxes: [] } }) });
        const watch = sourceTrace();
        const traced = load(plain.bytecode);
        result = run(traced, answers, { today, watch, debug: plain.debug });
        watch.flush();
        result.writes = boxValues(traced, result.writes);
        result.named = true;
      } else {
        const trace = flags.has("--trace") ? traceTo(r.p) : undefined;
        result = run(r.p, answers, { trace, today });
        trace?.flush();
      }
      const script = !r.p.form;
      // An answer under a key no question of the program has is said (W011), and the run goes on without it.
      const unknown = unknownKeys(r.p, Object.keys(given.answers ?? {}), result.steps);
      const from = args.slice(1).find((w) => !assignment(w)) ?? "the answers";
      const unknownWarnings = unknown.map((k) => ({ severity: "warning", code: "W011", message: `no question has the key "${k}"; its answer is not used`, file: given.pairs?.has(k) ? `${k}=…` : from === "-" ? "stdin" : from, line: 0, column: 0, endLine: 0, endColumn: 0 }));
      if (!json && !quiet) for (const w of unknownWarnings) err(`${w.file}: warning W011: ${w.message}\n`);
      const written = Object.entries(result.named ? result.writes : boxValues(r.p, result.writes)).filter(([, v]) => v !== "" && v !== "Off");
      if (json) {
        const value = (v) => (v === null || v === undefined ? null : Array.isArray(v) ? v.map(value) : typeof v === "boolean" ? v : stringOf(v));
        out(JSON.stringify({ ok: !result.fault, diagnostics: [...warnings.map((d) => d.toJSON()), ...unknownWarnings], questions: result.steps.map((s) => ({ key: s.key, type: s.question.type, printed: s.printed, answered: s.answered, value: value(s.value), default: s.default === undefined ? null : value(s.default), unreadable: s.unreadable ?? null, failed: s.failed })), prints: result.prints, boxes: Object.fromEntries(written.map(([k, v]) => [k.slice(r.p.prefix.length), v])), fault: faultJSON(result.fault) }));
        return result.fault ? 1 : 0;
      }
      // A script gives its print lines as they are; a program also the questions it asked and the boxes it wrote.
      if (!script) {
        out(bold(`${plural(result.steps.length, "question")} asked:`));
        for (const s of result.steps) {
          const shown = s.answered ? JSON.stringify(s.value) : s.default !== undefined ? `${JSON.stringify(s.default)} (default)` : "—";
          const marks = [...(s.unreadable ? [`unreadable: ${s.unreadable}`] : []), ...s.failed.map((m) => `check: ${m}`)];
          out(`  ${s.key.padEnd(40)} ${s.question.type.padEnd(10)} ${shown}${marks.length ? red(`  ${marks.join("; ")}`) : ""}`);
        }
      } else {
        // A script's answers that could not be read, and checks that failed, are about the run: said on stderr.
        for (const s of result.steps) for (const m of [...(s.unreadable ? [`${s.key}: unreadable: ${s.unreadable}`] : []), ...s.failed.map((x) => `${s.key}: ${x}`)]) err(errRed(m));
      }
      for (const w of result.prints) out(script ? w : `  print: ${w}`);
      if (!script) {
        out(bold(`${plural(written.length, "box", "boxes")} written:`));
        for (const [name, v] of written) out(`  ${name.slice(r.p.prefix.length).padEnd(64)} ${JSON.stringify(v)}`);
      }
      if (result.fault) return (process.exitCode = 1), err(errRed(faultWords(result.fault))), 1;
      return 0;
    }

    case "repl": {
      const { repl } = await import("../src/repl.mjs");
      let context;
      try {
        context = here();
      } catch (e) {
        if (e.projectProblem) return fail(e.message);
        throw e;
      }
      return repl({ use: values.get("--import") ?? null, today, readLine, out, err, prompt, context });
    }

    case "eval": {
      // One expression's value: a program that prints it, run with no answers (§17.2).
      // The expression is parsed alone (§17.2): what follows a complete expression (`1 2`, `1)`, `x: 1`) is a
      // usage mistake; a mistake inside it is its own, at its place from line 1, column 1.
      const own = new SourceFile("eval", args[0]);
      const alone = parseExpression(own.text, -1);
      // Nothing to evaluate: empty, or only whitespace and comments, is a usage mistake (§17.2).
      if (alone.empty) return usage("eval", "takes one expression, and was given none");
      if (alone.rest) return usage("eval", `takes one expression; this is not one: ${args[0]}`);
      const done = (ok, extra) => (json ? out(JSON.stringify({ ok, value: null, diagnostics: [], fault: null, ...extra })) : null);
      if (alone.mistakes.length) {
        const d = new Diagnostics();
        for (const m of alone.mistakes) d.add(KIND.SYNTAX, own, m.span, m.message, [], m.code ?? "S010");
        return json ? (done(false, { diagnostics: d.sorted().map((x) => x.toJSON()) }), 1) : (report(d.sorted()), 1);
      }
      const uses = values.has("--import") ? `import "${values.get("--import")}"\n` : "";
      const pdf = "0".repeat(64);
      let context;
      try {
        context = here();
      } catch (e) {
        if (e.projectProblem) return fail(e.message);
        throw e;
      }
      const compiled = compile(`form eval\npdf ${pdf}\n${uses}print(\n${own.text}\n)\n`, "eval.stride", { ...context, header: { form: "eval", pdf, boxes: [] }, depth: -1 });
      // Places in the expression are its own, from line 1, column 1 (§17.2); a library's keep their file. A mistake
      // in the --import line is a usage mistake; one in the lines put around the expression has no place of its own.
      const before = uses ? 4 : 3; // the lines put before the expression
      const mistakes = compiled.diagnostics.sorted().filter((d) => d.severity === "error");
      const bad = mistakes.find((d) => d.file?.name === "eval.stride" && uses && d.span?.line === 3);
      if (bad) return usage("eval", `--import ${values.get("--import")}: ${bad.message}`);
      const inside = (line) => line > before && line <= before + own.lineCount;
      const moved = (file, span) => {
        if (file?.name !== "eval.stride" || !span) return [file, span];
        if (!inside(span.line)) return [own, null];
        const endLine = Math.min(span.endLine ?? span.line, before + own.lineCount);
        return [own, { ...span, line: span.line - before, endLine: endLine - before, endCol: endLine === (span.endLine ?? span.line) ? span.endCol : [...own.line(endLine - before)].length + 1 }];
      };
      for (const d of mistakes) {
        // The expression is not an argument of the print around it: a call there that gives no value is the
        // expression's own mistake, S370 (§9.6, §17.2).
        if (d.code === "S366" && d.file?.name === "eval.stride" && d.span?.line === before + 1 && d.span.col === 1 && (d.span.endLine ?? d.span.line) === before + own.lineCount) {
          d.code = "S370";
          d.message = d.message.replace(/ gives no value$/, " gives no value; stride eval shows the value of an expression");
          d.label = null;
        }
        [d.file, d.span] = moved(d.file, d.span);
        d.notes = d.notes.map((n) => {
          const [file, span] = moved(n.file, n.span);
          return { ...n, file, span };
        });
      }
      const at = (line) => (inside(line) ? line - before : null);
      if (mistakes.length) return json ? (done(false, { diagnostics: mistakes.map((x) => x.toJSON()) }), 1) : (report(mistakes), 1);
      const result = run(load(compiled.bytecode), {}, { today });
      if (result.fault) {
        const place = (x) => (x.file === "eval.stride" ? { ...x, file: "eval", line: at(x.line) } : x);
        const f = { ...place(result.fault), stack: (result.fault.stack ?? []).map(place) };
        return json ? (done(false, { fault: faultJSON(f) }), 1) : ((process.exitCode = 1), err(errRed(faultWords(f))), 1);
      }
      if (json) done(true, { value: result.prints[0] });
      else out(result.prints[0]);
      return 0;
    }

    case "test": {
      // One program and the names of its tests (§17.4); else files and folders, every test in them (§17.13).
      const { discover } = await import("../src/project.mjs");
      const one = args.length >= 1 && (args[0].endsWith(".sbc") || (args[0].endsWith(".stride") && !args[0].endsWith(".test.stride"))) && args.slice(1).every((a) => !existsSync(a));
      const names = one ? args.slice(1) : [];
      if (!one && args[0]?.endsWith(".test.stride") && args.length > 1 && args.slice(1).every((a) => !existsSync(a))) return usage("test", `${args[0]} is a test file; its expectations have no names, and ${args.slice(1).join(" ")} was given`);
      const found = one ? { files: [args[0]] } : discover(args.length ? args : ["."], "test");
      if (found.error) return fileError(found);
      if (!found.files.length) return usage("test", `${args.join(" ") || "this folder"}: no programs with tests and no test files`);
      const match = values.get("--match") ?? null;
      const report2 = [];
      let failedFiles = 0, total = 0, failed = 0;
      for (const file of found.files) {
        const warnings = json ? [] : null;
        const r = program(file, { warnings });
        const entry = { file, ok: true, error: null, diagnostics: [], tests: [] };
        report2.push(entry);
        if (r.error || r.mistakes) {
          entry.ok = false;
          entry.error = r.error ?? null;
          entry.diagnostics = [...(warnings ?? []), ...(r.mistakes ?? [])].map((d) => d.toJSON());
          failedFiles++;
          if (!json) r.error ? err(r.error) : report(r.mistakes);
          if (r.usage && found.files.length === 1) return usage("test", r.error);
          continue;
        }
        if (found.files.length > 1 && !json) out(bold(file));
        // A compiled program, shared without its source: its tests run in the machine (§17.17).
        if (!r.out) r.out = { program: { test: false }, ir: null };
        // A test file: each expect a sub-run, reported in order.
        if (r.out.program.test) {
          const vm = run(r.p, {}, { today });
          const results = expectResults(r.out.program, vm.results ?? []);
          results.forEach((x, i) => {
            const name = `${i + 1}${x.line ? ` (line ${x.line})` : ""}`;
            if (match && !name.includes(match)) return;
            total++;
            const ok = x.result === "pass";
            if (!ok) failed++;
            entry.tests.push({ name, ok, problems: ok ? [] : [x.why ?? x.result] });
            if (!json) out(`${ok ? green("ok") : red(x.result === "fail" ? "FAIL" : "not run")}   ${name}${x.why ? `: ${x.why}` : ""}`);
          });
          if (vm.fault) (entry.ok = false), json ? entry.tests.push({ name: "the file", ok: false, problems: [faultWords(vm.fault)] }) : err(errRed(faultWords(vm.fault)));
          if (entry.tests.some((t) => !t.ok)) entry.ok = false;
          continue;
        }
        const { dir, results, usage: bad } = runTests(r.p, file, names, { today });
        if (bad) return usage("test", bad.join("\n"));
        if (!results.length && one) return fail(`${file}: no tests in ${dir}`);
        for (const t of results) {
          if (match && !t.name.includes(match)) continue;
          total++;
          const ok = !t.problems.length;
          if (!ok) failed++;
          entry.tests.push({ name: t.name, ok, problems: t.problems });
          if (json) continue;
          if (!ok) {
            out(`${red("FAIL")} ${t.name}`);
            for (const p of t.problems) out(`     ${p}`);
          } else out(`${green("ok")}   ${t.name} (${plural(t.steps.length, "question")} asked, ${plural(Object.values(t.values).filter((v) => v !== "" && v !== "Off").length, "box", "boxes")} written)`);
        }
        if (entry.tests.some((t) => !t.ok)) entry.ok = false;
      }
      const ok = failed === 0 && failedFiles === 0 && report2.every((e) => e.ok);
      if (json) out(JSON.stringify({ ok, files: report2 }));
      else {
        const files = found.files.length > 1 ? ` in ${plural(found.files.length, "file")}` : "";
        const one1 = found.files.length === 1 && report2[0]?.tests.length && found.files[0].endsWith(".test.stride");
        const word = one1 ? "expectation" : "test";
        out(failed || failedFiles ? red(`${failed} of ${plural(total, word)} failed${failedFiles ? `, ${plural(failedFiles, "file")} did not compile` : ""}${files}`) : green(`${plural(total, word)} passed${files}`));
      }
      return ok ? 0 : 1;
    }
    case "asm": {
      const file = args[0];
      if (flags.has("--ir")) {
        if (!file.endsWith(".stride")) return usage("asm", "--ir needs the source, a .stride file");
        const r = program(file, { needBytecode: false });
        if (r.error) return fileError(r);
        if (r.mistakes) return report(r.mistakes), 1;
        out(r.out.program.functions.map(showFunction).join("\n\n"));
        return 0;
      }
      const r = program(file);
      if (r.error) return fileError(r);
      if (r.mistakes) return report(r.mistakes), 1;
      out(disassemble(r.p));
      return 0;
    }
    case "fmt": {
      // Each file named, and every .stride file in each folder named (§17.3, §17.13).
      const { discover } = await import("../src/project.mjs");
      const found = discover(args, "fmt");
      if (found.error) return fileError(found);
      let changed = 0, bad = 0;
      for (const file of found.files) {
        const text = readFileSync(file, "utf8");
        const formatted = format(text, basename(file));
        if (!formatted.text) {
          report(formatted.diagnostics.sorted());
          bad++;
          continue;
        }
        if (formatted.text === text) continue;
        changed++;
        if (flags.has("--check")) out(file);
        else {
          const w = writing(file, () => writeFileSync(file, formatted.text));
          if (w) return fail(w);
          status(`${file}: formatted`);
        }
      }
      if (flags.has("--check") && changed) status(`${plural(changed, "file")} not in Stride's layout`);
      return bad || (flags.has("--check") && changed) ? 1 : 0;
    }
    default:
      return usage(null, `no command ${command}`);
  }
}

// A file written, or why it could not be: said plainly, never as an error of stride's own (§17.11).
function writing(path, write) {
  try {
    write();
    return null;
  } catch (e) {
    return `${path}: cannot be written (${{ ENOENT: "its folder is not there", EACCES: "permission denied", EISDIR: "a folder is there" }[e.code] ?? e.code ?? e.message})`;
  }
}

// What a trace shows for a record that holds itself (§3.4.6).
const ITSELF = "(holds itself)";

// Each instruction the machine runs, with its function, address, name, the top of the stack, and the locals it
// changes, by name (§17). The trace is called before each instruction runs, so a line is printed when the next
// one starts, once what it changed is known.
function traceTo(p) {
  const shown = (v) => (holdsItself(v) ? ITSELF : typeof v === "string" ? JSON.stringify(v.length > 20 ? `${v.slice(0, 20)}…` : v) : Array.isArray(v) ? `[${v.length}]` : v?.pairs ? `{${v.pairs.map(([k, x]) => `${shown(k)}: ${shown(x)}`).join(", ")}}` : v === null || v === undefined ? "null" : stringOf(v));
  const snap = (v) => (holdsItself(v) ? ITSELF : JSON.stringify(v ?? null));
  let pending = null;
  const flush = () => {
    if (!pending) return;
    const changed = pending.locals.flatMap((v, i) => (snap(v) === pending.before[i] ? [] : [`${pending.fn.localNames[i] ?? `#${i}`} = ${shown(v)}`]));
    err(`  ${pending.line}${changed.length ? `  ${changed.join(", ")}` : ""}`);
    pending = null;
  };
  const trace = ({ fn, at, op, stack, locals }) => {
    flush();
    const top = stack.slice(-3).map(shown);
    pending = { fn, locals, before: locals.map(snap), line: `${fn.name.padEnd(24).slice(0, 24)} ${String(at).padStart(5)}  ${(OP_NAME[op] ?? "?").padEnd(18)} ${top.join("  ")}` };
  };
  trace.flush = flush;
  return trace;
}

// The program as written, as it runs (§17.7): each statement's line and text when it starts, indented by how deep
// the calls go, and under it the names it gave a value; each turn of a loop with its counter or item; each call of
// a function with its arguments and what it gives back; each call of the library with what it gives. A loop's own
// bookkeeping (its counter going up, its item taken) is not a statement of the program and is not shown as one.
function sourceTrace() {
  const shown = (v) => (holdsItself(v) ? ITSELF : typeof v === "string" ? JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v) : Array.isArray(v) ? `[${v.map(shown).join(", ")}]` : v === true ? "true" : v === false ? "false" : v?.pairs ? `{${v.pairs.map(([k, x]) => `${shown(k)}: ${shown(x)}`).join(", ")}}` : v === null || v === undefined ? "null" : stringOf(v));
  const snapOne = (v) => (holdsItself(v) ? ITSELF : JSON.stringify(v ?? null));
  const snap = (locals) => new Map([...locals].map(([l, v]) => [l, snapOne(v)]));
  const named = (l) => l.name && !l.name.includes(".") && !l.name.startsWith("$");
  const frames = [];
  const pad = () => "  ".repeat(Math.max(0, frames.length - 1));
  const where = (node) => `${node.file?.name ?? ""}:${node.span.line}  ${(node.file?.line?.(node.span.line) ?? "").trim()}`;
  const settle = (f) => {
    if (!f?.pending) return;
    const changed = [...f.pending.locals].filter(([l, v]) => named(l) && f.pending.before.get(l) !== snapOne(v)).map(([l, v]) => `${l.name} = ${shown(v)}`);
    if (changed.length) err(`${pad()}      ${changed.join(", ")}`);
    f.pending = null;
  };
  // A turn is shown at the first thing that happens in it once its item is taken (a statement of its body, or, in
  // an empty body, the loop's going on to the next): the loop's line and its names, as the turn has them.
  const turn = (f, locals) => {
    if (!f.turn) return;
    const names = new Set([f.turn.symbol?.name, f.turn.itemSymbol?.name, f.turn.indexSymbol?.name].filter(Boolean));
    // Each name's own local is the latest of that name: an earlier loop's counter of the same name has ended.
    const latest = new Map([...locals].filter(([l]) => names.has(l.name)).map(([l, v]) => [l.name, v]));
    const values = [...latest].map(([name, v]) => `${name} = ${shown(v)}`);
    err(`${pad()}${where(f.turn)}${values.length ? `      ${values.join(", ")}` : ""}`);
    f.turn = null;
  };
  const watch = (e) => {
    const f = frames.at(-1);
    if (e.kind === "call") {
      if (f) err(`${pad()}  → ${e.fn.name}(${e.fn.params.map((p, i) => `${p.name} = ${shown(e.args[i])}`).join(", ")})`);
      frames.push({ fn: e.fn, pending: null, turn: null });
    } else if (e.kind === "turn") {
      settle(f);
      turn(f, e.locals);
      f.turn = e.node;
    } else if (e.kind === "line") {
      settle(f);
      if (!e.node?.span?.line) return;
      if (["for", "for-each", "collect"].includes(e.node.kind) && e.op === "set") {
        // The loop's own work: taking the turn's item comes before the turn is shown; going on to the next shows
        // a turn not yet shown, its body having had nothing to run.
        if (f.turn && e.dst !== f.turn.itemSymbol?.name) turn(f, e.locals);
        return;
      }
      turn(f, e.locals);
      err(`${pad()}${where(e.node)}`);
      f.pending = { locals: e.locals, before: snap(e.locals) };
    } else if (e.kind === "native") {
      err(`${pad()}    · ${e.name}(${e.args.map(shown).join(", ")})${e.value === null || e.name === "print" ? "" : ` gives ${shown(e.value)}`}`);
    } else if (e.kind === "return") {
      settle(f);
      turn(f, e.locals ?? new Map());
      frames.pop();
      if (frames.length) err(`${pad()}  ← ${f.fn.name} gives ${shown(e.value)}`);
    }
  };
  watch.flush = () => settle(frames.at(-1));
  return watch;
}

// Every byte written reaches its reader before stride ends: the exit status is set and Node ends once its output
// is written, never cut off by process.exit (§17.11). A reader that stops reading early (`| head`) ends stride at
// once, quietly: with the status of a failure already said, else 0. Anything stride did not expect is said in one line, with its trace only when STRIDE_DEBUG is set.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (e) => {
    if (e.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw e;
  });
}
main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (e) => {
    const said = `${e.message} (an error in stride itself; STRIDE_DEBUG=1 shows where)`;
    if (jsonOut && !process.env.STRIDE_DEBUG) process.stdout.write(`${JSON.stringify({ ok: false, error: said })}\n`);
    else process.stderr.write(`stride: ${process.env.STRIDE_DEBUG ? e.stack : said}\n`);
    process.exitCode = 1;
  },
);
