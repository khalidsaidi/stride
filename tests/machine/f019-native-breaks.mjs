// rule 19.3 F019
// A native given what it cannot work on stops the machine itself: F019, not a crash of the host.
import { assemble, OP } from "../../runtime/bytecode.mjs";

export const bytecode = assemble({
  texts: ["a"],
  natives: [{ name: "floor", params: 1 }],
  functions: [{ name: "main", code: [[OP.TEXT, 0], [OP.NATIVE, 0, 1], [OP.POP], [OP.HALT]] }],
});
export const fault = "F019";
