// The debugger (§17.15): a program run in the machine, which tells it of each statement before it runs,
// stopping where it is told: at a breakpoint's line, or after a step in, over or out. Stopped, it
// shows the calls that led there and each one's values, and evaluates a name or an expression of them. Two faces on
// one core: `stride debug`, at the terminal, and `stride dap`, the Debug Adapter Protocol for editors.
import { readSync, writeSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import { compileFile } from "./compile.mjs";
import { faultWords } from "./source.mjs";
import { stringOf, load, run, boxValues } from "../runtime/vm.mjs";
import { holdsItself } from "../runtime/values.mjs";

// ----- the core

const shown = (v) => (holdsItself(v) ? "(holds itself)" : v === null || v === undefined ? "null" : typeof v === "string" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(shown).join(", ")}]` : v === true ? "true" : v === false ? "false" : v?.fields ? `${v.type} { ${v.fields.map((f, i) => `${v.names?.[i] ?? i}: ${shown(f)}`).join(", ")} }` : v?.pairs ? `{${v.pairs.map(([k, x]) => `${shown(k)}: ${shown(x)}`).join(", ")}}` : stringOf(v));
const named = (l) => l.name && !l.name.includes(".") && !l.name.startsWith("$");

// The program, compiled to be followed: its intermediate form, and where each of its files is on disk.
function prepare(file) {
  let out;
  try {
    out = compileFile(file, { trace: true });
  } catch (e) {
    return { error: e.message };
  }
  if (!out.header && !out.program?.script && !out.program?.test) out = compileFile(file, { trace: true, header: { form: null, pdf: "0".repeat(64), boxes: [] } });
  const mistakes = out.diagnostics.sorted().filter((d) => d.severity === "error");
  if (mistakes.length) return { error: mistakes.map((d) => d.format({ color: false })).join("\n\n") };
  const paths = new Map(); // a file's name as the compiler gives it -> its path
  paths.set(basename(file), resolve(file));
  for (const r of out.resolved?.units ?? []) if (r.unit.path && !r.unit.std) paths.set(r.unit.file.name, resolve(r.unit.path)); // a library's path is as `import` found it, from here
  // The lines a statement starts on, by file: where a breakpoint can stop.
  const lines = new Map();
  for (const fn of out.program.functions)
    for (const b of fn.blocks)
      for (const s of [...b.stmts, ...(b.term && ["if", "match", "return"].includes(b.term.node?.kind) ? [b.term] : [])]) {
        const n = s.node;
        if (!n?.span?.line || !n.file) continue;
        const path = paths.get(n.file.name);
        if (!path) continue;
        if (!lines.has(path)) lines.set(path, new Set());
        lines.get(path).add(n.span.line);
      }
  return { out, paths, lines };
}

// Runs a prepared program, calling `stop(why, state)` where it should stop; `stop` returns how to go on:
// "continue", "in", "over" or "out". Gives the run's result.
function follow(prepared, answers, { today, breakpoints, stopOnEntry, stop, printed }) {
  const frames = []; // { fn, locals, node }
  let mode = stopOnEntry ? "in" : "continue";
  let depthAt = 0;
  const pathOf = (node) => prepared.paths.get(node?.file?.name) ?? null;
  const watch = (e) => {
    if (e.kind === "call") frames.push({ fn: e.fn, locals: new Map(), node: null });
    // A loop's next turn runs its statements again: each is a new place to stop.
    else if (e.kind === "turn") frames.at(-1).node = null;
    else if (e.kind === "return") frames.pop();
    else if (e.kind === "print") printed?.(e.text);
    else if (e.kind === "line") {
      const f = frames.at(-1);
      f.locals = e.locals;
      // A loop's own work is not a place to stop (§17.7).
      if (!e.node?.span?.line || (["for", "for-each", "collect", "while"].includes(e.node.kind) && e.op === "set")) return;
      const same = f.node === e.node;
      f.node = e.node;
      const path = pathOf(e.node);
      const atBreak = path && breakpoints.get(path)?.has(e.node.span.line) && !same;
      const depth = frames.length;
      const stepped = (mode === "in" && !same) || (mode === "over" && depth <= depthAt && !same) || (mode === "out" && depth < depthAt);
      if (!atBreak && !stepped) return;
      mode = stop(atBreak ? "breakpoint" : stopOnEntry && depthAt === 0 ? "entry" : "step", { frames, path, line: e.node.span.line, node: e.node });
      depthAt = frames.length;
      if (mode === "quit") throw new Quit();
    }
  };
  try {
    const p = load(prepared.out.bytecode);
    const result = run(p, answers, { today, watch, debug: prepared.out.debug });
    // The boxes by name, as the page holds them.
    return { ...result, writes: new Map(Object.entries(boxValues(p, result.writes))) };
  } catch (e) {
    if (e instanceof Quit) return null;
    throw e;
  }
}
class Quit extends Error {}

// A frame's values, by name: its own locals the program named, each the latest of its name.
const valuesOf = (frame) => new Map([...frame.locals].filter(([l]) => named(l)).map(([l, v]) => [l.name, v]));

// ----- at the terminal: `stride debug`

const HELP = `  break N, b N         stop at line N (b file.stride:N for a library's)     delete N   no longer
  continue, c          run to the next breakpoint
  next, n              the next line, over calls       step, s   into a call      out, o   out of this call
  print NAME, p NAME   a value            locals, l   every value here        where, w   the calls
  list                 the lines around here           breaks     the breakpoints  quit, q   stop`;

export function debugTerminal(file, answers, { today }) {
  const prepared = prepare(file);
  if (prepared.error) return process.stderr.write(`${prepared.error}\n`), 1;
  const say = (t) => process.stderr.write(`${t}\n`);
  const breakpoints = new Map();
  const main = resolve(file);
  let pending = "";
  const readLine = () => {
    const buf = Buffer.alloc(1024);
    for (;;) {
      const nl = pending.indexOf("\n");
      if (nl >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        return line.replace(/\r$/, "");
      }
      let n;
      try {
        n = readSync(0, buf, 0, buf.length, null);
      } catch (e) {
        if (e.code === "EAGAIN") continue;
        throw e;
      }
      if (n === 0) {
        const rest = pending;
        pending = "";
        return rest || null;
      }
      pending += buf.toString("utf8", 0, n);
    }
  };
  const source = (node) => node.file?.line?.(node.span.line) ?? "";
  say(`stride debug: ${file}, stopped before its first line; help lists the commands`);
  const stop = (why, { frames, path, line, node }) => {
    say(`${why === "breakpoint" ? "breakpoint at " : ""}${node.file?.name ?? path}:${line}  ${source(node).trim()}`);
    for (;;) {
      if (process.stdin.isTTY) process.stderr.write("(debug) ");
      const raw = readLine();
      if (raw === null) return "continue";
      if (!process.stdin.isTTY) say(`(debug) ${raw}`);
      const [cmd, ...rest] = raw.trim().split(/\s+/);
      const arg = rest.join(" ");
      if (!cmd) continue;
      if (["c", "continue"].includes(cmd)) return "continue";
      if (["n", "next"].includes(cmd)) return "over";
      if (["s", "step"].includes(cmd)) return "in";
      if (["o", "out"].includes(cmd)) return "out";
      if (["q", "quit"].includes(cmd)) return "quit";
      if (["b", "break", "delete"].includes(cmd)) {
        const m = arg.match(/^(?:(.+):)?(\d+)$/);
        if (!m) {
          say(`${cmd} takes a line: ${cmd} 12, or ${cmd} lib/x.stride:12`);
          continue;
        }
        // A file as the person names it: from the folder they are in, from the program's, or the end of a loaded file's path.
        const known = [...prepared.lines.keys()];
        const path = !m[1] ? main : [resolve(m[1]), resolve(dirname(main), m[1])].find((p) => prepared.lines.has(p)) ?? known.find((p) => p.endsWith(`${sep}${m[1].replaceAll("/", sep)}`)) ?? resolve(m[1]);
        const n = Number(m[2]);
        if (!breakpoints.has(path)) breakpoints.set(path, new Set());
        if (cmd === "delete") (breakpoints.get(path).delete(n), say(`no longer stopping at ${m[1] ?? file}:${n}`));
        else if (!prepared.lines.get(path)?.has(n)) say(`no statement starts on ${m[1] ?? file}:${n}; a breakpoint goes on a statement's first line`);
        else (breakpoints.get(path).add(n), say(`stopping at ${m[1] ?? file}:${n}`));
        continue;
      }
      if (cmd === "breaks") {
        for (const [p, ls] of breakpoints) for (const n of ls) say(`  ${p === main ? file : p}:${n}`);
        continue;
      }
      if (["p", "print"].includes(cmd)) {
        const values = valuesOf(frames.at(-1));
        say(values.has(arg) ? `${arg} = ${shown(values.get(arg))}` : `no ${arg} here; locals lists what is`);
        continue;
      }
      if (["l", "locals"].includes(cmd)) {
        const values = valuesOf(frames.at(-1));
        say(values.size ? [...values].map(([k, v]) => `  ${k} = ${shown(v)}`).join("\n") : "  nothing yet");
        continue;
      }
      if (["w", "where"].includes(cmd)) {
        [...frames].reverse().forEach((f, i) => say(`  ${i === 0 ? "→" : " "} ${f.fn.name}  ${f.node ? `${f.node.file?.name}:${f.node.span.line}` : ""}`));
        continue;
      }
      if (cmd === "list") {
        for (let k = Math.max(1, line - 3); k <= line + 3; k++) {
          const t = node.file?.line?.(k);
          if (t !== undefined && t !== null) say(`${k === line ? "→" : " "}${String(k).padStart(4)}  ${t}`);
        }
        continue;
      }
      if (["h", "help", "?"].includes(cmd)) say(HELP);
      else say(`no command ${cmd}; help lists them`);
    }
  };
  const result = follow(prepared, answers, { today, breakpoints, stopOnEntry: true, stop, printed: (t) => process.stdout.write(`${t}\n`) });
  if (!result) return say("stopped"), 0;
  if (result.fault) return say(faultWords(result.fault)), 1;
  say("the program ended");
  return 0;
}

