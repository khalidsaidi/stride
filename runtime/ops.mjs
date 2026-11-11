// What Stride's operators mean (docs/spec.md §6), on the values of runtime/values.mjs. The machine
// runs them on answers, and the compiler on a constant's value: one definition.
// An operator given empty where it needs a value is F023 (§6.3). One given values it does not take is F018: the
// checker refuses such a program, so reaching it is a compiler fault.
import { D, StrideFault, equal, order, truthy, StrideMap, isEmpty, isNumber, words, needed, kindOf } from "./values.mjs";

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

// Empty where the operator needs a value (§6.3): F023, naming the side.
function sides(op, a, b) {
  if (isEmpty(a)) needed(kindOf(b), `the left side of ${op}`);
  if (isEmpty(b)) needed(kindOf(a), `the right side of ${op}`);
}

export function binary(op, a, b) {
  switch (op) {
    case "+": {
      sides(op, a, b);
      // Lists join (§6.5.1).
      if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
      if (isNumber(a) && isNumber(b)) return numberOp(() => D.add(a, b));
      if (typeof a === "string" && typeof b === "string") return a + b;
      return noOp(op, a, b);
    }
    case "-":
    case "*":
    case "/":
    case "//":
    case "%": {
      sides(op, a, b);
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
      sides(op, a, b);
      const c = order(a, b);
      return op === "<" ? c < 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : c >= 0;
    }
    case "and":
      return truthy(a) && truthy(b);
    case "or":
      return truthy(a) || truthy(b);
    case "in":
    case "not in": {
      if (isEmpty(b)) needed("a list is", `the right side of ${op}`);
      let found;
      if (typeof b === "string") {
        if (isEmpty(a)) needed("words are", `the left side of ${op}`);
        found = b.includes(words(a));
      } else found = b instanceof StrideMap ? !isEmpty(a) && b.has(a) : Array.isArray(b) ? b.some((x) => equal(x, a)) : false;
      return op === "in" ? found : !found;
    }
    default:
      return noOp(op, a, b);
  }
}

export function unary(op, a) {
  if (op === "-") {
    if (isEmpty(a)) needed("a number is", "what - stands before");
    if (!isNumber(a)) return noOp(op, a, a);
    return D.neg(a);
  }
  if (op === "not") return !truthy(a);
  return noOp(op, a, a);
}

export { truthy, equal, words };
