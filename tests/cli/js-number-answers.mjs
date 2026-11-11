// rule 8.7
// A host's JavaScript number given to a words or one_of question is read from its shortest round-trip decimal,
// written as Stride writes a number (no exponent); one that is no number (NaN) is not words (§8.7).
import { convert } from "../../runtime/vm.mjs";

export function test() {
  const problems = [];
  const text = { type: "string", options: [] };
  const one = { type: "one_of", options: [{ value: "0.00000015" }, { value: "1000000000000000000000" }] };
  const cases = [
    [text, 1e21, "1000000000000000000000", null],
    [text, 1.5e-7, "0.00000015", null],
    [text, NaN, null, "not words"],
    [one, 1.5e-7, "0.00000015", null],
    [one, 1e21, "1000000000000000000000", null],
    [one, Infinity, null, "not one of the options"],
  ];
  for (const [q, raw, value, why] of cases) {
    const r = convert(q, raw);
    if (r.value !== value || (r.unreadable ?? null) !== why) problems.push(`${q.type} ${raw}: got ${JSON.stringify(r)}, expected ${JSON.stringify({ value, unreadable: why })}`);
  }
  return problems;
}
