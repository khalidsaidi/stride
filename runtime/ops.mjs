// What Stride's operators mean (docs/spec.md §6), on the values of runtime/values.mjs. The machine
// runs them on answers, and the compiler on a constant's value: one definition.
// An operator given values it does not take is
// F018: the checker refuses such a program, so reaching it is a compiler fault, never silently empty.
import { D, StrideFault, equal, order, truthy, StrideMap, isEmpty, isNumber, words } from "./values.mjs";


function numberOp(f) {
  try {
    return f();
  } catch (e) {
    if (e instanceof D.NumberFault) throw new StrideFault(e.code, e.message);
    throw e;
  }
}

function noOp(op, a, b) {
  throw new StrideFault("F018", `${op} was given values it does not take (${typeof a} and ${typeof b})`);
}

export function binary(op, a, b) {
  switch (op) {
    case "+": {
      // Lists join, always (§6.5.1).
      if (Array.isArray(a) || Array.isArray(b)) {
        const x = Array.isArray(a) ? a : [];
        const y = Array.isArray(b) ? b : [];
        return [...x, ...y];
      }
      // Numbers or words: empty gives the other (§6.3).
      if (isEmpty(a) && !Array.isArray(a)) return b === "" ? null : b;
      if (isEmpty(b)) return a;
      if (isNumber(a) && isNumber(b)) return numberOp(() => D.add(a, b));
      if (typeof a === "string" && typeof b === "string") {
        return a + b;
      }
      return noOp(op, a, b);
    }
    case "-":
    case "*":
    case "/":
    case "//":
    case "%": {
      if (isEmpty(a) || isEmpty(b)) return null;
      if (!isNumber(a) || !isNumber(b)) return noOp(op, a, b);
      const f = { "-": D.sub, "*": D.mul, "/": D.div, "//": D.floorDiv, "%": D.mod }[op];
      return numberOp(() => f(a, b));
    }
    case "==":
      return equal(a, b);
    case "!=":
      return !equal(a, b);
    case "<":
    case "<=":
    case ">":
    case ">=": {
      // A comparison with empty is no (§6.3).
      if (isEmpty(a) || isEmpty(b)) return false;
      const c = order(a, b);
      return op === "<" ? c < 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : c >= 0;
    }
    case "and":
      return truthy(a) && truthy(b);
    case "or":
      return truthy(a) || truthy(b);
    case "in":
      if (typeof b === "string") return b.includes(words(a));
      if (b instanceof StrideMap) return b.has(a);
      return Array.isArray(b) ? b.some((x) => equal(x, a)) : false;
    case "not in":
      return !binary("in", a, b);
    default:
      return noOp(op, a, b);
  }
}

export function unary(op, a) {
  if (op === "-") {
    if (isEmpty(a)) return null;
    if (!isNumber(a)) return noOp(op, a, a);
    return D.neg(a);
  }
  if (op === "not") return !truthy(a);
  return noOp(op, a, a);
}

export { truthy, equal, words };
