// Stride's numbers (docs/spec.md §3.3): exact decimals. A number is a whole coefficient times a power of ten,
// c × 10^e, with |c| of at most 34 significant digits and the value's magnitude below 10^34. + - * are exact and
// round only a result of more than 34 significant digits (half to even); / rounds its quotient to 34 digits; // and
// % work from the exact quotient (§6.4.1). Every number is a multiple of 10^-6176 (§3.3): a result finer than that is
// rounded to it, half to even, so an exponent stays a small whole number from -6176 to 33 and aligning two numbers
// never builds an integer of more than about 6,210 digits. Every value is kept in one canonical form (no trailing zeros in the
// coefficient, zero as 0 × 10^0), so two equal numbers are the same object shape and compare by their fields.

export const DIGITS = 34;
export const EMIN = -6176; // the smallest exponent: every number is a multiple of 10^-6176
const LIMIT = 10n ** 34n; // the magnitude every number stays below

export class NumberFault extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class Decimal {
  constructor(c, e) {
    this.c = c; // BigInt coefficient
    this.e = e; // exponent: a whole number from EMIN to 33
  }

  toString() {
    return words(this);
  }

  toJSON() {
    return words(this);
  }
}

const pow10 = (n) => 10n ** BigInt(n);
const abs = (n) => (n < 0n ? -n : n);
const digitCount = (n) => (n === 0n ? 1 : abs(n).toString().length);

// The canonical form: trailing zeros of the coefficient moved into the exponent; zero is 0e0.
function make(c, e) {
  if (c === 0n) return ZERO;
  while (c % 10n === 0n) {
    c /= 10n;
    e += 1;
  }
  return new Decimal(c, e);
}
export const ZERO = new Decimal(0n, 0);

// c with its last `drop` digits rounded away, half to even.
function dropDigits(c, drop) {
  const unit = pow10(drop);
  let q = c / unit;
  const r = abs(c % unit);
  const half = unit / 2n;
  if (r > half || (r === half && q % 2n !== 0n)) q += c < 0n ? -1n : 1n;
  return q;
}

// Rounds c × 10^e to at most 34 significant digits and to a multiple of 10^EMIN, half to even, and checks the
// magnitude (F003).
function round34(c, e) {
  const n = digitCount(c);
  const drop = Math.max(n - DIGITS, EMIN - e, 0);
  if (drop > 0) {
    // Digits below the smallest kept one all round away: past the coefficient's length the result is 0.
    c = drop > n ? 0n : dropDigits(c, drop);
    e += drop;
  }
  const out = make(c, e);
  checkRange(out);
  return out;
}

function checkRange(d) {
  if (d.c === 0n) return;
  // |c| × 10^e ≥ 10^34 when digits(c) + e > 34
  if (digitCount(d.c) + d.e > DIGITS) throw new NumberFault("F003", `the number is too large: its size must stay below 10^34`);
}

// Two numbers over a common exponent.
function align(a, b) {
  const e = Math.min(a.e, b.e);
  return [a.c * pow10(a.e - e), b.c * pow10(b.e - e), e];
}

export const add = (a, b) => {
  const [x, y, e] = align(a, b);
  return round34(x + y, e);
};
export const sub = (a, b) => {
  const [x, y, e] = align(a, b);
  return round34(x - y, e);
};
export const mul = (a, b) => round34(a.c * b.c, a.e + b.e);
export const neg = (a) => make(-a.c, a.e);

// a / b, the quotient rounded to 34 significant digits, half to even (§3.3.2).
export function div(a, b) {
  if (b.c === 0n) throw new NumberFault("F001", "division by zero");
  if (a.c === 0n) return ZERO;
  // Scale the dividend so the integer quotient carries at least 36 digits, then round once: the extra digit and
  // the sticky remainder decide the rounding exactly.
  const scale = Math.max(0, DIGITS + 2 - (digitCount(a.c) - digitCount(b.c)));
  const num = a.c * pow10(scale);
  let q = num / b.c;
  const r = num % b.c;
  // A non-zero remainder below the kept digits is a sticky digit: one more digit, 1 in the quotient's direction,
  // so half to even never takes an inexact quotient for a tie.
  const negative = (a.c < 0n) !== (b.c < 0n);
  q = q * 10n + (r === 0n ? 0n : negative ? -1n : 1n);
  return round34(q, a.e - b.e - scale - 1);
}

