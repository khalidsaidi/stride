// rule 18.3
// The program halting with a value left on the stack: the loader refuses it, nothing left at a return.
import { assemble, OP } from "../../runtime/bytecode.mjs";

export const bytecode = assemble({
  functions: [{ name: "main", code: [[OP.TRUE], [OP.HALT]] }],
});
export const refused = "leaves 1 values";
