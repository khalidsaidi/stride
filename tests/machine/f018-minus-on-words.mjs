// rule 19.3 F018 7.8
// An operator given values it does not take: words minus a number.
import { assemble, OP } from "../../runtime/bytecode.mjs";

export const bytecode = assemble({
  texts: ["a"],
  numbers: ["1"],
  functions: [{ name: "main", code: [[OP.TEXT, 0], [OP.NUMBER, 0], [OP.SUB], [OP.POP], [OP.HALT]] }],
});
export const fault = "F018";