// The floor of the exact quotient a / b, as a whole BigInt.
function floorQuotient(a, b) {
  const [x, y] = align(a, b);
  let q = x / y;
  if ((x % y !== 0n) && ((x < 0n) !== (y < 0n))) q -= 1n;
  return q;
}

// a // b: the floor of the exact quotient (§6.4.1); F002 by zero, F003 when it cannot be represented.
export function floorDiv(a, b) {
  if (b.c === 0n) throw new NumberFault("F002", "floor division by zero");
  const q = floorQuotient(a, b);
  if (abs(q) >= LIMIT) throw new NumberFault("F003", `the number is too large: its size must stay below 10^34`);
  return make(q, 0);
}

// a % b: a − b·q worked out exactly, then rounded to 34 digits keeping its sign and |r| < |b| (§6.4.1).
export function mod(a, b) {
  if (b.c === 0n) throw new NumberFault("F002", "remainder of a division by zero");
  const q = floorQuotient(a, b);
  const [x, y, e] = align(a, b);
  const r = x - y * q; // exact, the sign of b, |r| < |b|
  if (r === 0n) return ZERO;
  if (digitCount(r) <= DIGITS) return make(r, e);
  // Round to 34 digits, half to even; a rounding that reaches |b| gives the largest value below it at 34 digits.
  const drop = digitCount(r) - DIGITS;
  const unit = pow10(drop);
  let k = r / unit;
  const rest = abs(r % unit);
  const half = unit / 2n;
  if (rest > half || (rest === half && k % 2n !== 0n)) k += r < 0n ? -1n : 1n;
  let out = k * unit;
  if (abs(out) >= abs(y)) {
    k = (abs(y) - 1n) / unit; // the largest multiple of the unit below |b|
    out = (r < 0n ? -k : k) * unit;
  }
  return make(out, e);
}

export function compare(a, b) {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}
export const equal = (a, b) => a.c === b.c && a.e === b.e;
export const isWhole = (a) => a.e >= 0;
export const sign = (a) => (a.c < 0n ? -1 : a.c > 0n ? 1 : 0);

