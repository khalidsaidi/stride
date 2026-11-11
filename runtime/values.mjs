// Stride's values as the machine and the intermediate form's interpreter hold
// them (docs/spec.md §3). One definition, so a program means the same in every engine:
//
//   null             null: no value (§3.2); "" and a list, set or map that holds nothing are values, not null
//   words            a string (a string, long_text, phone or email answer, an option's value)
//   number           a Decimal (runtime/decimal.mjs): exact, 34 significant digits
//   date             a StrideDate: its day, written YYYY-MM-DD
//   bool             true, false
//   a set            an array of option values, always in the option set's declaration order (§3.8), marked as
//                    a set (`isSet`), the option set's values in `order`
//   a list           an array of its items
//   a record         a StrideRecord: its type's name and its fields in declaration order
//
// A list, a record and a map are shared (§3.4): every name, field and item that holds one holds the same object.
// The other values are never changed.
import * as D from "./decimal.mjs";

export { D };

// A fault a program's run stops on (§13.4): its code, its message.
export class StrideFault extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// A day of the Gregorian calendar, 0001-01-01 to 9999-12-31 (§3.1).
export class StrideDate {
  constructor(y, m, d) {
    this.y = y;
    this.m = m;
    this.d = d;
  }

  toJSON() {
    return this.iso;
  }

