// rule 18.3
// A field no record type has: the loader refuses it, every operand in range.
import { assemble, OP } from "../../runtime/bytecode.mjs";

export const bytecode = assemble({
  records: [{ name: "r", fields: ["a"] }],
  functions: [{ name: "main", code: [[OP.NEW_RECORD, 0], [OP.GET_FIELD, 99], [OP.POP], [OP.HALT]] }],
});
export const refused = "field out of range";