// A whole Decimal as a JavaScript number, for positions, counts and the like; null when it is not whole or too big.
export function toInt(a) {
  if (!isWhole(a)) return null;
  const n = a.c * pow10(a.e);
  if (abs(n) > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(n);
}
export const fromInt = (n) => make(BigInt(n), 0);

// ceil, floor, truncation towards zero.
export function floor(a) {
  if (isWhole(a)) return a;
  const u = pow10(-a.e);
  let q = a.c / u;
  if (a.c < 0n && a.c % u !== 0n) q -= 1n;
  return make(q, 0);
}
export const ceil = (a) => neg(floor(neg(a)));
export function trunc(a) {
  if (isWhole(a)) return a;
  return make(a.c / pow10(-a.e), 0);
}

// a rounded to `places` decimals (0–10), half away from zero (§14.2).
export function roundPlaces(a, places) {
  if (a.e >= -places) return a;
  const u = pow10(-a.e - places);
  let q = a.c / u;
  const r = abs(a.c % u);
  if (r * 2n >= u) q += a.c < 0n ? -1n : 1n;
  return make(q, -places);
}

// A number's words (§3.3.5): the shortest exact decimal, no exponent, no trailing zeros, "-" when negative.
export function words(a) {
  if (a.c === 0n) return "0";
  const negative = a.c < 0n;
  let digits = abs(a.c).toString();
  let out;
  if (a.e >= 0) out = digits + "0".repeat(a.e);
  else {
    const point = digits.length + a.e;
    out = point > 0 ? `${digits.slice(0, point)}.${digits.slice(point)}` : `0.${"0".repeat(-point)}${digits}`;
  }
  return negative ? `-${out}` : out;
}

// The digits of n with `places` decimals, rounded half away from zero, as words (`fixed`, `grouped`).
export function fixedWords(a, places) {
  const r = roundPlaces(a, places);
  const negative = r.c < 0n;
  const scaled = abs(r.c) * pow10(r.e + places); // the value × 10^places, whole
  let s = scaled.toString().padStart(places + 1, "0");
  const whole = s.slice(0, s.length - places);
  const frac = places ? s.slice(s.length - places) : "";
  return { negative: negative && scaled !== 0n, whole, frac };
}

// A number literal in a program: digits with an optional point and digits. Gives the Decimal, or a reason it is
// not one (S009: too many digits or too large).
export function parseLiteral(text) {
  const m = text.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return { error: "not a number" };
  const intPart = m[1], frac = m[2] ?? "";
  const c = BigInt(intPart + frac);
  const significant = (intPart + frac).replace(/^0+/, "").replace(/0+$/, "").length;
  if (significant > DIGITS) return { error: "S009", why: "more than 34 significant digits" };
  const d = make(c, -frac.length);
  if (d.c !== 0n && digitCount(d.c) + d.e > DIGITS) return { error: "S009", why: "10^34 or more" };
  if (d.e < EMIN) return { error: "S009", why: "finer than 10^-6176" };
  return { value: d };
}

// A number answer as a person typed it (§8.7): optional spaces, a sign, digits with `,`, space or `'` between
// groups, a point and digits, `$ € £` ignored. Gives { value } or { value: null, unreadable: reason }; "" (nothing
// written) gives { value: null } with no reason.
export function parseAnswer(raw) {
  if (raw === null || raw === undefined) return { value: null };
  if (raw instanceof Decimal) return { value: raw };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { value: null, unreadable: "not a number" };
    raw = String(raw); // the shortest round-trip decimal; may hold an exponent, read below
    if (/e/i.test(raw)) {
      const [m, x] = raw.split(/e/i);
      const p = parseAnswer(m);
      if (!p.value) return p;
      const scaled = make(p.value.c, p.value.e + Number(x));
      try {
        checkRange(scaled);
      } catch {
        return { value: null, unreadable: "too large" };
      }
      if (scaled.e < EMIN) return { value: null, unreadable: "too small" };
      return { value: scaled };
    }
  }
  // Optional spaces (U+0020, §8.7) around it and after its sign; no other white space.
  let s = String(raw).replace(/[$€£]/g, "").replace(/^ +| +$/g, "");
  if (s === "") return { value: null };
  let negative = false;
  if (s[0] === "+" || s[0] === "-") {
    negative = s[0] === "-";
    s = s.slice(1).replace(/^ +/, "");
  }
  const m = s.match(/^(\d{1,3}(?:[, ']\d{3})+|\d+)(?:\.(\d+))?$/);
  if (!m) return { value: null, unreadable: "not a number" };
  const intPart = m[1].replace(/[, ']/g, ""), frac = m[2] ?? "";
  const significant = (intPart + frac).replace(/^0+/, "").replace(/0+$/, "").length;
  if (significant > DIGITS) return { value: null, unreadable: "more than 34 digits" };
  let d = make(BigInt(intPart + frac), -frac.length);
  if (d.c !== 0n && digitCount(d.c) + d.e > DIGITS) return { value: null, unreadable: "too large" };
  if (d.e < EMIN) return { value: null, unreadable: "too small" };
  if (negative) d = neg(d);
  return { value: d };
}

// A number token of JSON as written in answers.json (§8.7): kept apart from words in quotes, so `1e5` is a number
// and `"1e5"` is not.
export class JsonNumber {
  constructor(token) {
    this.token = token;
  }

  toJSON() {
    return this.token;
  }
}

// A JSON number token read exactly, its exponent included (§8.7): { value } or { value: null, unreadable }.
export function parseJsonNumber(token) {
  const m = token.match(/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if (!m) return { value: null, unreadable: "not a number" };
  const [, sign, intPart, frac = "", exp = "0"] = m;
  const significant = (intPart + frac).replace(/^0+/, "").replace(/0+$/, "").length;
  if (significant > DIGITS) return { value: null, unreadable: "more than 34 digits" };
  const c = BigInt(intPart + frac);
  if (c === 0n) return { value: ZERO };
  // An exponent far outside the range says only which way it is out.
  const x = exp.replace(/^[+-]?0*/, "").length > 9 ? (exp.startsWith("-") ? -1e10 : 1e10) : Number(exp);
  const d = make(c, x - frac.length);
  if (digitCount(d.c) + d.e > DIGITS) return { value: null, unreadable: "too large" };
  if (d.e < EMIN) return { value: null, unreadable: "too small" };
  return { value: sign ? neg(d) : d };
}

// Bytecode stores a number as its words; reading them back.
export function fromWords(s) {
  const negative = s.startsWith("-");
  const p = parseLiteral(negative ? s.slice(1) : s);
  if (!p.value) throw new Error(`not a number's words: ${s}`);
  return negative ? neg(p.value) : p.value;
}
