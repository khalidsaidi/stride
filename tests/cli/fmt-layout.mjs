// rule 17.3 6.16 7.7 7.9 8.5
// `stride fmt` (§17): Stride's one layout, comments kept; a statement written over two lines is followed by a blank
// line only where the source had one. Brackets keep their author's line breaks, and brackets on one line too long
// for it wrap at 120 characters; a collect keeps `another` as written.
import { format } from "../../src/format.mjs";

export function test() {
  const pdf = "0".repeat(64);
  const source = `form t\npdf ${pdf}\nask n: number "N" # trailing\n  check n > 1 "big"\nlet x = [1,\n  2]\n\nprint(x)\n`;
  const want = `form t\npdf ${pdf}\nask n: number "N" check n > 1 "big" # trailing\nlet x = [1,\n  2]\n\nprint(x)\n`;
  const got = format(source, "f.stride").text;
  const problems = got === want ? [] : [`stride fmt gave\n${got}\nexpected\n${want}`];
  // a ?? b (§6.16): spaced as an operator, looser than or and tighter than if … then … else, so only the
  // brackets that change its meaning stay.
  const coalesce = [
    ["print(n??0)", "print(n ?? 0)"],
    ["print((n ?? 0) + 1)", "print((n ?? 0) + 1)"],
    ["print(n ?? (0 + 1))", "print(n ?? 0 + 1)"],
    ["print((n ?? m) ?? 0)", "print(n ?? m ?? 0)"],
    ["print(b ?? (c or d))", "print(b ?? c or d)"],
    ["print((b ?? c) or d)", "print((b ?? c) or d)"],
    ["print((if c then n else m) ?? 0)", "print((if c then n else m) ?? 0)"],
    ["print(if c then n else (m ?? 0))", "print(if c then n else m ?? 0)"],
    // tick without when (§7.7) is printed back as written, and `when true` stays.
    ['tick   "A"', 'tick "A"'],
    ['tick "A"  when true', 'tick "A" when true'],
    // Printed words and a button in brackets (§7.9) keep their brackets.
    ['ask n: string (if j then "A" else "B")', 'ask n: string (if j then "A" else "B")'],
    ['pick "G" ( W ) when c', 'pick "G" (W) when c'],
    // Brackets on one line that fit stay on it; the author's line breaks inside brackets stay.
    ["let x = [1 ,2]", "let x = [1, 2]"],
    ["let r = new p {\n  a: 1,\n  b: [2,\n    3]\n}", "let r = new p {\n  a: 1,\n  b: [2,\n    3],\n}"],
    ["let r = new p { a: 1 }", "let r = new p { a: 1 }"],
    ['f("a",\n  "b") as "x"', 'f("a",\n  "b") as "x"'],
    // Too long for one line: the items fill each line up to 120 characters, the next two spaces in.
    [`const L = [${Array.from({ length: 30 }, (_, i) => `"item${i}"`).join(", ")}]`, `const L = ["item0", "item1", "item2", "item3", "item4", "item5", "item6", "item7", "item8", "item9", "item10", "item11",\n  "item12", "item13", "item14", "item15", "item16", "item17", "item18", "item19", "item20", "item21", "item22",\n  "item23", "item24", "item25", "item26", "item27", "item28", "item29"]`],
    // A function's parameters, too.
    [`function f(${Array.from({ length: 12 }, (_, i) => `name${i}: string`).join(", ")}) {\n}`, `function f(name0: string, name1: string, name2: string, name3: string, name4: string, name5: string, name6: string,\n  name7: string, name8: string, name9: string, name10: string, name11: string) {\n}`],
    // collect keeps `another` as written (§8.5).
    ['var l: list<string>\ncollect x in l any "Any?" "More?" {\n  ask x: string "X"\n}', 'var l: list<string>\ncollect x in l any "Any?" "More?" {\n  ask x: string "X"\n}'],
    ['var l: list<string>\ncollect x in l any "Any?" another "More?" {\n  ask x: string "X"\n}', 'var l: list<string>\ncollect x in l any "Any?" another "More?" {\n  ask x: string "X"\n}'],
  ];
  for (const [from, to] of coalesce) {
    const out = format(`form t\npdf ${pdf}\n${from}\n`, "f.stride").text;
    if (out !== `form t\npdf ${pdf}\n${to}\n`) problems.push(`stride fmt gave\n${out}\nfor ${from}, expected ${to}`);
  }
  return problems;
}
