// Stride's types, as the compiler sees them. A type is a plain object { t, … }:
//
//   text                             words (a long-text, phone or email question's answer is text too)
//   number, date, yes-no             a number, a day, yes or no
//   option(set)                      one option of an option set
//   options(set)                     several options of one set (an any-of answer)
//   record(decl)                     a record's named fields
//   list(element, most)              up to `most` values of one type
//   empty                            the type of `empty`: fits every type
//   any                              only in a native function's parameters: takes any value
//   none                             what a function with no result gives
//   error                            a mistake was already reported here; fits everything, so one mistake
//                                    is reported once and not again at every use
//
// Every value of every type may also be empty (an answer not given yet); `is empty` tells.

export const TEXT = { t: "text" };
export const NUMBER = { t: "number" };
export const DATE = { t: "date" };
export const YES_NO = { t: "yes-no" };
export const EMPTY = { t: "empty" };
export const ANY = { t: "any" };
// Only as a native's result: the type of the items of the list (or the options of the set) given first.
export const ELEMENT = { t: "element" };
export const NONE = { t: "none" };
export const ERROR = { t: "error" };

export const SCALARS = { text: TEXT, number: NUMBER, date: DATE, "yes-no": YES_NO };

export const option = (set) => ({ t: "option", set });
export const options = (set) => ({ t: "options", set });
export const record = (decl) => ({ t: "record", decl });
export const list = (element, most) => ({ t: "list", element, most });
// map of K to V: values of one type, each under its own key (§3.10).
export const map = (key, value) => ({ t: "map", key, value });
// A function as a value (§9.10): what it takes and what it gives.
export const fn = (params, result) => ({ t: "function", params, result });
// A type parameter of a generic function: whatever type each call gives it.
export const typevar = (sym) => ({ t: "typevar", sym });

export const isTextLike = (type) => type.t === "text";
export const isError = (type) => type.t === "error";

// The question types an `ask` can have, and the type of its answer.
export const QUESTION_TYPES = ["text", "long-text", "number", "date", "phone", "email", "yes-no", "one-of", "any-of"];

// The same type.
export function same(a, b) {
  if (a.t !== b.t) return false;
  switch (a.t) {
    case "option":
    case "options":
      return a.set === b.set;
    case "record":
      return a.decl === b.decl;
    case "list":
      return same(a.element, b.element);
    case "map":
      return same(a.key, b.key) && same(a.value, b.value);
    case "function":
      return a.params.length === b.params.length && a.params.every((p, i) => same(p, b.params[i])) && same(a.result, b.result);
    case "typevar":
      return a.sym === b.sym;
    default:
      return true;
  }
}

// Whether `value` can stand for `param` in a call, with the type parameters bound so far (and bound here): T in
// list of T takes the element type of the list given.
export function unify(param, value, bindings) {
  if (param.t === "typevar") {
    if (value.t === "empty" || value.t === "error") return true;
    const bound = bindings.get(param.sym);
    if (!bound) {
      bindings.set(param.sym, value);
      return true;
    }
    if (fits(value, bound)) return true;
    if (fits(bound, value)) {
      bindings.set(param.sym, value);
      return true;
    }
    return false;
  }
  if (param.t === "list" && value.t === "list") return value.element.t === "empty" || unify(param.element, value.element, bindings);
  if (param.t === "map" && value.t === "map") return (value.key.t === "empty" || unify(param.key, value.key, bindings)) && (value.value.t === "empty" || unify(param.value, value.value, bindings));
  return fits(value, substitute(param, bindings));
}

// A type with its type parameters replaced by what a call bound them to.
export function substitute(type, bindings) {
  if (type.t === "typevar") return bindings.get(type.sym) ?? type;
  if (type.t === "list") return list(substitute(type.element, bindings), type.most);
  if (type.t === "map") return map(substitute(type.key, bindings), substitute(type.value, bindings));
  return type;
}

export const hasTypevar = (type) => type.t === "typevar" || (type.t === "list" && hasTypevar(type.element)) || (type.t === "map" && (hasTypevar(type.key) || hasTypevar(type.value)));
export const typevarIn = (type, sym) => (type.t === "typevar" ? type.sym === sym : type.t === "map" ? typevarIn(type.key, sym) || typevarIn(type.value, sym) : type.t === "list" && typevarIn(type.element, sym));

