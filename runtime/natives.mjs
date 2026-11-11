// The functions of Stride's standard library that the machine provides, the natives (docs/spec.md §14). The
// standard library (lib/std.stride) declares each with its parameters, defaults and result; the
// compiler checks calls against those declarations and runs a pure native on values it already knows, and the
// machine runs it on the person's answers: the same function. Values are those of runtime/values.mjs.
//
// A native given null where it needs a value faults (F023, §14.0.3) before anything else: `takes` names each
// parameter and the kind of value it needs. Then it checks its control arguments — positions, places, widths,
// paddings, patterns — and faults when one is wrong (§14.0.3.1).
import { D, StrideFault, StrideRecord, StrideMap, StrideRange, StrideError, copy, StrideDate, isNull, isNumber, isDate, isSet, words, equal, order, set, date, dateFrom, daysIn, num, whole, needed, outside, dayNumber, fromDayNumber } from "./values.mjs";
import { power } from "./ops.mjs";

export { StrideFault, StrideRecord, isNull };
export const stringOf = words;

const chars = (t) => [...t];
const text = (t) => (typeof t === "string" ? t : words(t));

// A position (§14.0.4): a whole number of 0 or more, else F007. One past every text there can be (beyond
// JavaScript's safe whole numbers too) is a position all the same: past the end.
function position(name, v) {
  if (!isNumber(v) || !D.isWhole(v) || D.sign(v) < 0) throw new StrideFault("F007", `${name}: a position is a whole number of 0 or more, and this is ${words(v)}`);
  return whole(v) ?? Infinity;
}
// Places (§14.2): a whole number 0–10, else F008.
function places(name, v) {
  const n = whole(v);
  if (n === null || n < 0 || n > 10) throw new StrideFault("F008", `${name}: places are a whole number from 0 to 10, and this is ${words(v)}`);
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

// years_between (§14.3): anniversaries of from on or before to; an anniversary on a day the year lacks falls on the
// month's last day; reversed, minus the forward count.
function yearsBetween(a, b) {
  if (order(a.iso, b.iso) > 0) return -yearsBetween(b, a);
  let years = b.y - a.y;
  const day = Math.min(a.d, daysIn(b.y, a.m));
  if (b.m < a.m || (b.m === a.m && b.d < day)) years--;
  return years;
}

const listLike = (items, of) => (isSet(of) ? set(items, of.order) : items);

// The items of a list a function orders or adds up: every one a value (F023).
const valued = (l, what, kind = "a value is") => l.map((x) => (isNull(x) ? needed(kind, what) : x));

// The sort of §14.4: stable, ascending or descending.
function sortItems(l, key, descending) {
  const items = l.map((v, i) => ({ v, k: key(v), i }));
  items.sort((x, y) => {
    const c = order(x.k, y.k);
    return c === 0 ? x.i - y.i : descending ? -c : c;
  });
  return items.map((x) => x.v);
}

// Each native: its function, whether it is pure (only a pure native is worked out by the compiler, in a constant),
// whether it changes the list or map it is given (§3.4), and whether its call is a statement (no result). `takes`:
// its parameters, each `name:kind`, the kind of value it needs — t words, n a number, d a date, l a list, m a map,
// s a set, v any value — in a capital when it takes null too; given null where it needs a value, the call is F023
// (§14.0.3). `as`: the name its faults give it.
function extreme(name, a, b, keeps) {
  const all = Array.isArray(a) ? a : [a, b];
  if (!all.length || all.some((x) => !isNumber(x))) throw new StrideFault("F023", `null where a number is needed: ${name} takes two numbers, or a list of numbers with at least one`);
  return all.reduce((x, y) => (keeps(x, y) ? x : y));
}

export const NATIVES = {
  // ----- words (§14.1)
  upper: { pure: true, takes: "t:t", fn: (t) => text(t).toUpperCase() },
  lower: { pure: true, takes: "t:t", fn: (t) => text(t).toLowerCase() },
  // Words split on spaces, - and ' (§14.1), not on tabs or line ends.
  title: { pure: true, takes: "t:t", fn: (t) => text(t).toLowerCase().replace(/(^|[ \-'])(\p{L})/gu, (m, sep, c) => sep + c.toUpperCase()) },
  capitalize: { pure: true, takes: "t:t", fn: (t) => { const c = chars(text(t)); return c.length ? c[0].toUpperCase() + c.slice(1).join("") : ""; } },
  trim: { pure: true, takes: "t:t", fn: (t) => text(t).trim() },
  trim_start: { pure: true, takes: "t:t", fn: (t) => text(t).trimStart() },
  trim_end: { pure: true, takes: "t:t", fn: (t) => text(t).trimEnd() },
  remove_prefix: { pure: true, takes: "t:t prefix:t", fn: (t, p) => (text(p) && text(t).startsWith(text(p)) ? text(t).slice(text(p).length) : text(t)) },
  remove_suffix: { pure: true, takes: "t:t suffix:t", fn: (t, s) => (text(s) && text(t).endsWith(text(s)) ? text(t).slice(0, text(t).length - text(s).length) : text(t)) },
  length: { pure: true, takes: "t:v", fn: (t) => num(Array.isArray(t) ? t.length : t instanceof StrideMap ? t.entries.size : chars(text(t)).length) },
  each_character: { pure: true, internal: true, fn: (t) => chars(text(t)) },
  chars: {
    pure: true,
    takes: "t:t from:n to:n",
    fn: (t, from, to) => {
      const f = position("chars", from), e = position("chars", to);
      return e < f ? "" : chars(compact(t)).slice(f, e + 1).join("");
    },
  },
  character: { pure: true, takes: "t:t n:n", fn: (t, n) => { const i = position("character", n); return chars(compact(t))[i] ?? null; } },
  slice: {
    pure: true,
    takes: "t:t from:n to:n",
    fn: (t, from, to) => {
      const f = position("slice", from), e = position("slice", to);
      return e < f ? "" : chars(text(t)).slice(f, e + 1).join("");
    },
  },
  digits: { pure: true, takes: "t:t", fn: (t) => text(t).replace(/[^0-9]/g, "") },
  letters: { pure: true, takes: "t:t", fn: (t) => text(t).replace(/[^\p{L}]/gu, "") },
  is_digits: { pure: true, takes: "t:t", fn: (t) => /^[0-9]+$/.test(text(t)) },
  is_letters: { pure: true, takes: "t:t", fn: (t) => /^\p{L}+$/u.test(text(t)) },
  replace: { pure: true, takes: "t:t part:t with:t", fn: (t, part, w) => (text(part) === "" ? text(t) : text(t).split(text(part)).join(text(w))) },
  contains: { pure: true, takes: "t:t part:t", fn: (t, part) => text(t).includes(text(part)) },
  starts_with: { pure: true, takes: "t:t part:t", fn: (t, part) => text(t).startsWith(text(part)) },
  ends_with: { pure: true, takes: "t:t part:t", fn: (t, part) => text(t).endsWith(text(part)) },
  find: {
    pure: true,
    takes: "t:t part:t",
    fn: (t, part) => {
      const p = text(part);
      if (p === "") return num(-1);
      const s = text(t);
      const at = s.indexOf(p);
      return num(at < 0 ? -1 : [...s.slice(0, at)].length);
    },
  },
  occurrences: { pure: true, takes: "t:t part:t", fn: (t, part) => { const p = text(part); return num(p === "" ? 0 : text(t).split(p).length - 1); } },
  split: {
    pure: true,
    takes: "t:t separator:t",
    fn: (t, sep) => {
      const s = text(t);
      if (s === "") return [];
      return text(sep) === "" ? chars(s) : s.split(text(sep));
    },
  },
  line: { pure: true, takes: "t:t n:n", fn: (t, n) => { const l = lines(t)[position("line", n)]; return l === undefined ? null : trimmed(l); } },
  line_count: { pure: true, takes: "t:t", fn: (t) => num(text(t) === "" ? 0 : lines(t).length) },
  rest_lines: { pure: true, takes: "t:t", fn: (t) => trimmed(lines(t).slice(1).join("\n")) },
  // Words split on runs of spaces and tabs (§14.1); nothing else separates them.
  word: { pure: true, takes: "t:t n:n", fn: (t, n) => { const i = position("word", n); const s = trimmed(text(t)); return s === "" ? null : s.split(/[ \t]+/)[i] ?? null; } },
  word_count: { pure: true, takes: "t:t", fn: (t) => { const s = trimmed(text(t)); return num(s === "" ? 0 : s.split(/[ \t]+/).length); } },
  pad_right: {
    pure: true,
    takes: "t:t width:n padding:t",
    fn: (t, width, padding) => {
      const w = whole(width);
      if (w === null || w < 0) throw new StrideFault("F009", `pad_right: the width is a whole number of 0 or more, and this is ${words(width)}`);
      const p = padding === undefined ? [" "] : chars(text(padding));
      if (p.length !== 1) throw new StrideFault("F009", "pad_right: the padding is exactly one character");
      const s = chars(text(t));
      return s.length >= w ? s.join("") : s.join("") + p[0].repeat(w - s.length);
    },
  },
  repeat: {
    pure: true,
    takes: "t:t times:n",
    fn: (t, times) => {
      const n = whole(times);
      if (n === null || n < 0) throw new StrideFault("F009", `repeat: the times is a whole number of 0 or more, and this is ${words(times)}`);
      return text(t).repeat(n);
    },
  },
  pad_left: {
    pure: true,
    takes: "t:t width:n padding:t",
    fn: (t, width, padding) => {
      const w = whole(width);
      if (w === null || w < 0) throw new StrideFault("F009", `pad_left: the width is a whole number of 0 or more, and this is ${words(width)}`);
      const p = padding === undefined ? [" "] : chars(text(padding));
      if (p.length !== 1) throw new StrideFault("F009", "pad_left: the padding is exactly one character");
      const s = chars(text(t));
      return s.length >= w ? s.join("") : p[0].repeat(w - s.length) + s.join("");
    },
  },
  string_of: { pure: true, takes: "v:V", fn: (v) => words(v) },
  number_of: { pure: true, takes: "t:t", fn: (t) => D.parseAnswer(text(t)).value },

  // ----- numbers (§14.2)
  round: { pure: true, takes: "n:n places:n", fn: (n, p) => D.roundPlaces(n, places("round", p)) },
  ceil: { pure: true, takes: "n:n", fn: (n) => D.ceil(n) },
  floor: { pure: true, takes: "n:n", fn: (n) => D.floor(n) },
  whole: { pure: true, takes: "n:n", fn: (n) => D.trunc(n) },
  abs: { pure: true, takes: "n:n", fn: (n) => (D.sign(n) < 0 ? D.neg(n) : n) },
  // The smaller, the larger: of two numbers, or of a list's.
  min: { pure: true, takes: "a:V b:V", fn: (a, b) => extreme("min", a, b, (x, y) => D.compare(x, y) <= 0) },
  max: { pure: true, takes: "a:V b:V", fn: (a, b) => extreme("max", a, b, (x, y) => D.compare(x, y) >= 0) },
  grouped: {
    pure: true,
    takes: "n:n places:n",
    fn: (n, p) => {
      const k = places("grouped", p);
      const f = D.fixedWords(n, k);
      return `${f.negative ? "-" : ""}${f.whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${k ? `.${f.frac}` : ""}`;
    },
  },
  fixed: {
    pure: true,
    takes: "n:n places:n",
    fn: (n, p) => {
      const k = places("fixed", p);
      const f = D.fixedWords(n, k);
      return `${f.negative ? "-" : ""}${f.whole}${k ? `.${f.frac}` : ""}`;
    },
  },
  divide: { pure: true, takes: "a:n b:n", fn: (a, b) => numberOp(() => D.div(a, b)) },
  remainder: { pure: true, takes: "a:n b:n", fn: (a, b) => numberOp(() => D.mod(a, b)) },

  // ----- dates (§14.3)
  today: { pure: false, fn: () => todayDate() },
  date_of: { pure: true, takes: "year:n month:n day:n", fn: (y, m, d) => { const [a, b, c] = [whole(y), whole(m), whole(d)]; return a === null || b === null || c === null ? null : date(a, b, c); } },
  year: { pure: true, takes: "d:d", fn: (d) => num(d.y) },
  month: { pure: true, takes: "d:d", fn: (d) => num(d.m) },
  day: { pure: true, takes: "d:d", fn: (d) => num(d.d) },
  format: {
    pure: true,
    takes: "d:d pattern:t",
    fn: (d, pattern) => {
      const p = text(pattern);
      if (!/YYYY|YY|MM|DD|M|D/.test(p)) throw new StrideFault("F010", `format: the date pattern "${p}" has none of YYYY, YY, MM, DD, M, D`);
      const pad = (n, w = 2) => String(n).padStart(w, "0");
      return p.replace(/YYYY|YY|MM|DD|M|D/g, (k) => ({ YYYY: pad(d.y, 4), YY: pad(d.y % 100), MM: pad(d.m), DD: pad(d.d), M: String(d.m), D: String(d.d) })[k]);
    },
  },
  days_between: { pure: true, takes: "from:d to:d", fn: (a, b) => num(dayNumber(b) - dayNumber(a)) },
  years_between: { pure: true, takes: "from:d to:d", fn: (a, b) => num(yearsBetween(a, b)) },
  // The same day of the month n months on; a month too short for it ends at its last day (31 January + 1 month is
  // the last day of February).
  add_months: {
    pure: true,
    takes: "d:d n:n",
    fn: (d, n) => {
      const k = D.toInt(D.trunc(n));
      const months = d.y * 12 + (d.m - 1) + (k ?? Infinity);
      const y = Math.floor(months / 12), m = (months % 12 + 12) % 12 + 1;
      if (k === null || y < 1 || y > 9999) throw new StrideFault("F011", "add_months: the day falls outside 0001-01-01 to 9999-12-31");
      return date(y, m, Math.min(d.d, daysIn(y, m)));
    },
  },
  // n to the power k, k a whole number: n multiplied by itself k times, 1 over that for k below 0.
  power: {
    pure: true,
    takes: "n:n k:n",
    fn: (n, k) => power(n, k, "power"),
  },
  add_days: {
    pure: true,
    takes: "d:d n:n",
    fn: (d, n) => {
      const k = D.toInt(D.trunc(n));
      const out = k === null ? null : fromDayNumber(dayNumber(d) + k);
      if (!out || dayNumber(d) + k < 0) throw new StrideFault("F011", "add_days: the day falls outside 0001-01-01 to 9999-12-31");
      return out;
    },
  },

  // ----- lists and sets (§14.4)
  // The whole numbers from `from` to before `to`, `step` apart (§14.4): counting down when step is below 0.
  range: {
    pure: true,
    takes: "from:n to:n step:n",
    fn: (from, to, step) => {
      for (const [v, name] of [[from, "from"], [to, "to"], [step, "step"]]) if (!D.isWhole(v)) throw new StrideFault("F004", `range: ${name} is a whole number, and this is ${words(v)}`);
      if (D.sign(step) === 0) throw new StrideFault("F031", "range: step is 0, and a range of steps of 0 never ends");
      const up = D.sign(step) > 0;
      const span = D.sub(to, from);
      if (D.sign(span) !== D.sign(step)) return [];
      // How many: the steps that fit before `to`, and the first.
      const steps = numberOp(() => D.floorDiv(D.sub(span, num(up ? 1 : -1)), step));
      if (D.compare(steps, num(10_000_000)) >= 0) throw new StrideFault("F030", "range: the list would hold more than 10000000 numbers");
      const out = [];
      for (let v = from, i = D.toInt(steps); i >= 0; i--, v = D.add(v, step)) out.push(v);
      return out;
    },
  },
  count: { pure: true, takes: "l:l", fn: (l) => (l instanceof StrideRange ? l.count : num(l instanceof StrideMap ? l.entries.size : typeof l === "string" ? chars(l).length : l.length)) },
  // Maps (§14.4.1).
  map_of: { pure: true, internal: true, fn: () => new StrideMap() },
  map_put: { pure: true, internal: true, fn: (m, k, v) => (m.set(k, v), m) }, // a map being written out: its next key
  keys: { pure: true, takes: "m:m", fn: (m) => m.pairs.map(([key]) => key) },
  values: { pure: true, takes: "m:m", fn: (m) => m.pairs.map(([, x]) => x) },
  has: { pure: true, takes: "m:m key:V", fn: (m, k) => m.has(k) },
  remove: { pure: true, changes: true, takes: "m:m key:V", fn: (m, k) => (m.remove(k), m) },
  join: { pure: true, takes: "l:l separator:t", fn: (l, sep) => l.map(words).join(sep === undefined ? ", " : text(sep)) },
  first: { pure: true, takes: "l:l", fn: (l) => l[0] ?? null },
  last: { pure: true, takes: "l:l", fn: (l) => (l.length ? l[l.length - 1] : null) },
  filled: { pure: true, takes: "l:L", fn: (l) => listLike((l ?? []).filter((x) => !isNull(x)), l) },
  index_of: { pure: true, takes: "l:l x:V", fn: (l, x) => num(l.findIndex((y) => equal(y, x))) },
  // These change the list or map they are given (§3.4), and give it back.
  append: { pure: true, changes: true, takes: "l:l x:V", fn: (l, x) => (l.push(x), l) },
  insert: {
    pure: true,
    changes: true,
    takes: "l:l position:n x:V",
    fn: (l, position, x) => {
      const n = whole(position);
      if (n === null || n < 0 || n > l.length) throw new StrideFault("F005", `insert: position ${words(position)} is outside 0 to the number of items: the list holds ${l.length}`);
      l.splice(n, 0, x);
      return l;
    },
  },
  remove_at: {
    pure: true,
    changes: true,
    takes: "l:l position:n",
    fn: (l, position) => {
      const n = whole(position);
      if (n === null || n < 0) throw new StrideFault("F004", `remove_at: position ${words(position)} is not a whole number of 0 or more`);
      if (n >= l.length) throw new StrideFault("F004", `remove_at: ${outside(position, l.length)}`);
      return l.splice(n, 1)[0];
    },
  },
  clear: { pure: true, changes: true, takes: "l:l", fn: (l) => { if (l instanceof StrideMap) l.entries.clear(); else l.length = 0; return l; } },
  // l += m (§6.5.1): m's items added to l itself.
  extend: { pure: true, internal: true, fn: (l, m) => { if (isNull(l)) needed("a list is", "the left side of +="); if (isNull(m)) needed("a list is", "the right side of +="); l.push(...m); return l; } },
  copy: { pure: true, takes: "x:V", fn: (x) => copy(x) },
  without: { pure: true, takes: "l:l x:V", fn: (l, x) => listLike(l.filter((y) => !equal(y, x)), l) },
  reversed: { pure: true, takes: "l:l", fn: (l) => [...l].reverse() },
  sorted: { pure: true, takes: "l:l descending:V", fn: (l, descending) => sortItems(valued(l, "an item sorted puts in order"), (v) => v, descending === true) },
  // sorted(l, by: "field"): the compiler turns the field's name into its number (§14.4).
  sorted_by: {
    pure: true,
    internal: true,
    as: "sorted",
    takes: "l:l by:n descending:V",
    fn: (l, field, descending) => sortItems(valued(l, "an item sorted puts in order"), (v) => v.fields[whole(field)] ?? needed("a value is", "the field sorted puts in order by"), descending === true),
  },
  sum: { pure: true, takes: "l:l", fn: (l) => valued(l, "an item sum adds up", "a number is").reduce((a, b) => numberOp(() => D.add(a, b)), num(0)) },
  smallest: { pure: true, takes: "l:l", fn: (l) => valued(l, "an item smallest compares").reduce((a, b) => (a === null || order(b, a) < 0 ? b : a), null) },
  largest: { pure: true, takes: "l:l", fn: (l) => valued(l, "an item largest compares").reduce((a, b) => (a === null || order(b, a) > 0 ? b : a), null) },
  any: { pure: true, takes: "l:l", fn: (l) => l.some((x) => x === true) },
  all: { pure: true, takes: "l:l", fn: (l) => l.every((x) => x === true) },
  union: { pure: true, takes: "a:s b:s", fn: (a, b) => set([...a, ...b], a.order ?? b.order ?? []) },
  intersection: { pure: true, takes: "a:s b:s", fn: (a, b) => set(a.filter((x) => b.includes(x)), a.order ?? b.order ?? []) },
  difference: { pure: true, takes: "a:s b:s", fn: (a, b) => set(a.filter((x) => !b.includes(x)), a.order ?? b.order ?? []) },

  // ----- null, faults and output (§14.5)
  either: { pure: true, takes: "a:V b:V", fn: (a, b) => (isNull(a) ? b : a) },
  fail: { pure: false, statement: true, takes: "message:T", fn: (message) => { throw new StrideFault("F013", text(message)); } },
  // An error value (§14.5): its code F013 when none is given.
  error: { pure: false, takes: "message:T code:T", fn: (message, code) => new StrideError(text(code) || "F013", text(message)) },
  print: { pure: false, statement: true, takes: "v:V", fn: (v) => { printer([v]); return null; } },
  // print(a, b, …) (§14.5): the values of one line, in a list.
  print_all: { pure: false, internal: true, fn: (values) => { printer(values); return null; } },
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
  // A list of words in quotes where a set is expected (§3.6): the options they name, in the set's order.
  to_set: { pure: true, internal: true, fn: (l, order) => (isNull(l) ? null : set(l, order)) },
  // A for loop's bound (§7.11): a number (F023), and a whole one (F004).
  loop_bound: { pure: true, internal: true, fn: (v) => { if (isNull(v)) needed("a number is", "a loop's bound"); if (whole(v) === null) throw new StrideFault("F004", `a loop's bound is a whole number, and this is ${words(v)}`); return v; } },
  // What a for or a comprehension goes through (§7.11, §6.12): there (F023).
  // The items a list holds when the loop starts are the ones it goes through (§3.4.5).
  each_of: { pure: true, internal: true, fn: (v) => (isNull(v) ? needed("a list is", "what for goes through") : v instanceof StrideRange ? v.items : Array.isArray(v) && !isSet(v) ? [...v] : v) },
  // The last position of l[a..<b] (§6.9.3): b - 1, b a number (F023).
  slice_end: { pure: true, internal: true, fn: (v) => D.sub(v ?? needed("a number is", "a bound of [ .. ]"), num(1)) },
  // A date constant, from its words: the compiler's.
  date_from_iso: { pure: true, internal: true, fn: (s) => dateFrom(s) },
  // Whether a value is null: the compiler's, not declared in the standard library.
  is_null: { pure: true, internal: true, fn: (v) => isNull(v) },
};

// Empty given where a native needs a value (§14.0.3): F023 naming the parameter, before the native does anything.
const KINDS = { t: "words are", n: "a number is", d: "a date is", l: "a list is", m: "a map is", s: "a set is", v: "a value is" };
for (const [name, native] of Object.entries(NATIVES)) {
  if (!native.takes) continue;
  const params = native.takes.split(" ").map((p) => p.split(":"));
  const fn = native.fn;
  native.fn = (...args) => {
    args.forEach((v, i) => {
      if (v === null && params[i] && KINDS[params[i][1]]) needed(KINDS[params[i][1]], `${native.as ?? name}'s ${params[i][0]}`);
    });
    return fn(...args);
  };
  Object.defineProperty(native.fn, "length", { value: fn.length }); // how many values it takes (S302)
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
