// rule 19.3 F016
// A box written by a name the program does not know.
import { assemble, OP } from "../../runtime/bytecode.mjs";

export const bytecode = assemble({
  texts: ["Nowhere", "x"],
  boxes: [{ name: "Here", kind: "fill" }],
  functions: [{ name: "main", code: [[OP.TEXT, 0], [OP.TEXT, 1], [OP.FILL_AT], [OP.HALT]] }],
});
export const fault = "F016";
