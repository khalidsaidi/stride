// rule 19.3 F019
// A field another record type has, read on a record that has fewer: the machine stops itself with F019.
import { assemble, OP } from "../../runtime/bytecode.mjs";

export const bytecode = assemble({
  records: [{ name: "r", fields: ["a"] }, { name: "s", fields: ["a", "b"] }],
  functions: [{ name: "main", code: [[OP.NEW_RECORD, 0], [OP.GET_FIELD, 1], [OP.POP], [OP.HALT]] }],
});
export const fault = "F019";
