// Stride's values as the machine and the intermediate form's interpreter hold
// them (docs/spec.md §3). One definition, so a program means the same in every engine:
//
//   empty            null (every type's empty, §3.2; "" and a list or set with no items are empty too)
//   words            a string (text, long-text, phone, email, an option's value)
//   number           a Decimal (runtime/decimal.mjs): exact, 34 significant digits
//   date             a StrideDate: its day, written YYYY-MM-DD
//   yes-no           true, false
//   a set            an array of option values, always in the option set's declaration order (§3.8), marked as
//                    a set (`isSet`), the option set's values in `order`
//   a list           an array of its items
//   a record         a StrideRecord: its type's name and its fields in declaration order
//
// Lists and records are values (§3.4): every place takes a copy, never the same object.
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

// A record made where a place on the way to a field holds empty (§7.5.1): every field empty, a list field a list
// with no items, so an item can be set in it. `lists` tells, for each field, whether it is a list.
export const emptyRecord = (name, lists, names) => new StrideRecord(name, lists.map((l) => (l ? [] : null)), names);

export const isEmpty = (v) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || (v instanceof StrideMap && v.entries.size === 0);
export const isNumber = (v) => v instanceof D.Decimal;

// A map (§3.10): values under keys, in the order the keys were first given. A key is told from another by its
// words (the keys of one map are of one type).
export class StrideMap {
  constructor(pairs = []) {
    this.entries = new Map(); // a key's words -> [key, value]
    for (const [k, v] of pairs) this.set(k, v);
  }
  get(k) {
    return this.entries.get(words(k))?.[1] ?? null;
  }
  has(k) {
    return this.entries.has(words(k));
  }
  set(k, v) {
    if (isEmpty(k)) throw new StrideFault("F004", "a map's key is empty");
    const w = words(k);
    const was = this.entries.get(w);
    if (was) was[1] = v;
    else {
      this.entries.set(w, [k, v]);
    }
  }
  remove(k) {
    this.entries.delete(words(k));
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

// A deep copy: what a place receives (§3.4). Scalars are immutable and shared.
export function copy(v) {
  if (isSet(v)) return set([...v], v.order);
  if (Array.isArray(v)) return v.map(copy);
  if (v instanceof StrideRecord) return new StrideRecord(v.type, v.fields.map(copy), v.names);
  if (v instanceof StrideMap) return new StrideMap(v.pairs.map(([k, x]) => [k, copy(x)]));
  return v;
}

// A value's words (§3.5): what fill writes and {…} puts in. Lists and records have none (the checker refuses
// them); print uses printed() instead.
export function words(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (isNumber(v)) return D.words(v);
  if (isDate(v)) return v.iso;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) return v.map(words).join(", ");
  if (v instanceof StrideRecord) return v.fields.map(words).filter(Boolean).join(", ");
  if (v instanceof StrideFunction) return `function ${v.name}`;
  if (v instanceof StrideMap) return v.pairs.map(([k, x]) => `${words(k)}: ${words(x)}`).join(", ");
  return String(v);
}

// What print gives the host (§14.5): lists as [a, b], records as R { field: v, … } (field names from `names`).
export function printed(v, recordNames = () => null) {
  if (isSet(v)) return words(v);
  if (Array.isArray(v)) return `[${v.map((x) => printed(x, recordNames)).join(", ")}]`;
  if (v instanceof StrideRecord) {
    const names = v.names ?? recordNames(v.type) ?? v.fields.map((_, i) => `field${i + 1}`);
    return `${v.type} { ${v.fields.map((f, i) => `${names[i]}: ${printed(f, recordNames)}`).join(", ")} }`;
  }
  if (v instanceof StrideMap) return `{${v.pairs.map(([k, x]) => `${words(k)}: ${printed(x, recordNames)}`).join(", ")}}`;
  return words(v);
}

// Equality (§6.6): both empty, or neither and the same value; records field by field, lists item by item, sets as
// the same options.
export function equal(a, b) {
  if (isEmpty(a) || isEmpty(b)) return isEmpty(a) && isEmpty(b);
  if (isNumber(a) && isNumber(b)) return D.equal(a, b);
  if (isDate(a) && isDate(b)) return a.iso === b.iso;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (a instanceof StrideRecord && b instanceof StrideRecord) return a.type === b.type && a.fields.every((x, i) => equal(x, b.fields[i]));
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

// A condition (§6.15): yes is yes; no and empty are no.
export const truthy = (v) => v === true;

// A whole number from a value, for positions and bounds; null when it is not a whole number.
export const whole = (v) => (isNumber(v) ? D.toInt(v) : null);

// The items from to to of a list (§6.9.3), both whole: from below 0 counts from 0, to beyond the items stops at
// the last, from above to gives none.
export const sliced = (items, from, to) => items.slice(Math.max(0, from), Math.max(0, from, to + 1));

// The words of the fault for a whole position of 0 or more that names no item (§6.9.2).
export const outside = (i, held, ofWords = false) => `position ${words(i)} is outside the ${ofWords ? `words: they hold ${held} character${held === 1 ? "" : "s"}` : `list: it holds ${held}`}`;
export const num = (n) => D.fromInt(n);

// An expectation's result (§7.17): `faults` the code or words an `expect … faults` names (null for a plain
// expect), `value` and `message` what its expression and words gave, `fault` the fault it stopped on or null.
export function expectation(faults, value, message, fault) {
  if (faults === null) {
    if (fault) return { result: "fail", why: `it faulted: ${fault.code} ${fault.message}` };
    return truthy(value) ? { result: "pass" } : { result: "fail", why: words(message) || "it is not yes" };
  }
  if (!fault) return { result: "fail", why: `no fault; expected ${faults}` };
  const matches = /^F\d{3}$/.test(faults) ? fault.code === faults : fault.message.includes(faults);
  return matches ? { result: "pass" } : { result: "fail", why: `the fault was ${fault.code} ${fault.message}; expected ${faults}` };
}

// A question key's encoding of a known value (§8.6.3).
export function encode(v, recordNames = () => null) {
  if (isSet(v)) return `{${v.map((x) => encode(x)).join(",")}}`;
  if (Array.isArray(v)) return `[${v.map((x) => encode(x, recordNames)).join(",")}]`;
  if (v === null || v === undefined || v === "") return "empty";
  if (isNumber(v)) return D.words(v);
  if (isDate(v)) return v.iso;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (v instanceof StrideRecord) {
    const names = v.names ?? recordNames(v.type) ?? v.fields.map((_, i) => `field${i + 1}`);
    return `${v.type}{${v.fields.map((f, i) => `${names[i]}=${encode(f, recordNames)}`).join(";")}}`;
  }
  return JSON.stringify(v); // exactly the escaping §8.6.3 names
}
