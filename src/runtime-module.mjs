// `stride runtime` (§17.19): the machine a host's page runs a compiled workflow with (runtime/module.mjs), bundled
// into one self-contained ES module. In the one executable it is built in (scripts/build.mjs); from the repository
// it is bundled when asked for.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* global STRIDE_RUNTIME */
const here = dirname(fileURLToPath(new URL(import.meta.url)));

// The module's code, without its first line (which runtimeModule adds, naming the build).
export async function runtimeBundle() {
  if (typeof STRIDE_RUNTIME !== "undefined") return STRIDE_RUNTIME;
  const { build } = await import("esbuild");
  const out = await build({ entryPoints: [join(here, "../runtime/module.mjs")], bundle: true, format: "esm", platform: "neutral", target: "es2022", write: false, logLevel: "silent" });
  return out.outputFiles[0].text;
}

// The module as `stride runtime` writes it: a first line saying what it is, and which build and bytecode it runs.
export async function runtimeModule({ language, build, bytecode }) {
  return `// Stride ${language} runtime (build ${build}), runs bytecode version ${bytecode}. Written by \`stride runtime\`; do not edit: write it again.\n${await runtimeBundle()}`;
}
