// The functions of Stride's standard library that the machine provides, the natives (docs/spec.md §14). The
// standard library (lib/std.stride) declares each with its parameters, defaults and result; the
// compiler checks calls against those declarations and runs a pure native on values it already knows, and the
// machine runs it on the person's answers: the same function. Values are those of runtime/values.mjs.
//
// A native checks its control arguments first — positions, places, widths, paddings, patterns — and faults when one
// is wrong, whether or not its main argument is empty (§14.0.3.1); only then does an empty main argument give its
// empty result (§14.0.3). A value a person gives never faults; a program's own mistake that the compiler cannot see
// does.
import { D, StrideFault, StrideRecord, StrideMap, NO_MOST, copy, StrideDate, isEmpty, isNumber, isDate, isSet, words, equal, order, list, mostOf, set, date, dateFrom, daysIn, num, whole } from "./values.mjs";

export { StrideFault, StrideRecord, isEmpty };
export const textOf = words;

const MAX_WORDS = 100_000;
const chars = (t) => [...(t ?? "")];
const text = (t) => (t === null || t === undefined ? "" : typeof t === "string" ? t : words(t));
const result = (s) => {
  if (chars(s).length > MAX_WORDS) throw new StrideFault("F012", `the words would be more than ${MAX_WORDS} characters`);
  return s === "" ? null : s;
};

// A position (§14.0.4): a whole number of 1 or more, else F007, empty included. One past every text there can be
// (beyond JavaScript's safe whole numbers too) is a position all the same: past the end.
function position(name, v) {
  if (!isNumber(v) || !D.isWhole(v) || D.sign(v) < 1) throw new StrideFault("F007", `${name}: a position is a whole number of 1 or more, and this is ${isEmpty(v) ? "empty" : words(v)}`);
  return whole(v) ?? Infinity;
}
// Places (§14.2): a whole number 0–10, else F008.
function places(name, v) {
  const n = whole(v);
  if (n === null || n < 0 || n > 10) throw new StrideFault("F008", `${name}: places are a whole number from 0 to 10, and this is ${isEmpty(v) ? "empty" : words(v)}`);
  return n;
}

// Separators left out by chars and character: spaces, dashes, slashes and dots.
const SEPARATORS = /[ \-–—/.]/gu; // spaces, -, –, —, / and . (§14.1); not tabs, line ends or other spaces
const compact = (t) => text(t).replace(SEPARATORS, "");

// Trimmed (§14.1): spaces and tabs off both ends, as trim takes them off; no other space.
const trimmed = (s) => s.replace(/^[ \t]+|[ \t]+$/g, "");

// Lines end at \n, \r\n or \r.
const lines = (t) => text(t).split(/\r\n|\r|\n/);

// Today: the date the host fixes for a run (a test does), else the device's own (§13.3).
let fixedToday = null;
export function setToday(d) {
  fixedToday = d ? dateFrom(d) : null;
}
function todayDate() {
  if (fixedToday) return fixedToday;
  const t = new Date();
  return date(t.getFullYear(), t.getMonth() + 1, t.getDate());
}

// Where print's words go: the engine sets it for each run (§13.1).
let printer = () => {};
// How many times each call that can reach questions has been made in this run, by its key (§8.6.2).
let callCounts = new Map();
export function resetCalls() {
  callCounts = new Map();
}

export function setPrinter(f) {
  printer = f ?? (() => {});
}

// Days since 0001-01-01, for date arithmetic.
function dayNumber(d) {
  const y = d.y - 1;
  const days = y * 365 + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400);
  let n = days;
  for (let m = 1; m < d.m; m++) n += daysIn(d.y, m);
  return n + d.d - 1;
}
function fromDayNumber(n) {
  // Walk years by 400-year cycles of 146097 days, then by years and months.
  let y = 1 + 400 * Math.floor(n / 146097);
  n %= 146097;
  for (;;) {
    const len = daysIn(y, 2) === 29 ? 366 : 365;
    if (n < len) break;
    n -= len;
    y++;
  }
  let m = 1;
  while (n >= daysIn(y, m)) (n -= daysIn(y, m)), m++;
  return date(y, m, n + 1);
}