// Whether a value of type `value` can stand where `wanted` is wanted.
export function fits(value, wanted) {
  if (isError(value) || isError(wanted)) return true;
  if (wanted.t === "any") return value.t !== "none";
  if (value.t === "empty") return wanted.t !== "none";
  if (wanted.t === "text") return isTextLike(value) || value.t === "option";
  if (wanted.t === "list" && value.t === "list") {
    // A list fits a list of the same element type. How many it holds is checked where it is placed, as the
    // program runs (§3.7.7, F017).
    return value.element.t === "empty" || fits(value.element, wanted.element);
  }
  if (wanted.t === "map" && value.t === "map") return (value.key.t === "empty" || fits(value.key, wanted.key)) && (value.value.t === "empty" || fits(value.value, wanted.value));
  return same(value, wanted);
}

// Whether two values can be compared with == and !=.
export function comparable(a, b) {
  if (isError(a) || isError(b) || a.t === "empty" || b.t === "empty") return true;
  if (isTextLike(a) && isTextLike(b)) return true;
  if (a.t === "option" && isTextLike(b)) return true; // kind == "individual": checked against the set's options
  if (b.t === "option" && isTextLike(a)) return true;
  // Options of different sets compare by their words (§6.6), as they order (§6.7).
  if (a.t === "option" && b.t === "option") return true;
  // Records of one type, sets of one option set: by value; lists whose element types join (§3.9), whatever their
  // mosts (§6.6).
  if (a.t === "list" && b.t === "list") return a.element.t === "empty" || b.element.t === "empty" || join(a.element, b.element) !== null;
  if (a.t === "map" && b.t === "map") return join(a, b) !== null;
  return same(a, b);
}

// Whether a value can be ordered with < <= > >=.
// Whether two values can be ordered (§6.7): two numbers, two dates, two words.
export const ordered = (a, b) => {
  if (isError(a) || isError(b)) return true;
  if (a.t === "number" && b.t === "number") return true;
  if (a.t === "date" && b.t === "date") return true;
  // Words of any kind, an option's among them, order by code points (§6.7).
  const wordy = (t) => isTextLike(t) || t.t === "option";
  return wordy(a) && wordy(b);
};

// Whether a value can go into a box with `fill`: words, a number, a date, an option.
export const fillable = (type) => isTextLike(type) || ["number", "date", "option", "empty", "error"].includes(type.t);

// A type in words, for a mistake: "text", "a list of representative (at most 4)", "one of acts".
export function describe(type) {
  switch (type.t) {
    case "option":
      return type.set.anonymous ? `one of ${type.set.options.map((o) => `"${o.value}"`).join(", ")}` : `one of ${type.set.name}`;
    case "options":
      return type.set.anonymous ? "several options" : `set of ${type.set.name}`;
    case "record":
      return type.decl.name;
    case "list":
      return type.most >= 1000 ? `a list of ${describe(type.element)}` : `a list of ${describe(type.element)} (at most ${type.most})`;
    case "map":
      return `a map of ${describe(type.key)} to ${describe(type.value)}`;
    case "function":
      return `a function (${type.params.map(describe).join(", ")})${type.result.t === "none" ? "" : ` -> ${describe(type.result)}`}`;
    case "typevar":
      return type.sym.name;
    case "empty":
      return "empty";
    case "none":
      return "nothing (the function gives no value)";
    case "error":
      return "(a type already reported)";
    default:
      return type.t;
  }
}

// The type written in the source: `text`, `list of representative most 4`, `set of acts`.
export function typeOfAnswer(question, set) {
  if (question === "one-of") return option(set);
  if (question === "any-of") return options(set);
  // long-text, phone and email are ways of asking: the answer is text.
  return SCALARS[question] ?? TEXT;
}

// The join of two types (docs/spec.md §3.9): the one type two values take together, or null when they
// have none. The same both ways round; never a narrower kind of words; lists by their elements, with the larger
// most at every level.
export function join(a, b) {
  if (isError(a) || isError(b)) return ERROR;
  if (a.t === "empty") return b;
  if (b.t === "empty") return a;
  if (same(a, b) && a.t !== "list" && a.t !== "map") return a;
  if (a.t === "map" && b.t === "map") {
    const k = join(a.key, b.key), v = join(a.value, b.value);
    return k && v ? map(k, v) : null;
  }
  const wordy = (t) => isTextLike(t) || t.t === "option";
  if (wordy(a) && wordy(b)) return TEXT;
  if (a.t === "list" && b.t === "list") {
    const e = join(a.element, b.element);
    return e ? list(e, Math.max(a.most, b.most)) : null;
  }
  return null;
}

// Types that can be ordered (§6.7): numbers, dates, words.
export const orderable = (t) => isError(t) || t.t === "number" || t.t === "date" || isTextLike(t) || t.t === "option";
