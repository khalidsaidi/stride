// rule 17.1
// --today is checked before anything runs (§17): a missing value, a malformed date, an impossible day or a year
// outside 0001–9999 is a usage mistake (exit 2), never replaced by the device's date.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function test() {
  const cli = fileURLToPath(new URL("../../bin/stride.mjs", import.meta.url));
  const problems = [];
  for (const [args, ok] of [[["--today", "2024-02-29"], true], [["--today", "2020-02-30"], false], [["--today", "0000-01-01"], false], [["--today", "2020-1-1"], false], [["--today"], false]]) {
    const r = spawnSync("node", [cli, "eval", "today()", ...args], { encoding: "utf8", timeout: 20_000 });
    if (ok && (r.status !== 0 || r.stdout.trim() !== "2024-02-29")) problems.push(`${args.join(" ")}: expected 2024-02-29, got ${r.status} ${r.stdout}${r.stderr}`);
    if (!ok && (r.status !== 2 || !r.stderr.includes("--today") || r.stdout.trim() !== "")) problems.push(`${args.join(" ")}: expected a usage mistake, got ${r.status} ${r.stdout}${r.stderr}`);
  }
  return problems;
}
