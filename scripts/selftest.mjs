#!/usr/bin/env node
// Stride's own tests (docs/spec.md §19): node scripts/selftest.mjs [name …]. Every program in tests/ gives the
// mistakes it states or fills the boxes it states, in both engines; with no name, every rule of the specification
// must have a test that passes, and `stride explain`'s words must be the specification's.
import { readFileSync } from "node:fs";
import { selftest, coverage, testNames } from "../src/selftest.mjs";
import { CODES, LIBRARY } from "../src/codes.mjs";
import { codesOf, libraryOf, SPEC_PATH } from "../src/gen-codes.mjs";

const names = process.argv.slice(2);
const unmatched = names.filter((a) => !testNames().some((n) => n.includes(a)));
if (unmatched.length) {
  console.error(`no test is named ${unmatched.join(", ")}`);
  process.exit(2);
}
const results = selftest(undefined, names);
let failed = 0;
for (const r of results) {
  if (!r.problems.length) continue;
  failed++;
  console.log(`FAIL ${r.name}`);
  for (const p of r.problems) console.log(`     ${p}`);
}
console.log(failed ? `${failed} of ${results.length} failed` : `${results.length} passed`);
let incomplete = false;
if (!names.length) {
  const cov = coverage(results);
  if (cov.unknown.length) console.log(`tests name rules the spec does not have: ${cov.unknown.join(" ")}`);
  console.log(cov.untested.length ? `${cov.untested.length} of ${cov.rules.length} rules have no test: ${cov.untested.join(" ")}` : `every one of ${cov.rules.length} rules has a test`);
  console.log(cov.passing.length === cov.rules.length ? `every one of ${cov.rules.length} rules conforms: all its tests pass` : `${cov.passing.length} of ${cov.rules.length} rules conform (every test naming them passes); ${cov.failing.length} have a failing test`);
  incomplete = cov.untested.length > 0 || cov.unknown.length > 0 || cov.passing.length < cov.rules.length;
}
// codes.mjs is generated from the specification, and must be current.
const text = readFileSync(SPEC_PATH, "utf8");
const spec = codesOf(text);
const stale = [...new Set([...Object.keys(spec), ...Object.keys(CODES)])].filter((c) => JSON.stringify(spec[c]) !== JSON.stringify(CODES[c]));
if (JSON.stringify(libraryOf(text)) !== JSON.stringify(LIBRARY)) stale.push("the standard library's entries");
if (stale.length) console.log(`stride explain differs from the spec for ${stale.join(" ")}: run node src/gen-codes.mjs`);
process.exit(failed || stale.length || incomplete ? 1 : 0);
