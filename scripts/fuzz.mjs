#!/usr/bin/env node
process.env.STRIDE_LIMIT ??= "2000000"; // the tests' own stop on a run that goes on too long
// Programs made at random, run in both engines (docs/spec.md §19.2):
// node scripts/fuzz.mjs [runs] [seed] [--show]. A disagreement, a crash, or a mistake on a valid program is a bug.
import { fuzz } from "../tests/support/fuzz.mjs";

const args = process.argv.slice(2).filter((a) => a !== "--show");
const show = process.argv.includes("--show");
const runs = Number(args[0] ?? 100), seed = Number(args[1] ?? 1);
if (!Number.isSafeInteger(runs) || runs < 1 || !Number.isSafeInteger(seed) || seed < 0) {
  console.error("usage: node scripts/fuzz.mjs [runs] [seed] [--show]");
  process.exit(2);
}
const { counts, bugs, faults, compared } = fuzz({ runs, seed });
for (const b of bugs) {
  console.log(`BUG seed ${b.seed}: ${b.problem}`);
  if (show) console.log(`${b.source}${b.answers ? ` answers: ${JSON.stringify(b.answers)}` : ""}`);
}
console.log(`${runs} programs from seed ${seed}: ${counts.agreed} agreed, ${counts.exhausted} exhausted, ${counts.bug} bugs`);
console.log(`${compared} runs compared; how they ended: ${Object.entries(faults).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ")}`);
process.exit(bugs.length ? 1 : 0);
