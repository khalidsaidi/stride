// rule 19.3 F006
// A field read on words: no type-correct program does it; the machine stops with F006.
import { assemble, OP } from "../../runtime/bytecode.mjs";

export const bytecode = assemble({
  texts: ["words"],
  records: [{ name: "r", fields: ["a"] }],
  functions: [{ name: "main", code: [[OP.TEXT, 0], [OP.GET_FIELD, 0], [OP.POP], [OP.HALT]] }],
});
export const fault = "F006";