// ----- for editors: `stride dap`, the Debug Adapter Protocol on stdin and stdout

export function serveDap() {
  let seq = 1;
  const send = (m) => {
    const body = Buffer.from(JSON.stringify({ seq: seq++, ...m }), "utf8");
    writeSync(1, `Content-Length: ${body.length}\r\n\r\n`);
    writeSync(1, body);
  };
  const reply = (req, body = {}, success = true, message) => send({ type: "response", request_seq: req.seq, command: req.command, success, ...(message ? { message } : {}), body });
  const event = (name, body = {}) => send({ type: "event", event: name, body });
  let buffer = Buffer.alloc(0);
  // One message, read as it comes: the adapter waits for its editor, so reading may block.
  const next = () => {
    const chunk = Buffer.alloc(65536);
    for (;;) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end >= 0) {
        const length = Number(/Content-Length: (\d+)/i.exec(buffer.slice(0, end).toString())?.[1]);
        if (buffer.length >= end + 4 + length) {
          const m = JSON.parse(buffer.slice(end + 4, end + 4 + length).toString("utf8"));
          buffer = buffer.slice(end + 4 + length);
          return m;
        }
      }
      let n;
      try {
        n = readSync(0, chunk, 0, chunk.length, null);
      } catch (e) {
        if (e.code === "EAGAIN") continue;
        throw e;
      }
      if (n === 0) return null;
      buffer = Buffer.concat([buffer, chunk.subarray(0, n)]);
    }
  };

  let prepared = null, launch = null;
  const breakpoints = new Map();
  let frames = [];
  const refs = new Map(); // a variables reference -> what it shows
  let nextRef = 1;
  const frameRef = (i) => i + 1;
  const variablesOf = (values) =>
    [...values].map(([name, v]) => {
      let ref = 0;
      if ((Array.isArray(v) && v.length) || v?.fields) refs.set((ref = 1000 + nextRef++), v);
      return { name, value: shown(v), variablesReference: ref };
    });
  const childrenOf = (v) => (Array.isArray(v) ? v.map((x, i) => [`[${i + 1}]`, x]) : v.fields.map((x, i) => [v.names?.[i] ?? String(i), x]));

  // Requests answered whether the program runs or is stopped; `stopped` is true while it is.
  const answer = (req, stopped) => {
    const a = req.arguments ?? {};
    switch (req.command) {
      case "initialize":
        reply(req, { supportsConfigurationDoneRequest: true, supportsEvaluateForHovers: true, supportsTerminateRequest: true });
        return event("initialized");
      case "launch": {
        launch = a;
        prepared = prepare(a.program);
        if (prepared.error) {
          reply(req, {}, false, prepared.error);
          event("output", { category: "stderr", output: `${prepared.error}\n` });
          return event("terminated");
        }
        return reply(req);
      }
      case "setBreakpoints": {
        const path = resolve(a.source?.path ?? "");
        const lines = (a.breakpoints ?? []).map((b) => b.line);
        breakpoints.set(path, new Set(lines.filter((n) => prepared?.lines.get(path)?.has(n))));
        return reply(req, { breakpoints: lines.map((line) => ({ verified: !!prepared?.lines.get(path)?.has(line), line, ...(prepared?.lines.get(path)?.has(line) ? {} : { message: "no statement starts on this line" }) })) });
      }
      case "threads":
        return reply(req, { threads: [{ id: 1, name: "the program" }] });
      case "stackTrace": {
        const shown = [...frames].reverse();
        return reply(req, { stackFrames: shown.map((f, i) => ({ id: frameRef(frames.length - 1 - i), name: f.fn.name, line: f.node?.span?.line ?? 0, column: f.node?.span?.col ?? 1, source: prepared.paths.get(f.node?.file?.name) ? { path: prepared.paths.get(f.node.file.name), name: basename(f.node.file.name) } : undefined })), totalFrames: shown.length });
      }
      case "scopes":
        return reply(req, { scopes: [{ name: "Values", variablesReference: a.frameId, expensive: false }] });
      case "variables": {
        const ref = a.variablesReference;
        if (refs.has(ref)) return reply(req, { variables: variablesOf(childrenOf(refs.get(ref))) });
        const frame = frames[ref - 1];
        return reply(req, { variables: frame ? variablesOf(valuesOf(frame)) : [] });
      }
      case "evaluate": {
        const frame = a.frameId ? frames[a.frameId - 1] : frames.at(-1);
        const values = frame ? valuesOf(frame) : new Map();
        const name = (a.expression ?? "").trim();
        return values.has(name) ? reply(req, { result: shown(values.get(name)), variablesReference: 0 }) : reply(req, {}, false, `no ${name} here`);
      }
      case "configurationDone":
        return reply(req);
      case "disconnect":
      case "terminate":
        reply(req);
        if (req.command === "terminate") event("terminated");
        return "quit";
      default:
        if (stopped && ["continue", "next", "stepIn", "stepOut", "pause"].includes(req.command)) return;
        return reply(req, {}, false, `stride dap does not do ${req.command}`);
    }
  };

  // Before the run: everything up to configurationDone.
  for (;;) {
    const req = next();
    if (!req) return 0;
    if (answer(req, false) === "quit") return 0;
    if (req.command === "configurationDone" && prepared && !prepared.error) break;
  }
  const result = follow(prepared, launch.answers ?? {}, {
    today: launch.today ?? null,
    breakpoints,
    stopOnEntry: !!launch.stopOnEntry,
    printed: (t) => event("output", { category: "stdout", output: `${t}\n` }),
    stop: (why, state) => {
      frames = state.frames;
      refs.clear();
      event("stopped", { reason: why, threadId: 1, allThreadsStopped: true });
      for (;;) {
        const req = next();
        if (!req) return "quit";
        const go = { continue: "continue", next: "over", stepIn: "in", stepOut: "out" }[req.command];
        if (go) {
          reply(req, req.command === "continue" ? { allThreadsContinued: true } : {});
          return go;
        }
        if (answer(req, true) === "quit") return "quit";
      }
    },
  });
  if (result?.fault) event("output", { category: "stderr", output: `${faultWords(result.fault)}\n` });
  event("exited", { exitCode: result?.fault ? 1 : 0 });
  event("terminated");
  // The editor ends the session.
  for (let req; (req = next()); ) if (answer(req, false) === "quit") break;
  return 0;
}

