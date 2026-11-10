// Phase 2: load. A program and every library it uses, directly or through another library, each parsed once,
// in an order where a library comes before every file that uses it. The standard library (lib/
// std.stride) is loaded first and is used by every file without a `use`. A library is looked for in lib/ beside
// the program: `use "people"` is lib/people.stride.
//
// A unit is { file, tree, library: bool, uses: [unit], std: bool }.
import { KIND, SourceFile } from "./source.mjs";
import { parse } from "./parse.mjs";

export const STD = "std";

// `read(path)` gives a file's text, or null if there is none: the command line reads the disk, a test can give
// sources from memory. `libDir` is where `use` looks: a folder, or folders in the order they are looked in (lib/
// beside the program, then its project's, §4.5); `stdPath` is the standard library.
export function load(programFile, diagnostics, { read, libDir, stdPath }) {
  const units = new Map(); // path -> unit
  const order = [];

  const std = loadOne(stdPath, `lib/${STD}.stride`, true);
  if (std) std.std = true;

  const test = programFile.name.endsWith(".test.stride");
  const program = parse(programFile, diagnostics, test ? "Test" : "Program");
  if (!program) return null;
  const main = { file: programFile, tree: program, library: false, uses: [], std: false, path: null, test };

  // Depth first; `chain` holds the files being loaded, so a file that comes back to one of them is a circle.
  function visit(unit, chain) {
    for (const use of unit.tree.items.filter((i) => i.kind === "use")) {
      const name = use.path; // small letters, digits, - and _, with / between folders: no ".stride" (§4.5, S102)
      if (name === STD) {
        diagnostics.add(KIND.LIBRARY, unit.file, use.span, `the standard library is always there; use "${STD}" is not needed`, [], "S101");
        continue;
      }
      if (!/^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/.test(name)) {
        diagnostics.add(KIND.LIBRARY, unit.file, use.pathSpan, `"${use.path}" is not a library name: small letters, digits, - and _, with / between folders`, [], "S102");
        continue;
      }
      const dirs = Array.isArray(libDir) ? libDir : [libDir];
      const path = dirs.map((d) => `${d}/${name}.stride`).find((p) => read(p) !== null) ?? `${dirs[0]}/${name}.stride`;
      const shown = `lib/${name}.stride`;
      const inChain = chain.findIndex((u) => u.path === path);
      if (inChain >= 0) {
        const circle = [...chain.slice(inChain).map((u) => u.file.name), shown].join(" uses ");
        diagnostics.add(KIND.LIBRARY, unit.file, use.span, `libraries cannot use each other in a circle: ${circle}`, [], "S103");
        continue;
      }
      let lib = units.get(path);
      if (!lib) {
        lib = loadOne(path, shown, false, unit.file, use);
        if (!lib) continue;
        visit(lib, [...chain, lib]);
        order.push(lib);
      }
      if (!unit.uses.includes(lib)) unit.uses.push(lib);
      use.unit = lib;
    }
  }

  function loadOne(path, shown, isStd, from, use) {
    if (units.has(path)) return units.get(path);
    const text = read(path);
    if (text === null) {
      if (isStd) throw new Error(`the standard library is missing: ${path}`);
      diagnostics.add(KIND.LIBRARY, from, use.pathSpan, `use "${use.path}": there is no ${shown} beside the program`, [], "S104");
      return null;
    }
    const file = new SourceFile(shown, text);
    const tree = parse(file, diagnostics, "Library");
    if (!tree) return null;
    const unit = { file, tree, library: true, uses: [], std: isStd, path };
    units.set(path, unit);
    return unit;
  }

  if (std) {
    // The standard library uses nothing.
    for (const u of std.tree.items.filter((i) => i.kind === "use")) diagnostics.add(KIND.LIBRARY, std.file, u.span, "the standard library uses no other library", [], "S105");
  }
  visit(main, [main]);
  return { std, units: [...(std ? [std] : []), ...order], main };
}
