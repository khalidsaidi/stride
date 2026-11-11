// What Stride's operators mean (docs/spec.md §6), on the values of runtime/values.mjs. The machine
// runs them on answers, and the compiler on a constant's value: one definition.
// An operator given null where it needs a value is F023 (§6.3). One given values it does not take is F018: the
// checker refuses such a program, so reaching it is a compiler fault.
import { D, StrideFault, equal, order, truthy, StrideMap, StrideRange, isNull, isNumber, isDate, words, needed, kindOf, range, dayNumber, fromDayNumber } from "./values.mjs";

function numberOp(f) {
  try {
    return f();
  } catch (e) {
    if (e instanceof D.NumberFault) throw new StrideFault(e.code, e.message);
    throw e;
  }
}

// n to the power k (§6.4.2), k a whole number from -10000 to 10000 (F008): n multiplied by itself k times, 1 over
// that for k below 0. `name`: what the fault calls it.
export function power(n, k, name = "**") {
  const times = D.toInt(k);
  if (times === null || Math.abs(times) > 10_000) throw new StrideFault("F008", `${name}: the power is a whole number from -10000 to 10000, and this is ${words(k)}`);
  return numberOp(() => {
    let out = D.fromInt(1);
    let base = n;
    for (let e = Math.abs(times); e > 0; e = Math.floor(e / 2)) {
      if (e % 2) out = D.mul(out, base);
      if (e > 1) base = D.mul(base, base);
    }
    return times < 0 ? D.div(D.fromInt(1), out) : out;
  });
}

// The day n days after d (§6.4.3), n a whole number (F004), the day one of 0001-01-01 to 9999-12-31 (F011).
// `name`: what the fault calls it.
export function addDays(d, n, name) {
  if (!D.isWhole(n)) throw new StrideFault("F004", `${name}: a date moves by a whole number of days, and this is ${words(n)}`);
  const k = D.toInt(n);
  const out = k === null || Math.abs(k) > 4_000_000 ? null : fromDayNumber(dayNumber(d) + k);
  if (!out) throw new StrideFault("F011", `${name}: the day falls outside 0001-01-01 to 9999-12-31`);
  return out;
}

function noOp(op, a, b) {
  throw new StrideFault("F018", `${op} was given values it does not take (${typeof a} and ${typeof b})`);
}

// Empty where the operator needs a value (§6.3): F023, naming the side.
function sides(op, a, b) {
  if (isNull(a)) needed(kindOf(b), `the left side of ${op}`);
  if (isNull(b)) needed(kindOf(a), `the right side of ${op}`);
}

export function binary(op, a, b) {
  switch (op) {
    case "+": {
      sides(op, a, b);
      // Lists join (§6.5.1).
      if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
      if (isNumber(a) && isNumber(b)) return numberOp(() => D.add(a, b));
      if (typeof a === "string" && typeof b === "string") return a + b;
      // A date and a number of days (§6.4.3).
      if (isDate(a) && isNumber(b)) return addDays(a, b, "date + n");
      return noOp(op, a, b);
    }
    case "**":
      sides(op, a, b);
      if (!isNumber(a) || !isNumber(b)) return noOp(op, a, b);
      return power(a, b);
    case "..":
    case "..<":
      return range(a, b, op === "..<");
    case "-":
    case "*":
    case "/":
    case "//":
    case "%": {
      sides(op, a, b);
      // A date less a number of days, and the days from one date to another (§6.4.3).
      if (op === "-" && isDate(a) && isNumber(b)) return addDays(a, D.neg(b), "date - n");
      if (op === "-" && isDate(a) && isDate(b)) return D.fromInt(dayNumber(a) - dayNumber(b));
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
      if (isNull(b)) needed("a list is", `the right side of ${op}`);
      let found;
      if (typeof b === "string") {
        if (isNull(a)) needed("words are", `the left side of ${op}`);
        found = b.includes(words(a));
      } else if (b instanceof StrideRange) found = b.has(a);
      else found = b instanceof StrideMap ? !isNull(a) && b.has(a) : Array.isArray(b) ? b.some((x) => equal(x, a)) : false;
      return op === "in" ? found : !found;
    }
    default:
      return noOp(op, a, b);
  }
}

export function unary(op, a) {
  if (op === "-") {
    if (isNull(a)) needed("a number is", "what - stands before");
    if (!isNumber(a)) return noOp(op, a, a);
    return D.neg(a);
  }
  if (op === "not") return !truthy(a);
  return noOp(op, a, a);
}

export { truthy, equal, words };
