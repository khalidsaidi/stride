// rule 17.3
// `stride fmt` (§17): Stride's one layout, comments kept; a statement written over two lines is followed by a blank
// line only where the source had one.
import { format } from "../../src/format.mjs";

export function test() {
  const pdf = "0".repeat(64);
  const source = `form t\npdf ${pdf}\nask n: number "N" # trailing\n  check n > 1 "big"\nlet x = [1,\n  2]\n\nprint(x)\n`;
  const want = `form t\npdf ${pdf}\nask n: number "N" check n > 1 "big" # trailing\nlet x = [1, 2]\n\nprint(x)\n`;
  const got = format(source, "f.stride").text;
  return got === want ? [] : [`stride fmt gave\n${got}\nexpected\n${want}`];
}
