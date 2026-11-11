// rule 17.3 6.16
// `stride fmt` (§17): Stride's one layout, comments kept; a statement written over two lines is followed by a blank
// line only where the source had one.
import { format } from "../../src/format.mjs";

export function test() {
  const pdf = "0".repeat(64);
  const source = `form t\npdf ${pdf}\nask n: number "N" # trailing\n  check n > 1 "big"\nlet x = [1,\n  2]\n\nprint(x)\n`;
  const want = `form t\npdf ${pdf}\nask n: number "N" check n > 1 "big" # trailing\nlet x = [1, 2]\n\nprint(x)\n`;
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
  ];
  for (const [from, to] of coalesce) {
    const out = format(`form t\npdf ${pdf}\n${from}\n`, "f.stride").text;
    if (out !== `form t\npdf ${pdf}\n${to}\n`) problems.push(`stride fmt gave\n${out}\nfor ${from}, expected ${to}`);
  }
  return problems;
}
