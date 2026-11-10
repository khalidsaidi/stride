// `stride repl` (§17.14): a session to try Stride in, as Python's, Node's and JShell's are. What is typed is kept as
// a script that grows: a declaration or a statement is checked with everything kept before it and, when it has no
// mistake and its run does not fault, kept; an expression is shown its value and not kept. The session is run from
// its start each time with what fixed it the first time: the libraries as they were when first used, the answers
// kept, the date the session began (or --today). A run is the same for the same of these (§13), so each kept entry
// does what it did once, and its prints are shown once, when it is typed. :reload reads the libraries again. An
// entry that is not kept, an expression among them, keeps no answer; :undo forgets the answers of what it forgets.
// A name not used yet is not a mistake here (§11, S408–S411). Input ends at :quit or the end of stdin; lines go on
// while a bracket, brace or parenthesis is open.
import { compile, diskRead, LANGUAGE } from "./compile.mjs";
import { parseExpression } from "./syntax.mjs";
import { load, run } from "../runtime/vm.mjs";

const HELP = `Type a declaration or a statement to keep it, or an expression to see its value.
  :list            what is kept, numbered
  :undo            forget the last thing kept
  :reset           forget everything, answers too
  :reload          read the libraries again, and run what is kept with them
  :answers         the answers given so far
  :quit            end (so does the end of input)
Questions a statement asks are asked here as it runs.`;

// Whether text leaves a bracket open, outside words in quotes.
function open(text) {
  let depth = 0, inWords = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inWords) {
      if (c === "\\") i++;
      else if (c === '"') inWords = false;
      continue;
    }
    if (c === "#") {
      const nl = text.indexOf("\n", i);
      if (nl < 0) break;
      i = nl;
    } else if (c === '"') inWords = true;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
  }
  return depth > 0 || inWords;
}

export function repl({ use = null, today = null, readLine, out, err, prompt, context = { dir: process.cwd(), libraries: [] } }) {
  let kept = []; // what is kept, in order, each { text, answers: the answers kept once it was }
  let answers = {};
  const now = new Date();
  today ??= `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  // Each library as it was when the session first read it.
  let files = new Map();
  const read = (path) => {
    if (!files.has(path)) files.set(path, diskRead(path));
    return files.get(path);
  };
  let shownPrints = 0; // how many print lines the kept program has given and shown
  const head = use ? `use "${use}"\n` : "";
  const interactive = process.stdin.isTTY;
  const ask = (text) => interactive && process.stderr.write(text);
  if (interactive) err(`stride repl: Stride ${LANGUAGE}; :help for help, :quit to end`);

  // The session with `more` after it, compiled and run; prints past `from` are what it adds.
  // The answers it was given are its own copy: kept only when the entry is.
  const attempt = (more) => {
    const source = `${head}${[...kept.map((k) => k.text), more].join("\n")}\n`;
    const before = head.split("\n").length - 1 + kept.reduce((n, k) => n + k.text.split("\n").length, 0);
    const compiled = compile(source, "repl.stride", { ...context, read, session: true });
    const mistakes = compiled.diagnostics.sorted().filter((d) => d.severity === "error");
    if (mistakes.length) return { mistakes, before };
    const p = load(compiled.bytecode);
    const runOnce = (a) => run(p, a, { today });
    const own = { ...answers };
    prompt(own, runOnce);
    return { result: runOnce(own), before, answers: own };
  };
  // A mistake as it stands in what was just typed: its line there, its column, its words.
  const said = (mistakes, before) =>
    mistakes.slice(0, 5).forEach((d) => {
      const line = d.span?.line ? d.span.line - before : null;
      err(`mistake ${d.code}: ${d.message}${line && line > 0 ? ` (line ${line}, column ${d.span.col})` : ""}`);
    });

  for (;;) {
    ask("stride> ");
    let text = readLine();
    if (text === null) break;
    while (open(text)) {
      ask("   ...> ");
      const more = readLine();
      if (more === null) break;
      text += `\n${more}`;
    }
    const t = text.trim();
    if (!t) continue;
    if (t.startsWith(":")) {
      const [cmd] = t.split(/\s+/);
      if (cmd === ":quit" || cmd === ":q" || cmd === ":exit") break;
      if (cmd === ":help") err(HELP);
      else if (cmd === ":list") kept.forEach((k, i) => out(`${String(i + 1).padStart(3)}  ${k.text.replace(/\n/g, "\n     ")}`));
      else if (cmd === ":answers") out(JSON.stringify(answers));
      else if (cmd === ":reset") (kept = []), (answers = {}), (shownPrints = 0), (files = new Map());
      else if (cmd === ":undo") {
        kept.pop();
        answers = kept.at(-1)?.answers ?? {};
        const r = attempt("");
        shownPrints = r.result?.prints.length ?? 0;
      } else if (cmd === ":reload") {
        // What is kept, run again with the libraries as they are now; what it prints now is not shown again.
        const was = files;
        files = new Map();
        const r = attempt("");
        if (r.mistakes) (files = was), err("the libraries as they are now give the session a mistake; kept as it was:"), said(r.mistakes, 0);
        else if (r.result.fault) (files = was), err(`the libraries as they are now make the session fault (${r.result.fault.code}); kept as it was`);
        else (shownPrints = r.result.prints.length), err("read the libraries again");
      } else err(`no command ${cmd}; :help lists them`);
      continue;
    }
    // An expression: its value, and nothing kept. One that gives no value (print(1)) is a statement.
    const alone = parseExpression(t, -1);
    if (!alone.empty && !alone.rest && !alone.mistakes.length) {
      const r = attempt(`print(\n${t}\n)`);
      const noValue = r.mistakes?.every((d) => ["S366", "S370"].includes(d.code));
      if (!r.mistakes || !noValue) {
        if (r.mistakes) said(r.mistakes, r.before + 1);
        else if (r.result.fault) err(`fault ${r.result.fault.code}: ${r.result.fault.message}`);
        else {
          for (const line of r.result.prints.slice(shownPrints, -1)) out(line);
          out(r.result.prints.at(-1) ?? "");
        }
        continue;
      }
    }
    // A declaration or a statement: kept when it has no mistake and its run does not fault.
    const r = attempt(t);
    if (r.mistakes) {
      said(r.mistakes, r.before);
      continue;
    }
    for (const line of r.result.prints.slice(shownPrints)) out(line);
    if (r.result.fault) {
      err(`fault ${r.result.fault.code}: ${r.result.fault.message} (not kept)`);
      continue;
    }
    answers = r.answers;
    kept.push({ text: t, answers });
    shownPrints = r.result.prints.length;
  }
  return 0;
}