    get iso() {
    return `${String(this.y).padStart(4, "0")}-${String(this.m).padStart(2, "0")}-${String(this.d).padStart(2, "0")}`;
  }
}
const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const daysIn = (y, m) => [31, leap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
// A date from its parts, or null when there is no such day in 0001–9999.
export function date(y, m, d) {
  if (![y, m, d].every(Number.isInteger) || y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > daysIn(y, m)) return null;
  return new StrideDate(y, m, d);
}
// A date from YYYY-MM-DD, or null.
export function dateFrom(s) {
  // Exactly YYYY-MM-DD (§8.7): nothing around it.
  const m = typeof s === "string" ? s.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  return m ? date(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}
export const isDate = (v) => v instanceof StrideDate;

// A set of options: the values chosen, in `order` (the option set's values, in declaration order).
export function set(values, order) {
  const out = order.filter((o) => values.includes(o));
  out.isSet = true;
  out.order = order;
  return out;
}
export const isSet = (v) => Array.isArray(v) && v.isSet === true;

export class StrideRecord {
  constructor(type, fields, names = null) {
    this.type = type; // the record's name
    this.fields = fields; // in the order the record declares them
    this.names = names; // the fields' names: two files may each declare a record of one name (§14.5)
  }
}

// An error value (§3.11): a code and a message, which never change. `origin` is the fault it was caught as, with
// its place and the calls that led there, so that the error thrown again is the same fault; null for one a
// program made.
export class StrideError extends StrideRecord {
  constructor(code, message, origin = null) {
    super("error", [code, message], ["code", "message"]);
    this.origin = origin;
  }
  get code() {
    return this.fields[0];
  }
  get message() {
    return this.fields[1];
  }
}

// A record made where a place on the way to a field holds null (§7.5.1), as `new R { }` makes it (§6.14): every
// field null, but a list field a list with no items and a map field a map with no keys. `starts` tells, for each
// field, which: "list", "map" or null.
export const emptyRecord = (name, starts, names) => new StrideRecord(name, starts.map((k) => (k === "list" ? [] : k === "map" ? new StrideMap() : null)), names);

export const isNull = (v) => v === null || v === undefined;

// The fault of null standing where a value is needed (§6.3): the kind of value needed, and what was null.
export function needed(kind, what) {
  throw new StrideFault("F023", `null where ${kind} needed: ${what}`);
}
// The kind of value an operation needs, told by the value beside the null one.
export const kindOf = (v) => (isNumber(v) ? "a number is" : typeof v === "string" ? "words are" : isDate(v) ? "a date is" : isSet(v) ? "a set is" : Array.isArray(v) ? "a list is" : v instanceof StrideMap ? "a map is" : v instanceof StrideRecord ? "a record is" : "a value is");
export const isNumber = (v) => v instanceof D.Decimal;

// A map (§3.10): values under keys, in the order the keys were first given. A key is told from another by its
// words (the keys of one map are of one type).
export class StrideMap {
  constructor(pairs = []) {
    this.entries = new Map(); // a key's words -> [key, value]
    for (const [k, v] of pairs) this.set(k, v);
  }
  get(k) {
    return isNull(k) ? null : this.entries.get(words(k))?.[1] ?? null;
  }
  has(k) {
    return !isNull(k) && this.entries.has(words(k));
  }
  set(k, v) {
    if (isNull(k)) needed("a key is", "the key a value is put under");
    const w = words(k);
    const was = this.entries.get(w);
    if (was) was[1] = v;
    else {
      this.entries.set(w, [k, v]);
    }
  }
  remove(k) {
    if (!isNull(k)) this.entries.delete(words(k));
  }
  get pairs() {
    return [...this.entries.values()];
  }
  toJSON() {
    return Object.fromEntries(this.pairs.map(([k, v]) => [words(k), v]));
  }
}

// A var shared by the code that declares it and the functions made in place that use it (§9.11).
export class Cell {
  constructor(v) {
    this.v = v;
  }
  toJSON() {
    return this.v;
  }
}

// A function as a value (§9.10): its name, and what an engine calls it by.
export class StrideFunction {
  constructor(name, target, kept = []) {
    this.name = name;
    this.target = target;
    this.kept = kept; // what a function made in place keeps (§9.11)
  }
  toJSON() {
    return `function ${this.name}`;
  }
}

// What copy(x) gives (§3.4.2): a list, a record or a map made anew, with everything inside it copied too; any
// other value itself. What is held twice inside x is one copy held twice (`made`: each object's copy), so a record
// that holds itself is copied as one that holds itself. `whole`: what a function value keeps and the vars it shares
// are copied too, for an expectation's sub-run (§7.17.1).
export function copy(v, made = new Map(), whole = false) {
  if (isSet(v) || v instanceof StrideError || !(Array.isArray(v) || v instanceof StrideRecord || v instanceof StrideMap || (whole && (v instanceof StrideFunction || v instanceof Cell)))) return v;
  if (made.has(v)) return made.get(v);
  if (v instanceof Cell) {
    const out = new Cell(null);
    made.set(v, out);
    out.v = copy(v.v, made, whole);
    return out;
  }
  if (v instanceof StrideFunction) {
    const out = new StrideFunction(v.name, v.target, []);
    made.set(v, out);
    for (const x of v.kept) out.kept.push(copy(x, made, whole));
    return out;
  }
  if (Array.isArray(v)) {
    const out = [];
    made.set(v, out);
    for (const x of v) out.push(copy(x, made, whole));
    return out;
  }
  if (v instanceof StrideRecord) {
    const out = new StrideRecord(v.type, [], v.names);
    made.set(v, out);
    for (const x of v.fields) out.fields.push(copy(x, made, whole));
    return out;
  }
  const out = new StrideMap();
  made.set(v, out);
  for (const [k, x] of v.pairs) out.set(k, copy(x, made, whole));
  return out;
}

// Whether a value holds itself (§3.4.6): a tool that shows values says so, and does not follow it.
export function holdsItself(v, path = new Set()) {
  if (isSet(v) || v instanceof StrideError || !(Array.isArray(v) || v instanceof StrideRecord || v instanceof StrideMap)) return false;
  if (path.has(v)) return true;
  path.add(v);
  const found = (Array.isArray(v) ? v : v instanceof StrideRecord ? v.fields : v.pairs.map(([, x]) => x)).some((x) => holdsItself(x, path));
  path.delete(v);
  return found;
}

// The records being put into words, printed, compared or encoded now. One met inside itself (§3.4.6) is F024:
// what holds itself has no words and no end to compare.
const open = new Set();
function inside(r, work) {
  if (open.has(r)) throw new StrideFault("F024", `a ${r.type} holds itself, so it has no words and cannot be printed or compared`);
  open.add(r);
  try {
    return work();
  } finally {
    open.delete(r);
  }
}

// A value's words (§3.5): what fill writes and {…} puts in. Lists and records have none (the checker refuses
// them); print uses printed() instead.
export function words(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (isNumber(v)) return D.words(v);
  if (isDate(v)) return v.iso;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return v.map(words).join(", ");
  if (v instanceof StrideError) return v.message;
  if (v instanceof StrideRecord) return inside(v, () => v.fields.map(words).filter(Boolean).join(", "));
  if (v instanceof StrideFunction) return `function ${v.name}`;
  if (v instanceof StrideMap) return v.pairs.map(([k, x]) => `${words(k)}: ${words(x)}`).join(", ");
  return String(v);
}

// What print gives the host (§14.5): lists as [a, b], records as R { field: v, … } (field names from `names`).
export function printed(v, recordNames = () => null) {
  if (isSet(v) || v instanceof StrideError) return words(v);
  if (Array.isArray(v)) return `[${v.map((x) => printed(x, recordNames)).join(", ")}]`;
  if (v instanceof StrideRecord) {
    const names = v.names ?? recordNames(v.type) ?? v.fields.map((_, i) => `field${i + 1}`);
    return inside(v, () => `${v.type} { ${v.fields.map((f, i) => `${names[i]}: ${printed(f, recordNames)}`).join(", ")} }`);
  }
  if (v instanceof StrideMap) return `{${v.pairs.map(([k, x]) => `${words(k)}: ${printed(x, recordNames)}`).join(", ")}}`;
  return words(v);
}

// Equality (§6.6): both null, or neither and the same value; records field by field, lists item by item, sets as
// the same options.
export function equal(a, b) {
  if (isNull(a) || isNull(b)) return isNull(a) && isNull(b);
  if (a === b) return true;
  if (isNumber(a) && isNumber(b)) return D.equal(a, b);
  if (isDate(a) && isDate(b)) return a.iso === b.iso;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (a instanceof StrideRecord && b instanceof StrideRecord) return a.type === b.type && inside(a, () => a.fields.every((x, i) => equal(x, b.fields[i])));
  if (a instanceof StrideMap && b instanceof StrideMap) return a.entries.size === b.entries.size && a.pairs.every(([k, x]) => b.has(k) && equal(x, b.get(k)));
  if (a instanceof StrideFunction && b instanceof StrideFunction) return a.target === b.target && a.kept.length === b.kept.length && a.kept.every((k, i) => equal(k, b.kept[i]));
  return a === b;
}

// Order (§6.7): numbers by value, dates by day, words by code points; -1, 0 or 1. Only ordered values reach it.
export function order(a, b) {
  if (isNumber(a) && isNumber(b)) return D.compare(a, b);
  if (isDate(a) && isDate(b)) return a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0;
  if (typeof a === "string" && typeof b === "string") {
    const x = [...a];
    const y = [...b];
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const p = x[i].codePointAt(0);
      const q = y[i].codePointAt(0);
      if (p !== q) return p < q ? -1 : 1;
    }
    return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
  }
  throw new StrideFault("F018", "an order was asked of values that have none");
}

// A condition (§6.15): true is true; false and null are false.
export const truthy = (v) => v === true;

// A whole number from a value, for positions and bounds; null when it is not a whole number.
export const whole = (v) => (isNumber(v) ? D.toInt(v) : null);

// The items from to to of a list (§6.9.3), both whole: from below 0 counts from 0, to beyond the items stops at
// the last, from above to gives none.
export const sliced = (items, from, to) => items.slice(Math.max(0, from), Math.max(0, from, to + 1));

// A slice's bounds (§6.9.3), both whole (F004), of a list or words that are there (F023).
export function sliceBounds(l, a, b) {
  if (isNull(l)) needed("a list is", "what [ .. ] takes items of");
  if (isNull(a) || isNull(b)) needed("a number is", "a bound of [ .. ]");
  const x = whole(a), y = whole(b);
  if (x === null || y === null) throw new StrideFault("F004", "a slice's bounds are whole numbers");
  return [x, y];
}

// A position read (§6.9.2): of a list or words that are there (F023), a whole number of 0 or more (F004).
export function readPosition(l, i) {
  if (isNull(l)) needed("a list is", "what [ ] takes an item of");
  if (isNull(i)) needed("a number is", "the position in [ ]");
  const n = whole(i);
  if (n === null || n < 0) throw new StrideFault("F004", `position ${words(i)} is not a whole number of 0 or more`);
  return n;
}

// The words of the fault for a whole position of 0 or more that names no item (§6.9.2).
export const outside = (i, held, ofWords = false) => `position ${words(i)} is outside the ${ofWords ? `words: they hold ${held} character${held === 1 ? "" : "s"}` : `list: it holds ${held}`}`;
export const num = (n) => D.fromInt(n);

// An expectation's result (§7.17): `faults` the code or words an `expect … faults` names (null for a plain
// expect), `value` and `message` what its expression and words gave, `fault` the fault it stopped on or null.
export function expectation(faults, value, message, fault) {
  if (faults === null) {
    if (fault) return { result: "fail", why: `it faulted: ${fault.code} ${fault.message}` };
    return truthy(value) ? { result: "pass" } : { result: "fail", why: words(message) || "it is not true" };
  }
  if (!fault) return { result: "fail", why: `no fault; expected ${faults}` };
  // A program's own code (§7.19) is matched whole, as a fault's is.
  const matches = /^F\d{3}$/.test(faults) ? fault.code === faults : fault.code === faults || fault.message.includes(faults);
  return matches ? { result: "pass" } : { result: "fail", why: `the fault was ${fault.code} ${fault.message}; expected ${faults}` };
}

// A question key's encoding of a known value (§8.6.3).
export function encode(v, recordNames = () => null) {
  if (isSet(v)) return `{${v.map((x) => encode(x)).join(",")}}`;
  if (Array.isArray(v)) return `[${v.map((x) => encode(x, recordNames)).join(",")}]`;
  if (v === null || v === undefined) return "null";
  if (isNumber(v)) return D.words(v);
  if (isDate(v)) return v.iso;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof StrideRecord) {
    const names = v.names ?? recordNames(v.type) ?? v.fields.map((_, i) => `field${i + 1}`);
    return inside(v, () => `${v.type}{${v.fields.map((f, i) => `${names[i]}=${encode(f, recordNames)}`).join(";")}}`);
  }
  return JSON.stringify(v); // exactly the escaping §8.6.3 names
}
