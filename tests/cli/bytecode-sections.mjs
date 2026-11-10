// rule 18.1
// The program and code sections must be there, each once; any section twice is refused. The places section may be
// left out: the program runs, and a fault has no source place. Sections come in any order.
import { compile } from "../../src/compile.mjs";
import { load, run } from "../../runtime/vm.mjs";
import { Reader, Writer, SECTION } from "../../runtime/bytecode.mjs";

// The sections of a file: [[tag, bytes]], after the magic and the version.
function sections(bytes) {
  const r = new Reader(bytes, 5, bytes.length);
  const out = [];
  while (r.at < r.end) {
    const tag = r.u8();
    const n = r.varint();
    out.push([tag, bytes.subarray(r.at, r.at + n)]);
    r.at += n;
  }
  return out;
}
function build(head, list) {
  const w = new Writer();
  for (const [tag, b] of list) (w.u8(tag), w.varint(b.length), w.bytes.push(...b));
  return Uint8Array.from([...head, ...w.bytes]);
}

export function test() {
  const out = compile(`form t\npdf ${"0".repeat(64)}\nprint(1 / 0)\n`, "p.stride", { header: { form: "t", pdf: "0".repeat(64), boxes: [] }, certain: false });
  if (!out.bytecode) return ["the fixture did not compile"];
  const head = out.bytecode.subarray(0, 5);
  const all = sections(out.bytecode);
  const problems = [];
  const refuse = (name, list, words) => {
    try {
      load(build(head, list));
      problems.push(`${name}: loaded; expected it refused with "${words}"`);
    } catch (e) {
      if (!String(e.message).includes(words)) problems.push(`${name}: refused with "${e.message}", expected "${words}"`);
    }
  };
  refuse("no program section", all.filter(([t]) => t !== SECTION.PROGRAM), "program section is missing");
  refuse("no code section", all.filter(([t]) => t !== SECTION.CODE), "code section is missing");
  refuse("texts twice", [...all, all.find(([t]) => t === SECTION.TEXTS)], "comes twice");
  refuse("an unknown section twice", [...all, [200, Uint8Array.of(0)], [200, Uint8Array.of(0)]], "comes twice");
  if (!all.some(([t]) => t === SECTION.PLACES)) problems.push("the compiler wrote no places section");
  try {
    const x = run(load(build(head, all.filter(([t]) => t !== SECTION.PLACES))), {});
    if (x.fault?.code !== "F001") problems.push(`without places: expected the run to fault F001, got ${JSON.stringify(x.fault)}`);
    else if (x.fault.line !== null || x.fault.column !== null || x.fault.file !== null || x.fault.stack.some((f) => f.line !== null)) problems.push(`without places: the fault has a place ${x.fault.file}:${x.fault.line}:${x.fault.column}`);
  } catch (e) {
    problems.push(`without places: refused: ${e.message}`);
  }
  for (const [name, list] of [["reversed", [...all].reverse()], ["program first", [...all.filter(([t]) => t === SECTION.PROGRAM), ...all.filter(([t]) => t !== SECTION.PROGRAM)]]]) {
    try {
      const x = run(load(build(head, list)), {});
      if (x.fault?.code !== "F001" || x.fault.line !== 3) problems.push(`sections ${name}: expected F001 at line 3, got ${JSON.stringify(x.fault)}`);
    } catch (e) {
      problems.push(`sections ${name}: refused: ${e.message}`);
    }
  }
  return problems;
}
