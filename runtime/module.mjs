// What `stride runtime` writes (§17.19): Stride's virtual machine for a host's own page, as one ES module with no
// imports. A host loads a compiled program (.sbc) with load, runs it on the answers so far with run, and puts
// boxValues of the run's writes into the PDF's boxes. Each step of a run is a question the run reached, with what
// a page needs to show it: its key, its question (type, options with their printed words), its printed words,
// its default and what was said about its answer. How it is shown, and any words of the host's own around it, are
// the host's.
export { load, run, boxValues, convert, stringOf, faultWords, VERSION, BytecodeError } from "./vm.mjs";