// years_between (§14.3): anniversaries of from on or before to; an anniversary on a day the year lacks falls on the
// month's last day; reversed, minus the forward count.
function yearsBetween(a, b) {
  if (order(a.iso, b.iso) > 0) return -yearsBetween(b, a);
  let years = b.y - a.y;
  const day = Math.min(a.d, daysIn(b.y, a.m));
  if (b.m < a.m || (b.m === a.m && b.d < day)) years--;
  return years;
}

const asList = (l) => (Array.isArray(l) ? l : isEmpty(l) ? [] : [l]);
const listLike = (items, of) => (isSet(of) ? set(items, of.order) : list(items, mostOf(of)));

// The sort of §14.4: stable, empty last, ascending or descending.
function sortItems(l, key, descending) {
  const items = asList(l).map((v, i) => ({ v, k: key(v), i }));
  items.sort((x, y) => {
    const ex = isEmpty(x.k), ey = isEmpty(y.k);
    if (ex || ey) return ex === ey ? x.i - y.i : ex ? 1 : -1;
    const c = order(x.k, y.k);
    return c === 0 ? x.i - y.i : descending ? -c : c;
  });
  return list(items.map((x) => x.v), mostOf(l));
}

// Each native: its function, whether it is pure (only a pure native is worked out by the compiler, in a constant), and
// whether its call is a statement (no result). `control`: the arguments it checks before anything else (§14.0.3.1),
// so a wrong one faults whatever the others hold.
export const NATIVES = {
  // ----- words (§14.1)
  upper: { pure: true, fn: (t) => result(text(t).toUpperCase()) },
  lower: { pure: true, fn: (t) => result(text(t).toLowerCase()) },
  // Words split on spaces, - and ' (§14.1), not on tabs or line ends.
  title: { pure: true, fn: (t) => result(text(t).toLowerCase().replace(/(^|[ \-'])(\p{L})/gu, (m, sep, c) => sep + c.toUpperCase())) },
  capitalize: { pure: true, fn: (t) => { const c = chars(text(t)); return result(c.length ? c[0].toUpperCase() + c.slice(1).join("") : ""); } },
  trim: { pure: true, fn: (t) => result(text(t).replace(/^[ \t]+|[ \t]+$/g, "").replace(/[ \t]+/g, " ")) },
  trim_start: { pure: true, fn: (t) => result(text(t).replace(/^[ \t]+/, "")) },
  trim_end: { pure: true, fn: (t) => result(text(t).replace(/[ \t]+$/, "")) },
  remove_prefix: { pure: true, fn: (t, p) => result(text(p) && text(t).startsWith(text(p)) ? text(t).slice(text(p).length) : text(t)) },
  remove_suffix: { pure: true, fn: (t, s) => result(text(s) && text(t).endsWith(text(s)) ? text(t).slice(0, text(t).length - text(s).length) : text(t)) },
  length: { pure: true, fn: (t) => num(chars(text(t)).length) },
  chars: {
    pure: true,
    control: [1, 2],
    fn: (t, from, to) => {
      const f = position("chars", from), e = position("chars", to);
      return result(e < f ? "" : chars(compact(t)).slice(f - 1, e).join(""));
    },
  },
  character: { pure: true, control: [1], fn: (t, n) => { const i = position("character", n); return result(chars(compact(t))[i - 1] ?? ""); } },
  slice: {
    pure: true,
    control: [1, 2],
    fn: (t, from, to) => {
      const f = position("slice", from), e = position("slice", to);
      return result(e < f ? "" : chars(text(t)).slice(f - 1, e).join(""));
    },
  },
  digits: { pure: true, fn: (t) => result(text(t).replace(/[^0-9]/g, "")) },
  letters: { pure: true, fn: (t) => result(text(t).replace(/[^\p{L}]/gu, "")) },
  is_digits: { pure: true, fn: (t) => text(t) !== "" && /^[0-9]+$/.test(text(t)) },
  is_letters: { pure: true, fn: (t) => text(t) !== "" && /^\p{L}+$/u.test(text(t)) },
  replace: {
    pure: true,
    fn: (t, part, w) => {
      if (text(part) === "") return result(text(t));
      // Too long is said before the words are built: each part found grows them by a known amount.
      const pieces = text(t).split(text(part));
      if (text(t).length + (pieces.length - 1) * (text(w).length - text(part).length) > MAX_WORDS * 2) throw new StrideFault("F012", `the words would be more than ${MAX_WORDS} characters`);
      return result(pieces.join(text(w)));
    },
  },
  contains: { pure: true, fn: (t, part) => text(t).includes(text(part)) },
  starts_with: { pure: true, fn: (t, part) => text(t).startsWith(text(part)) },
  ends_with: { pure: true, fn: (t, part) => text(t).endsWith(text(part)) },
  find: {
    pure: true,
    fn: (t, part) => {
      const p = text(part);
      if (p === "") return num(0);
      const s = text(t);
      const at = s.indexOf(p);
      return num(at < 0 ? 0 : [...s.slice(0, at)].length + 1);
    },
  },
  occurrences: { pure: true, fn: (t, part) => { const p = text(part); return num(p === "" ? 0 : text(t).split(p).length - 1); } },
  split: {
    pure: true,
    fn: (t, sep) => {
      const s = text(t);
      if (s === "") return list([], NO_MOST);
      const parts = text(sep) === "" ? chars(s) : s.split(text(sep));
      return list(parts.map((p) => (p === "" ? null : p)), NO_MOST);
    },
  },
  line: { pure: true, control: [1], fn: (t, n) => { const i = position("line", n); return result(trimmed(lines(t)[i - 1] ?? "")); } },
  line_count: { pure: true, fn: (t) => num(text(t) === "" ? 0 : lines(t).length) },
  rest_lines: { pure: true, fn: (t) => result(trimmed(lines(t).slice(1).join("\n"))) },
  // Words split on runs of spaces and tabs (§14.1); nothing else separates them.
  word: { pure: true, control: [1], fn: (t, n) => { const i = position("word", n); const s = trimmed(text(t)); return result(s === "" ? "" : s.split(/[ \t]+/)[i - 1] ?? ""); } },
  word_count: { pure: true, fn: (t) => { const s = trimmed(text(t)); return num(s === "" ? 0 : s.split(/[ \t]+/).length); } },
  pad_left: {
    pure: true,
    control: [1, 2],
    fn: (t, width, padding) => {
      const w = whole(width);
      if (w === null || w < 0 || w > 1000) throw new StrideFault("F009", `pad_left: the width is a whole number from 0 to 1000, and this is ${isEmpty(width) ? "empty" : words(width)}`);
      const p = padding === undefined ? [" "] : chars(text(padding));
      if (p.length !== 1) throw new StrideFault("F009", "pad_left: the padding is exactly one character");
      const s = chars(text(t));
      return result(s.length >= w ? s.join("") : p[0].repeat(w - s.length) + s.join(""));
    },
  },
  text_of: { pure: true, fn: (v) => result(words(v)) },
  number_of: { pure: true, fn: (t) => D.parseAnswer(text(t)).value },

  // ----- numbers (§14.2)
  round: { pure: true, control: [1], fn: (n, p) => { const k = places("round", p); return isEmpty(n) ? null : D.roundPlaces(n, k); } },
  ceil: { pure: true, fn: (n) => (isEmpty(n) ? null : D.ceil(n)) },
  floor: { pure: true, fn: (n) => (isEmpty(n) ? null : D.floor(n)) },
  whole: { pure: true, fn: (n) => (isEmpty(n) ? null : D.trunc(n)) },
  abs: { pure: true, fn: (n) => (isEmpty(n) ? null : D.sign(n) < 0 ? D.neg(n) : n) },
  min: { pure: true, fn: (a, b) => (isEmpty(a) ? (isEmpty(b) ? null : b) : isEmpty(b) ? a : D.compare(a, b) <= 0 ? a : b) },
  max: { pure: true, fn: (a, b) => (isEmpty(a) ? (isEmpty(b) ? null : b) : isEmpty(b) ? a : D.compare(a, b) >= 0 ? a : b) },
  grouped: {
    pure: true,
    control: [1],
    fn: (n, p) => {
      const k = places("grouped", p);
      if (isEmpty(n)) return null;
      const f = D.fixedWords(n, k);
      return `${f.negative ? "-" : ""}${f.whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${k ? `.${f.frac}` : ""}`;
    },
  },
  fixed: {
    pure: true,
    control: [1],
    fn: (n, p) => {
      const k = places("fixed", p);
      if (isEmpty(n)) return null;
      const f = D.fixedWords(n, k);
      return `${f.negative ? "-" : ""}${f.whole}${k ? `.${f.frac}` : ""}`;
    },
  },
  divide: { pure: true, fn: (a, b) => (isEmpty(a) || isEmpty(b) ? null : numberOp(() => D.div(a, b))) },
  remainder: { pure: true, fn: (a, b) => (isEmpty(a) || isEmpty(b) ? null : numberOp(() => D.mod(a, b))) },

  // ----- dates (§14.3)
  today: { pure: false, fn: () => todayDate() },
  date_of: { pure: true, fn: (y, m, d) => { const [a, b, c] = [whole(y), whole(m), whole(d)]; return a === null || b === null || c === null ? null : date(a, b, c); } },
  year: { pure: true, fn: (d) => (isDate(d) ? num(d.y) : null) },
  month: { pure: true, fn: (d) => (isDate(d) ? num(d.m) : null) },
  day: { pure: true, fn: (d) => (isDate(d) ? num(d.d) : null) },
  format: {
    pure: true,
    control: [1],
    fn: (d, pattern) => {
      const p = text(pattern);
      if (!/YYYY|YY|MM|DD|M|D/.test(p)) throw new StrideFault("F010", `format: the date pattern "${p}" has none of YYYY, YY, MM, DD, M, D`);
      if (!isDate(d)) return null;
      const pad = (n, w = 2) => String(n).padStart(w, "0");
      return result(p.replace(/YYYY|YY|MM|DD|M|D/g, (k) => ({ YYYY: pad(d.y, 4), YY: pad(d.y % 100), MM: pad(d.m), DD: pad(d.d), M: String(d.m), D: String(d.d) })[k]));
    },
  },
  days_between: { pure: true, fn: (a, b) => (isDate(a) && isDate(b) ? num(dayNumber(b) - dayNumber(a)) : null) },
  years_between: { pure: true, fn: (a, b) => (isDate(a) && isDate(b) ? num(yearsBetween(a, b)) : null) },
  // The same day of the month n months on; a month too short for it ends at its last day (31 January + 1 month is
  // the last day of February).
  add_months: {
    pure: true,
    fn: (d, n) => {
      if (!isDate(d) || isEmpty(n)) return null;
      const k = D.toInt(D.trunc(n));
      if (k === null) return null;
      const months = d.y * 12 + (d.m - 1) + k;
      const y = Math.floor(months / 12), m = (months % 12 + 12) % 12 + 1;
      if (y < 1 || y > 9999) throw new StrideFault("F011", "add_months: the day falls outside 0001-01-01 to 9999-12-31");
      return date(y, m, Math.min(d.d, daysIn(y, m)));
    },
  },
  // n to the power k, k a whole number: n multiplied by itself k times, 1 over that for k below 0.
  power: {
    pure: true,
    fn: (n, k) => {
      if (isEmpty(n) || isEmpty(k)) return null;
      const times = D.toInt(k);
      if (times === null || Math.abs(times) > 10_000) throw new StrideFault("F008", `power: the power is a whole number from -10000 to 10000, and this is ${words(k)}`);
      return numberOp(() => {
        let out = num(1);
        let base = n;
        for (let e = Math.abs(times); e > 0; e = Math.floor(e / 2)) {
          if (e % 2) out = D.mul(out, base);
          base = D.mul(base, base);
        }
        return times < 0 ? D.div(num(1), out) : out;
      });
    },
  },
  add_days: {
    pure: true,
    fn: (d, n) => {
      if (!isDate(d) || isEmpty(n)) return null;
      const k = D.toInt(D.trunc(n));
      const out = k === null ? null : fromDayNumber(dayNumber(d) + k);
      if (!out || dayNumber(d) + k < 0) throw new StrideFault("F011", "add_days: the day falls outside 0001-01-01 to 9999-12-31");
      return out;
    },
  },

  // ----- lists and sets (§14.4)
  count: { pure: true, fn: (l) => num(l instanceof StrideMap ? l.entries.size : asList(l).length) },
  // Maps (§14.4.1). A map given is not changed: remove gives a new one.
  map_of: { pure: true, internal: true, fn: () => new StrideMap() },
  map_put: { pure: true, internal: true, fn: (m, k, v) => (m.set(k, copy(v)), m) }, // a map being written out: its next key
  keys: { pure: true, fn: (m) => { const k = m instanceof StrideMap ? m.pairs.map(([key]) => key) : []; return list(k, Math.max(1, k.length)); } },
  values: { pure: true, fn: (m) => { const v = m instanceof StrideMap ? m.pairs.map(([, x]) => copy(x)) : []; return list(v, Math.max(1, v.length)); } },
  has: { pure: true, fn: (m, k) => m instanceof StrideMap && m.has(k) },
  remove: { pure: true, fn: (m, k) => { const out = m instanceof StrideMap ? copy(m) : new StrideMap(); out.remove(k); return out; } },
  join: { pure: true, fn: (l, sep) => result(asList(l).filter((x) => !isEmpty(x)).map(words).join(sep === undefined ? ", " : text(sep))) },
  first: { pure: true, fn: (l) => asList(l)[0] ?? null },
  last: { pure: true, fn: (l) => { const a = asList(l); return a.length ? a[a.length - 1] : null; } },
  filled: { pure: true, fn: (l) => listLike(asList(l).filter((x) => !isEmpty(x)), l) },
  index_of: { pure: true, fn: (l, x) => num(asList(l).findIndex((y) => equal(y, x)) + 1) },
  append: {
    pure: true,
    fn: (l, x) => {
      const items = asList(l);
      if (items.length >= mostOf(l)) throw new StrideFault("F017", `the list holds its most, ${mostOf(l)}, and cannot take one more item`);
      return list([...items, x], mostOf(l));
    },
  },
  without: { pure: true, fn: (l, x) => listLike(asList(l).filter((y) => !equal(y, x)), l) },
  reversed: { pure: true, fn: (l) => list([...asList(l)].reverse(), mostOf(l)) },
  sorted: { pure: true, fn: (l, descending) => sortItems(l, (v) => v, descending === true) },
  // sorted(l, by: "field"): the compiler turns the field's name into its number (§14.4).
  sorted_by: { pure: true, internal: true, fn: (l, field, descending) => sortItems(l, (v) => (v instanceof StrideRecord ? v.fields[whole(field)] ?? null : null), descending === true) },
  sum: { pure: true, fn: (l) => asList(l).filter((x) => !isEmpty(x)).reduce((a, b) => numberOp(() => D.add(a, b)), num(0)) },
  smallest: { pure: true, fn: (l) => asList(l).filter((x) => !isEmpty(x)).reduce((a, b) => (a === null || order(b, a) < 0 ? b : a), null) },
  largest: { pure: true, fn: (l) => asList(l).filter((x) => !isEmpty(x)).reduce((a, b) => (a === null || order(b, a) > 0 ? b : a), null) },
  any: { pure: true, fn: (l) => asList(l).some((x) => x === true) },
  all: { pure: true, fn: (l) => asList(l).every((x) => x === true) },
  union: { pure: true, fn: (a, b) => set([...asList(a), ...asList(b)], (a?.order ?? b?.order) ?? []) },
  intersection: { pure: true, fn: (a, b) => set(asList(a).filter((x) => asList(b).includes(x)), (a?.order ?? b?.order) ?? []) },
  difference: { pure: true, fn: (a, b) => set(asList(a).filter((x) => !asList(b).includes(x)), (a?.order ?? b?.order) ?? []) },

  // ----- empty, faults and output (§14.5)
  either: { pure: true, fn: (a, b) => (isEmpty(a) ? b : a) },
  fail: { pure: false, statement: true, fn: (message) => { throw new StrideFault("F013", text(message)); } },
  print: { pure: false, statement: true, fn: (v) => { printer(v); return null; } },
  // The key of a call that can reach questions (§8.6.2): its name where it stands; a second call there, name#2.
  call_key: {
    pure: false,
    internal: true,
    fn: (base) => {
      const n = (callCounts.get(base) ?? 0) + 1;
      callCounts.set(base, n);
      return n === 1 ? base : `${base}#${n}`;
    },
  },
  // A list placed where a list type is expected (§3.7.2, §3.7.7): the type's mosts, outer to inner, as "4,3"; each
  // level widened, F017 when a level holds a larger most.
  widen: { pure: true, internal: true, fn: (v, shape) => widenTo(v, text(shape).split(",").map((m) => (m === "?" ? m : Number(m)))) },
  // Words in quotes where a set is expected (§3.6): the options they name, in the set's order.
  to_set: { pure: true, internal: true, fn: (l, order) => set(asList(l), asList(order)) },
  // A for loop's bound (§7.11): a whole number, else F004.
  loop_bound: { pure: true, internal: true, fn: (v) => { if (whole(v) === null) throw new StrideFault("F004", `a loop's bound is a whole number, and this is ${isEmpty(v) ? "empty" : words(v)}`); return v; } },
  // A date constant, from its words: the compiler's.
  date_from_iso: { pure: true, internal: true, fn: (s) => dateFrom(s) },
  // A list with no items and the most of the list given (§3.7.5): a comprehension over a list whose most comes
  // with it, the compiler's.
  empty_like: { pure: true, internal: true, fn: (l) => list([], mostOf(l)) },
  // A list field read (§6.9.1, §3.7.1): the field of an empty record is a list with no items, of the field's most.
  field_list: { pure: true, internal: true, fn: (v, most) => (isEmpty(v) ? list([], Number(text(most))) : v) },
  // `x is empty`: the compiler's, not declared in the standard library.
  is_empty: { pure: true, internal: true, fn: (v) => isEmpty(v) },
};

// A level of `?` keeps the most the value carries there (§3.9 rule 4); the levels inside it are still widened.
function widenTo(v, mosts) {
  if (!mosts.length || isSet(v)) return v;
  if (mosts[0] === "?") return v === null || v === undefined || !Array.isArray(v) ? v : list(v.map((x) => widenTo(x, mosts.slice(1))), mostOf(v));
  if (v === null || v === undefined) return list([], mosts[0]);
  if (!Array.isArray(v)) return v;
  if (v.length > mosts[0]) throw new StrideFault("F017", `a list of ${v.length} items was placed where at most ${mosts[0]} fit`);
  return list(v.map((x) => widenTo(x, mosts.slice(1))), mosts[0]);
}

function numberOp(f) {
  try {
    return f();
  } catch (e) {
    if (e instanceof D.NumberFault) throw new StrideFault(e.code, e.message);
    throw e;
  }
}

export { StrideDate, isDate, D };
