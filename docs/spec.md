# The Stride language specification

This document is the one authority on what a Stride program means. Where the compiler, the machine, the manual
(`grammar.md`) or a test disagrees with it, they are wrong. Every rule is numbered (§3.4.2); the conformance tests
in `tests` name the rule they test in their first line (`# rule 3.4.2`).

Stride is a language for a fillable PDF form's workflow. A program asks a person questions, in an order
and under conditions it states, and writes their answers into the boxes of one exact PDF. How questions are shown,
in which human language, and how a person moves between them belong to the page that runs the program, not to the
language. A program reaches nothing outside: no network, no storage, no page; it never changes the PDF.

Conventions: "a mistake" is refused by the compiler (§16), "a fault" stops a run (§13.4), "empty" is the empty value
(§3.2). Grammar is written `rule = …;` with `[x]` optional, `x*` any number, `x+` one or more, `a | b` either,
`"w"` a word or sign as written.

## 1. Source text

1.1. A source file is UTF-8 text. A file that is not valid UTF-8 is a mistake (S001): a program, a library or a
test file, read as its bytes and checked before anything is decoded. An overlong form, a surrogate (U+D800–U+DFFF)
and a value above U+10FFFF are not UTF-8; U+FFFD written as its three bytes is a character like any other. S001
points to the first byte of the first ill-formed UTF-8 sequence, including one cut short at the end of the file:
its line, and the column following the valid characters before it on that line.

1.2. A line ends at `\n`, `\r\n`, or a lone `\r`; each is one line end.

1.3. Positions are a line (from 1) and a column (from 1). A column counts Unicode code points: every character is
one column, a tab is one column, a character outside the Basic Multilingual Plane (an emoji) is one column.

1.4. A comment starts with `#` outside words in quotes and runs to the end of its line. Comments and whitespace
(space, tab, line ends) separate tokens and are otherwise ignored, with one exception: §6.9 (a line break before
`[` or `(` ends the expression before it) and §7.13 (a `return`'s value is on its line).

## 2. Lexical elements

2.1. **Names**: a letter `a`–`z`, `A`–`Z` or `_`, then letters, digits and `_` (`name`, `maxRows`, `MOST`,
`W2`). A name holding a character outside ASCII is S001, with the rule stated.

2.2. **Hyphenated words**: `long-text`, `yes-no`, `one-of`, `any-of` are each one token, a type name.

2.3. **Keywords** cannot be names: `and as ask because break check collect const continue default define each
else empty export expect fields fill for form if in is let list match most native new no not of options or pdf
pick record return set skip then tick use var when yes`.

2.3.1. **Contextual words** are keywords only in the one place the grammar uses them, and names everywhere else:
`option` at the start of an entry of a question's own options (§8.3), where it is required, and of an option set's
declaration (§5.2), where it may be left out; `any` and `another` after a collect's list
(§8.5), and `any` as a type in a native's parameters or result (§5.6); `faults` after an `expect` statement's expression
(§7.17). So `any(answers)` (§14.4) is a call of the function `any`, and a var may be called `option`.

2.5. **Numbers**: `digits [ "." digits ]`. Digits are `0`–`9`. A number with a leading zero followed by another
digit (`0755`) is mistake S008 (an id with leading zeros is words in quotes). A number's significant digits run from its first
digit that is not 0 to its last digit that is not 0 (`0.00120` has 2, `1200` has 2, `1203` has 4). A number with
more than 34 significant digits, of 10^34 or more (`1234567890123456789012345678901234000`), or finer than
10^-6176 (more than 6176 digits after the point, trailing zeros aside) is mistake S009. A number followed directly by a letter or `_` is mistake S007. There are no
exponents, no hexadecimal, no `_` separators; `-` is an operator (§6.4).

2.6. **Words in quotes**: `"` … `"` on one line. A line end before the closing quote is mistake S002. Inside:

| Written | Means |
|---|---|
| `\"` | `"` |
| `\\` | `\` |
| `\{` `\}` | `{` `}` |
| `\n` | a line break |
| `\t` | a tab |
| `\u{h…}` | the Unicode character with that hexadecimal code, 1 to 6 digits, at most 10FFFF, not D800–DFFF |

Any other `\` is mistake S003; a `\u{…}` out of range or a surrogate is S021. `{expression}` puts the expression's
words in (§6.10); an unclosed `{` is S005, an empty `{}` S006, a lone `}` S004. A `{` inside the braces opens words
in quotes of their own only inside a nested `"…"`.

2.7. **Signs**: `.. == != <= >= => -> += -= *= /= // { } ( ) [ ] , : . = < > + - * / %`. The longest sign that
fits is taken (`//` before `/`, `..` before `.`). Any other character outside words in quotes is mistake S001.

2.8. **Raw tokens**: after `form` and after `pdf` at the start of a program, everything up to whitespace, `#` or
`"` is one token: the form's id (letters, digits, `.`, `-`, `_`, starting with a letter or digit; else S016) and
the PDF's sha256 (exactly 64 hexadecimal digits in small letters; else S017).

## 3. Values and types

3.1. Every value has one of these types:

| Type | Values | Written |
|---|---|---|
| `text` | words: a sequence of Unicode code points, at most 100,000 | `"words"` |
| `long-text`, `phone`, `email` | words, with the shape of their question; they fit wherever `text` does (§3.6) | from answers |
| `number` | an exact decimal (§3.3) | `12`, `1.5` |
| `date` | a day of the Gregorian calendar, 0001-01-01 to 9999-12-31 | from answers, `date_of(…)`, `today()` |
| `yes-no` | `yes`, `no` | `yes`, `no` |
| an option set `S` | one option of `S` (its value, words) | `"value"` where an option of S is expected |
| `set of S` | several options of `S`, without repeats, always in S's declaration order (§3.8) | from `any-of` answers, `["a", "b"]` where expected |
| a record `R` | a value for each field of `R` | `new R { field: e, … }` |
| `list of T most N` | 0 to N values of type T, in order; N a whole number 1–1000 | `[a, b]` |

3.2. **Empty.** Every type also has the empty value, `empty`: an answer not given yet, a field not set. Words of no
characters are empty; a list or set with no items is empty. There is one empty: `empty == ""` and `empty == []`
are yes (§6.6). `x is empty` and `x is not empty` test it.

3.3. **Numbers.** A number is an exact decimal: a whole number of at most 34 significant digits times a power of
ten, of absolute value below 10^34, and a multiple of 10^-6176 (its power of ten is from -6176 up).
- 3.3.1. `+`, `-`, `*` give the exact result when it is a number (§3.3); when it is not, it is rounded once
  (§3.3.3.1).
- 3.3.2. `/` gives the exact quotient rounded once (§3.3.3.1). `1 / 3 * 3` is
  `0.9999999999999999999999999999999999`.
- 3.3.3. A result whose absolute value, after its rounding, is 10^34 or more is fault F003.
- 3.3.3.1. **One rounding.** A result that is not a number is rounded once, from its exact value, to the nearest
  value that has at most 34 significant digits and is a multiple of 10^-6176, both at once; of two equally near,
  the one whose last digit is even. Only then is the size checked (§3.3.3). A result that rounds to nothing is `0`.
  It is never rounded to 34 digits first and then to the multiple: with u = 10^-6176 and
  b = 0.6666666666666666666666666666666667, the exact u / b is just below 1.5u, so u / b is u (rounding first to
  34 digits would give 1.5u, and then 2u). Starting from `n = 0.1`, squaring it 13 times gives `0`; after 12 it is
  10^-4096, and `n == n * 10` is no.
- 3.3.4. `0.1 + 0.2 == 0.3` is yes. There is no negative zero: `-0` is `0`.
- 3.3.5. A number's words (§3.5) are its shortest exact decimal: no exponent, no trailing zeros after the point,
  no point when whole, a `-` when negative: `2.5`, `-3`, `1000000`, `0.000001`.

3.4. **Values are values.** A list or a record is a value, not a place: `var b = a` makes `b` a copy of `a`;
passing a list to a function passes a copy; changing `b`, or a function changing its copy, never changes `a`.
`for each x in l` goes through the items `l` holds when the loop starts; changing `l` inside the loop changes `l`,
not the items the loop goes through.

3.5. **A value's words** (what `fill` writes and `{…}` puts in): text as it is; a number as §3.3.5; a date as
`YYYY-MM-DD`; `yes`/`no` as `yes`/`no`; an option as its value; a set as its option values in declaration order (§3.8),
joined by `, `; empty as no words. A list or a record has no words (mistake S309, S352).

3.6. **Fitting.** A value of type A may stand where type B is expected when:
- A and B are the same type: scalars by name, option sets and records by their declaration, sets by their option
  set; two list types are the same only when their element types are the same and their mosts are equal;
- B is `text` and A is `long-text`, `phone`, `email` or an option of any set;
- B is `long-text`, `phone` or `email` and A is `text`;
- A is empty;
- A is `list of X most M`, B is `list of Y most N`, X fits Y and M ≤ N (a parameter's list without `most` has N
  infinite, §9.3);
- B is an option set S and the value is words in quotes that are one of S's values (checked: S386);
- B is `set of S` and the value is a list of words in quotes, each one of S's values (checked: S386).

3.7. **A list's most.** Every list value carries a most, a whole number 0–1000, at run time as well as in its type.
A most written in a type is 1–1000 (S212, S213); 0 is only the most of the bare `empty` placed where no most is
stated (§3.7.3.1).
- 3.7.1. A list literal's most is its number of items (at least 1); a literal of more than 1000 items is S213,
  at its 1001st item. A list made as the program runs that would pass 1000 is F017 (§3.7.7). A var's or a field's list is its declared most;
  a collected list's is its var's.
- 3.7.2. A list placed where a list type with most N is expected — given to a var, a field, a record's field in
  `new`, an item, a parameter with `most N`, a function's result `-> list of T most N`, an answer's place — fits
  only when its most M ≤ N (S351, S367, S342), and the copy placed there has most N: placing widens, never
  narrows.
- 3.7.3. A parameter `list of T` without `most` takes the most of the argument each call gives: inside the
  function the value keeps the most it came with. Its static most is unknown, so S360 checks only a known position
  below 1 or not whole.
- 3.7.3.1. **The bare word `empty` where a list is expected** becomes a list with no items. Its most is the most
  of the place it goes to when that place states one (`var l: list of text most 4 = empty` has most 4), and 0 when
  it does not: given to a parameter `list of T` without `most`, or as an operand of `l + m` (§6.5.1). A list of most
  0 has no positions: any position read from it is F004. With `define second(xs: list of number) -> number { return
  xs[2] }`, `second(empty)` faults F004 at `xs[2]` whenever it runs; a test shows it: `expect second(empty) faults
  "F004"`. `second([n])`, with n an answer, gives a list of most 1 and is F004 whatever n is; `second([n, n])` gives most 2 and n. `count(empty)` given to such a parameter is 0, and `for each` runs no turns.
- 3.7.4. A function's result type always states its most (S211), except a natives' result, whose most §14 states.
  A result worked out from returns (§9.6) has the largest most of its returns.
- 3.7.5. The most of what an operation makes: a slice `l[a..b]` and a comprehension over l, l's most; `l + m`, the
  sum of the two mosts; the library functions, as §14 states for each.
- 3.7.7. **Mosts known only as the program runs.** When both mosts are known before the form opens, a sum above
  1000 is S395 and a list placed where a smaller most is expected is S351/S367/S342 (§3.7.2). When either comes
  from a parameter without `most` (§3.7.3), the same checks are made on the values' mosts as the program runs:
  `l + m` whose mosts add to more than 1000 is F017 at the `+`; a list whose most M is placed where a list type
  with most N < M is expected is F017 at the place (the assignment, the argument, the return, the field, the item,
  the answer's place); a comprehension, slice or library result whose most comes from such a list carries it, and
  is checked the same way where it is placed. A list's items never exceed its most, so placing checks the most,
  not how many items it holds.
- 3.7.6. Indexing (§6.9.2) and setting an item (§7.5) use the value's most, not a static guess.

3.8. **The order of a set.** A set's options are always in the order their option set declares them, whatever
order they were chosen or written in. With `options s { "b" "B"  "a" "A" }` and the answer `["a", "b"]`, the set is
`b, a`. Every traversal and rendering uses this order: `for each`, a comprehension over the set, `first`, `last`,
`join`, its words (§3.5), `print`, `count` and `in` (where order does not matter), and the results of `union`,
`intersection` and `difference`. Two sets are equal when they hold the same options (§6.6). A question's own
options are declared by its option block, in the block's order.

3.9. **The join of two types.** Where one type must be chosen for two values — the items of a list literal, the
two values of `if … then … else`, the element type of `l + m`, the returns of a function whose result is worked
out (§9.6), the arms of `either` — it is their join, chosen by these rules in order:
1. the same type: that type;
2. one of them the type of the bare word `empty`: the other. This rule is for `empty` itself only; a list is never
   dropped by it, whatever its items hold;
3. both words of different kinds — any two of `text`, `long-text`, `phone`, `email`, or an option and words, or
   options of different sets — `text`, which every one of them fits; so `list of text` + `list of phone` is `list
   of text`, and `list of phone` + `list of email` is `list of text` too;
4. two lists: a list whose element type is the join of their element types, by these same rules applied to the
   elements (so a list of empty items, `list of empty most 3`, and `list of number most 1` give `list of number`),
   and whose most is the larger of the two mosts, at every level: a join never adds mosts. A list never narrows its
   most through a join, and keeps its items: `if c then [empty, empty, empty] else [1]` is `list of number most 3`. Only `l + m`
   (§6.5.1) sums, and only the two operands' own mosts: the element type of the result is the join of the element
   types, by this rule. With `a: list of list of number most 2 most 1` and `b: list of list of number most 3 most
   1`, `a + b` is `list of list of number most 3 most 2`: outer most 1 + 1, inner most the larger of 2 and 3.
   If either most is unknown before the form opens, the joined most is unknown at that level and each value keeps
   its carried most there; known joined mosts at other levels are still widened normally;
5. anything else has no join: S361, S394, S373, S343 at the second value.
The value of an expression whose type is a join is placed into that type (§3.7.2): `if c then [1] else [1, 2]`
gives a list of most 2 whichever branch runs, and an item of a list literal is widened to the literal's element
type. The join never depends on which value comes first, and never picks a narrower kind of words: a `phone` result
is chosen only when both are `phone`. When two different kinds of words join (rule 3), the joined value is `text`:
it fits a `text` or an `email` parameter (text fits email, §3.6), but its kind is no longer phone.

## 4. Files

4.1. **A program**: `program = "form" id "pdf" sha ["fields" plain] item*;` One per form,
`<form>.stride`. `fields "prefix"` is put before every box name the program writes (§10.1).

4.2. **A library**: `library = item*;` in `lib/<name>.stride`; only `use` and declarations (a statement
is S106). `export` makes a declaration visible to files that use the library; in a program `export` is S107.

4.3. **A test file**: `<name>.test.stride` beside a library or a program's library: `use`, declarations, `let`,
and `expect` statements (§7.17); any other statement is S106; `export` is S107, nothing using a test file. Run by
`stride test` (§17).
A test file has no form: its header has no boxes (§10). A reachable `fill`, `tick` or `pick` in its own functions
or through a library's is S508; a reachable `skip` is S503. This includes calls from both `let` and `expect`;
unreachable code follows §11.3.3. Box-writing workflows are tested as programs with their PDF fixtures (§17).

4.4. **The standard library** `lib/std.stride` is used by every file without a `use`; `use "std"` is S101; it uses
no other library (S105). Only it declares natives (S108).

4.5. **use**: `use "path" [as name]`. Path: small letters, digits, `-`, `_`, with `/` between folders (S102);
The library is looked for in the program's `lib/`: the `lib/` beside the file being compiled (the program, the
script, or for a test file the `lib/` it is in), and then in its project's library folders (§4.7), in that order;
the first that holds `<path>.stride` is used, and none is S104. A library's own `use` is looked for in the same
folders, those of the file being compiled, never folders beside the library. Without `as`, the library's exports are visible by their names; two
libraries exporting one name to the same file is S109. With `as n`, they are visible as `n.name` and `n` names
nothing else (S110, S111, S112). Libraries using each other in a circle is S103.

4.6. **A script**: `script = item*;` a file given to the compiler, not a test file, whose first item is not
`form`. It is a program without a form: everything a program may hold, run by `stride run` and tested by `stride
test` like one, with an empty header (§10): a reachable `fill`, `tick` or `pick` is S508 and a reachable `skip` is
S503, as in a test file. `print("hello")` alone is a whole script. `use` finds libraries in `lib/` beside it, as a
program's.

4.7. **A project** is a folder holding `stride.json`: `{"stride": "MAJOR.MINOR", "libraries": [folder, …]}`.
`stride` is the oldest version of the tools its programs need; `libraries`, optional, names more folders to find
libraries in, relative to the project. The project's library folders are its `lib/` and those. A file belongs to
the project of the nearest `stride.json` in its folder or above; a file with none is in no project and finds
libraries in the `lib/` beside it alone. A program with no file of its own (`stride run -`, `stride eval`, `stride
repl`) stands in the folder the command is run in: it finds libraries as a file there would.

A file in one of a project's library folders, or in a folder named `lib`, is a library, named by its path there:
`vendor/greet.stride`, with `vendor` named, is the library `greet`. The editor (§17.16) checks it as a library and
`stride check` of a folder leaves it to the programs that use it (§17.13).

A project whose `stride` has another major version than the tools', or a higher minor, is refused before
anything compiles (`stride.json: the project needs Stride 1.9, and these tools are Stride 1.0.0; upgrade stride`,
exit 1); so is a `stride.json` that is not that object, with what is wrong. `stride init [folder]` writes
`stride.json` with the tools' MAJOR.MINOR and an empty `lib/`; it writes over nothing (exit 1 when `stride.json`
is there).

## 5. Declarations

5.1. **record**: `"record" name "{" (name ":" type [","])* "}"`. Field names are unique (S218). A record may not
hold itself through its fields, directly or through other records (S217); through a list it may not either.

5.2. **options**: `"options" name "{" (["option"] plain string)* "}"`. Values unique (S215), not empty (S216); at
least 1 and at most 1000 options (S235), the same bound as a list's most. A question's own options obey the same. The
printed words are the words beside the box on the PDF (§10.6).

5.3. **const**: `"const" name [":" type] "=" expr`. Its value is known before the form opens (§11): words, a
number, a date, yes or no, a set, or a list of them; not a record (S306); worked out at compile time (S304); not made of itself (S303).

5.4. **define**: `"define" name ["<" name ("," name)* ">"] "(" [param ("," param)*] ")" ["->" type] block`.
`param = name ":" type ["=" expr]`. §9.

5.5. **native define**: only in the standard library: `"native" "define" name "(" params ")" ["->" type]`. As for
a function (§9.6), a native without `-> type` gives no value, and its call is a statement: `native define fail(message:
text)`, `native define print(v: any)`. A native's parameters may have defaults (§9.2). The machine must have the
native with as many parameters (S301, S302).

5.6. **Types written**: `text long-text phone email number date yes-no`, an option set's name, `set of` an option
set's name, a record's name, `list of T most N` (N a whole number 1–1000 known before the form opens: S212, S213;
`most` may be left out only in a parameter: S211), a type parameter's name inside its function, and the native-only
markers `any` and `element` (S214 elsewhere). A name that is not a type is S209. Unless §14 specifies otherwise,
an `any` result has the first argument's type after binding and conversion; an `element` result has its list-item
type, or its option type for a set. `either` returns the join of both argument types (§3.9, §14.5).

5.7. Declarations may be used anywhere in their file, before or after the line they stand on.

## 6. Expressions

6.1. Grammar, loosest first:

```
expr        = cond | or;
cond        = "if" expr "then" expr "else" expr;
or          = and ("or" and)*;
and         = not ("and" not)*;
not         = "not" not | compare;
compare     = sum [ ("=="|"!="|"<"|"<="|">"|">=") sum | ["not"] "in" sum | "is" ["not"] "empty" ];
sum         = product (("+"|"-") product)*;
product     = unary (("*"|"/"|"//"|"%") unary)*;
unary       = "-" unary | postfix;
postfix     = primary ( "." name | "[" expr ["..", expr] "]" | "(" [args] ")" )*;
args        = arg ("," arg)*;  arg = [name ":"] expr;
primary     = number | string | "yes" | "no" | "empty" | name | "(" expr ")"
            | "[" [expr ("," expr)*] "]"
            | "[" expr "for" "each" [name ","] name "in" expr ["if" expr] "]"
            | "new" qname "{" (name ":" expr [","])* "}";
```

Comparisons do not chain (`a < b < c` is S014).

6.2. **Evaluation order.** Operands left to right; a call's arguments left to right, after the function is known;
`and` and `or` decide on the left when they can and then do not work out the right; `if c then a else b` works out
`c`, then only the chosen branch.

6.3. **Empty in operations.** An operation given empty: `+` of numbers or of words gives the other operand (`5 +
empty` is 5, `"a" + empty` is "a"); `+` of lists is always concatenation (§6.5.1), never the other operand; `- * / // %` give empty; `-empty` is empty; a comparison `< <= > >=` with empty is no; `==` §6.6;
`not empty` is yes (an empty yes-no counts as no in a condition).

6.4. **Arithmetic.** Binary `- * / // %` require numbers (S374 otherwise), except date minus date is S375.
For `+`, the valid operations are described in §6.5 and §6.5.1; number with words is S372, and other unsupported
combinations are S373:

| Op | Result | Fault |
|---|---|---|
| `a + b` | sum (§3.3.1) | F003 |
| `a - b` | difference | F003 |
| `a * b` | product | F003 |
| `a / b` | quotient (§3.3.2) | b = 0: F001; F003 |
| `a // b` | q, the greatest whole number ≤ a/b, from the exact quotient (6.4.1) | b = 0: F002; \|q\| ≥ 10^34: F003 |
| `a % b` | r = a − b·q, exact (6.4.1) | b = 0: F002 |
| `-a` | negation | |

6.4.1. **Floor division and remainder are exact.** `a // b` and `a % b` never use the rounded quotient of `/`: q
is the floor of the exact rational a/b, and r = a − b·q is worked out exactly; only then is the result checked
and, for r, rounded.
- q is a whole number. When |q| ≥ 10^34 it cannot be represented and `a // b` is F003; `a % b` is still defined,
  since it never needs q to be represented: r is a − b·⌊a/b⌋ worked out exactly.
- r has the sign of b (or is 0) and |r| < |b|, so it never overflows. When r has more than 34 significant digits
  (possible only when a has digits below b's smallest), it is rounded to 34, half to even; its sign and |r| < |b|
  are kept (a rounding that would reach |b| gives the largest value below it at 34 digits).
- Example: a = 8×10^33 − 1, b = 4×10^33: `a / b` is 2 (rounded), `a // b` is 1, `a % b` is 4×10^33 − 1.
- The identity a = b·q + r holds as mathematical equality over the exact values q and r whenever `a // b` does not
  fault and r was not rounded. The Stride expression `a == b * (a // b) + a % b` is evaluated like any other,
  each operation rounding as §3.3.1 says. It is guaranteed yes when the remainder was not rounded and `b * (a // b)` and the
  sum are exact and representable; for a = −10^−35, b = 1, q = −1 and the exact r = 1 − 10^−35 rounds to
  1 − 10^−34, so the exact product and sum give −10^−34, not a; when either rounds, it may be yes or no. For a = 10^34 − 5, b = 1.5 (r = 0.5) `b * q` rounds to
  a − 1, the sum to a − 1 again, and it is no; for a = 10^34 − 1, b = 1.7 (r = 0.4) `b * q` rounds to a, the sum to
  a again, and it is yes.

6.5. **Words.** `a + b` with both words (any of text, long-text, phone, email, an option) joins them; the result is
`text`. A number and words is S372 (write `"…{n}…"`). The result longer than 100,000 characters is F012.

6.5.1. **Lists.** `l + m` with l a `list of X most M` and m a `list of Y most N`, X and Y with a join (§3.9; S373 otherwise), is a new list: l's items, then m's, of type `list
of` the join of X and Y `most M + N` (S395 when M + N > 1000 and both are known; F017 at run time otherwise, §3.7.7).
The most is the sum whether or not either list holds items: an empty list contributes its most and no items. The
word `empty` standing alone as an operand of a list `+` is the empty list of the other's type with most 0
(§3.7.3.1), so `l + empty` has l's items and most. Example: `var a: list of number most 2 = [1]`, `var b: list of number most 3`; `a
+ b` holds `[1]` with most 5, so `(a + b)[4]` is empty; with `ask i: number "Item"` answered 6, `(a + b)[i]` is
F004 (a known 6 would be S360, §11.3.5).

6.6. **Equality** `==`, `!=`: of two values of one type, or words with words, or an option with words (the words
checked against the set's values: S386), or two options of different sets (their words compared); else S378 (yes-no with words S376; a set with `==` against words S377).
Two values are equal when both are empty, or neither is and: words have the same code points; numbers the same
value; dates the same day; yes-no the same; options the same value; sets the same options; records of one type
every field equal; lists the same length and every item equal. Two lists compare when their element types join
(§3.9), whatever their mosts; their contents are compared item by item, at every depth, the mosts ignored, and
neither operand is widened or otherwise changed by the comparison.

6.7. **Order** `< <= > >=`: two numbers by value, two dates by day, two words (any text-like, an option's value
among them) by Unicode code points from the first, a shorter word before its longer continuation; `o < "b"` takes
"b" as words, whether or not it is one of o's set. Anything else is S379. A list of options sorts by the same
order (`sorted`, `smallest`, `largest`); a set keeps its declaration order (§3.8) and is not sorted (S369).

6.8. **Membership** `x in s`, `x not in s`: `s` a set of options and `x` an option of the same set or words (S381,
S382, S386); or `s` a list and `x` of its element type (S383): yes when an item is equal (§6.6). On words it is
S384 (`contains(t, part)`).

6.9. **Postfix.** A line break before `[` or `(` ends the expression before it: the bracket starts a new one.
- 6.9.1. `r.f`: the field f of record r. r of a type without fields is S357; no such field S318 (with a hint).
  `r.f` of an empty record (an absent list item) is empty.
- 6.9.2. `l[i]`: i a number (S358), l a list (S359). i not whole, or below 1, or above l's most, is F004 (and
  S360 when i is known before the form opens). i above the number of items is empty (a form's empty row).
- 6.9.3. `l[a..b]`: the items a to b, a list of l's element type and most. a, b whole (F004); a < 1 counts from 1;
  b beyond the items stops at the last; a > b gives an empty list.
- 6.9.4. `f(args)`: a call (§9).

6.10. **Words with values**: `"Line {n + 1}"` puts the words (§3.5) of each value in; a list, a record or no value
is S352.

6.11. **List literal** `[a, b, …]`: its element type is the join (§3.9) of its items' types, taken left to right
(S361 when two have none); its most the number of items (at least 1). An empty
`[]` takes its type from where it stands; `let x = []` is S328.

6.12. **Comprehension** `[e for each [n,] x in l if c]` (l a list or a set): for each item x of l (n counting from 1) for which c is
yes, the value of e, in order. Its type is `list of` e's type `most` l's most when l is a list, and, when l is a set, the number of options its
option set declares (a set of `options s { "a" "A"  "b" "B" }` with one chosen gives a list of most 2 holding
one item). An option set declares at most 1000 options (S235), so this most is always 1–1000. x and n are known only inside it.
A comprehension may not ask, write boxes or collect (S398, at the call in it that does).

6.13. **Conditional** `if c then a else b`: c yes-no (S310); its type is the join (§3.9) of a's and b's (S394 when
they have none): `if c then "x" else phone` is text; `if c then [empty, empty] else [1]` is `list of number most 2`.

6.14. **new R { f: e, … }**: a record with the given fields, the others empty. Unknown field S363, twice S362,
type S364.

6.15. **Conditions** (`if`, `tick … when`, `check`, `and`, `or`, `not`, comprehension `if`) are yes-no (S310,
S311, S380); empty counts as no.

6.15.1. **`and`, `or` and `not` always give `yes` or `no`, never empty.** Their operands are read as conditions
(empty is no), and the result is:

| a | b | `a and b` | `a or b` |
|---|---|---|---|
| yes | yes | yes | yes |
| yes | no | no | yes |
| yes | empty | no | yes |
| no | yes, no or empty | no (b not worked out) | b read as a condition: yes, no, no |
| empty | yes, no or empty | no (b not worked out) | b read as a condition: yes, no, no |

`yes or b` is yes without working out b. `not yes` is no; `not no` and `not empty` are yes. So with a unanswered,
`(yes and a) is empty` and `(no or a) is empty` are both no, in every engine. Comparisons,
`in` and `is empty` likewise always give yes or no.

## 7. Statements

7.1. `statement = ask | let | var | fill | tick | pick | skip | if | match | for | foreach | collect | break |
continue | return | assign | call | expect;` A block is `{ statement* }`. Nested blocks, brackets and expressions
deeper than 200 levels are S019, at the place. Each operator in an expression chain adds one level of nesting,
including unary operators and postfix field access, indexing, slicing and calls.

7.2. **ask** `ask target ":" qtype "printed words" [options-block] modifier*` asks a question (§8). The target is
a name followed by zero or more `.field`s; any other shape is S010. S319 stands for a target of that shape that
cannot receive an answer.

7.3. **let** `let name [":" type] "=" expr`: a name for a value that does not change.

7.4. **var** `var name ":" type ["=" expr]` or `var name "=" expr`: a name for a value that may change. Without a
value, a list or record starts empty, anything else must be given one before it is read (S407). `var x = empty`
without a type is S327; a `let` or `var` without a type whose value is a list no item of which tells its type, at
any depth (`[]`, `[empty, empty]`, `[[empty]]`), is S328; with a type, `let xs: list of number most 2 = [empty,
empty]` is valid. In these empty-type inference cases, an inferred function result is S344 (§9.6), and a generic
call is S368 (§9.5.1).

7.5. **assign** `target "=" expr`, `target op= expr` (op `+ - * /`): target a var, a var's field or a var's item
(S345–S349). `x += e` is `x = x + e` with x's place worked out once. An answer, a let, a constant, a parameter, a
loop's counter, an item, a collected list's items cannot be given a value (S345, S346, S348).
`l[i] = v` with i not whole or outside 1 to (items + 1) or above l's most is F005.

7.5.1. **The steps of an assignment**, in this order; a fault at any step stops the run there and nothing later
happens:
1. **The place.** The target's var is found; the path after it is worked out from left to right (`xs[i][j].f`:
   i, then j, then f), each position's expression evaluated as it is reached. Which check a component gets depends
   on whether it is the path's final component, the destination itself:
   - **every component but the final one is a read**, whatever kind it is: a position is checked as §6.9.2 reads
     it (F004 when it is not whole, below 1, or above that list's most), and must name an item that is there: a
     position past the items, read on the way to a field or a deeper position, is F020 (there is no row to change);
   - **the final component is the destination**: when it is a position, it is checked as a place to set (F005: not
     whole, outside 1 to items + 1, or above the list's most); when it is a field, the record before it is the one
     changed.
   - **an empty record at a place that is there is made before its field is written.** When a component before
     a field reaches a place that exists — the var itself, a field of a record, or an item within the list's items —
     and that place holds empty, a record of the field's record type is put there first, every field empty, and the
     path goes on through it. This applies at every level: in `p.home.city = "Paris"` with p empty, p becomes a
     person, then its `home` an address, then `city` is set. Only a place that is not there faults: a position past
     the items is F020, whether or not records would be made after it. So `var p: person` then `p.name = "Ada"`
     gives p the name Ada; `var xs: list of person most 2 = [empty]` then `xs[1].name = "Ada"` makes `xs[1]` a
     person named Ada; `xs[2].name = "Ada"` on that list is F020.

   So: `xs[i] = v` checks i with F005; `xs[i].name = v` reads i (F004, or F020 past the items) and then sets the
   field; `xs[i][j].name = v` reads both i and j (F004 or F020). With i = 0, `xs[i] = v` is F005, and
   `xs[i].name = v` is F004.
2. **The value.** Only then is the right-hand expression evaluated.
3. **Placing.** The value is converted (a bare `empty` to a list, §3.7.3.1), copied (§3.4), and checked against
   the place's most (F017, §3.7.7).
4. **Storing.** The place takes the value.

So `xs[i] = 1 / z` with i = 0 and z = 0 stops with F005 at `xs[i]`, and `1 / z` is never worked out.

**Augmented assignment** `x op= e`: step 1 as above, once; then the place's current value is read (an item past the
items reads as empty); then e is evaluated (step 2); then the operation is applied to the current value and e
(§6.3–§6.5, which may fault); then steps 3 and 4. The place is never worked out twice: in `xs[next()] += 1` the
call runs once.

7.6. **fill** `fill "box" = e`: writes e's words (§3.5) into a text box or a list box. Words the compiler knows are not one of a
list box's entries are S514; words it cannot tell beforehand go in as they are. e yes-no is S307, a set
S308, a list or record S309.

7.7. **tick** `tick "box" when c`: ticks the check box (with its own export value) when c is yes, else leaves it
unticked.

7.8. **pick** `pick "group" "button" when c`: picks that button when c is yes.

7.9. **skip** `skip "box" because "reason"`: a box the workflow leaves alone.

7.9.1. **Words, or an expression that gives them.** Where a statement takes words that must be known before the
form opens (§11.2) — a box's name and a button's, a question's printed words, a check's message, a skip's reason,
a collect's questions, the words after `faults` — they are written in quotes, or as an expression that starts with
a name and gives them: after `const name_box = "f1_01[0]"`, `fill name_box = full_name` fills that box; with
`const QUESTIONS = ["First?", "Second?"]`, `ask ok: yes-no QUESTIONS[i]` asks each in its turn of a loop.

7.10. **if** `if c { … } [else if … | else { … }]`; **match** `match e { "a", "b" => { … } … [else => { … }] }`:
e an option or words (S329); values unique (S331), of the set when e is an option (S332); `else` last (S330); a
match on an option with no `else` that misses options gives warning W001.

7.11. **for** `for i in a..b { }`: a and b are worked out once, a then b, before the first turn, and never again;
i then takes each whole number from a to b; none when a > b. Changing what a or b was made of inside the loop does
not change its turns: with `var stop = 1`, `for i in 1..stop { stop += 1 }` runs once and leaves `stop` 2. a and b
are numbers (S313); an empty or non-whole bound is F004: empty is never taken as 0 or as a loop of no turns. Each bound is evaluated and checked completely before the next is evaluated: an empty or non-whole first bound faults before the second bound is worked out. `for each` works out its list once, before the first turn (§3.4). **for each** `for each [n,] x in l { }`: l a list or a set (S314), §3.4.

7.12. **break** ends the innermost `for` or `for each`; **continue** goes to its next turn. Outside one, or inside
a collect, they are S233, S234.

7.13. **return** `return [e]`: ends the function (with e) or the program (no value: S338). e is on the return's
line. Statements after a `return`, `break` or `continue` in the same block never run (S406).

7.14. **call** `f(args)` on its own: a call for what the function does.

7.15. **collect** §8.5.

7.16. Scopes §12.

7.17. **expect** (at the top level of a test file only; in a program, in a library, or inside any function, a
test file's included, it is S236): `expect e ["words"]`: e yes-no; the expectation fails with the words when e is
not yes.
`expect e faults "code or words"`: working out e must be a fault. The words are known before the form opens (S412). A selector matching F[0-9]{3} exactly matches
only the fault code. Every other selector matches a case-sensitive substring of the message. There is no message
fallback when the code differs: `fail("F001 happened")` faults with F013, and does not satisfy `faults "F001"`. The test passes only when
both engines give that fault. Its expression may be a call of a function that gives no value (`expect fail("stop")
faults "F013"`): S370 does not apply there.

7.17.1. **Running a test file.** Its statements run in order, with no answers given (every question asked takes
its default or is empty). Each `expect` is its own sub-run: what its expression does — questions reached, words
printed — is dropped when it ends; box operations are refused by §4.3. The `let`s run on the file's one path,
and each expectation starts from the state the lets before it left: a question a `let` already asked, asked again
in an `expect`, is S507; separate expectations may each ask it. Nothing it did changes
the test file's names (a function changes only its copies, §3.4). An `expect … faults` catches the fault at its boundary: when it
matches, the expectation passes and the file goes on with the next statement; when the expression finishes
without a fault, or with another fault, the expectation fails and the file goes on. A plain `expect e` whose e
faults fails, and the file goes on. A fault outside any `expect` (in a `let`) stops the file: the expectations
after it are reported as not run. Every expectation's result is reported, in order.

## 8. Questions

8.1. Question types: `text long-text number date phone email yes-no one-of any-of`. The answer's type: the same
scalar type; an option of the set for `one-of`; `set of` the set for `any-of`.

8.2. `one-of S` / `any-of S` take S's options; or the question has its own block (8.3); both is S223, neither
S224; options on another type S225.

8.3. Own options: `{ option "value" "printed words" … }` (`option` is required here: S022).

8.4. Modifiers: `default e` (at most one: S323; e of the answer's type: S322): the value the answer has until the
person gives one. `check c "message"`: a condition the answer should meet; when it does not, the page shows the
message; the answer stays. A question may have several checks; default and checks may be written in any order,
which changes nothing below.

8.4.1. **The steps of an ask**, in this order; a fault at any step stops the run:
1. **Key and words.** Its key (§8.6) and printed words are worked out, then the printed words of its own options,
   in order.
2. **Default.** The default's expression is worked out, always, whether or not an answer was given (the page
   shows what was offered): a default that faults faults even when the person has answered. It is worked out
   before the answer is bound, so it sees the place as it was: a new name being asked is not yet defined
   (`ask n: number "N" default n + 1` is S202, n being used before it is defined), while a record's field that
   already holds a value sees it: after `r.age = 40`, `ask r.age: number "Age" default r.age` offers 40. A field is
   asked at most once (S321).
3. **Answer.** When the answers hold the key, the answer given is converted (§8.7) and the value is the converted
   answer, whatever it is: an answer given as no words or no options chosen is a valid empty answer, with no
   unreadable mark; an answer that does not convert (§8.7) is empty and marked unreadable with its reason; both stay
   empty — the default never comes back once the person has answered, so a
   prefilled name can be cleared and every option of an any-of deselected, and an unreadable number never puts the
   default into the PDF. Only when the answers do not hold the key at all is the value the default, or empty
   without one.
4. **Binding.** The value goes into its place: a new name is defined from here on (§12.2); a field or an item is
   set by §7.5.1 (an empty record on the way is made).
5. **Checks**, each in the order written, with the value bound: when the value is empty, no check is worked out
   and none fails. Otherwise each condition is worked out; when it is no, its message is worked out and recorded;
   when it is yes, its message is not worked out (so a passing check's message cannot fault). Every check is
   worked out, not only up to the first that fails; the step records the failed checks' messages in the order the
   checks are written. A default standing for an answer not given is checked like an answer.

8.5. **collect** `collect [n,] x in l [any "Any…?"] [another] "Another…?" { … }`: l a var of type `list of T most
N` that starts empty (S333, S334, S336), collected once (S337); T a record or a scalar (S335). It asks the block
for item 1, then the yes-no question "Another…?"; on yes the next item, up to N. With `any`, it first asks the
`any` question; on no the list stays empty. The items are answers (S346).

8.5.1. **When an item enters the list.** The item being asked is x; it enters l only when its block has finished.
So inside the block for item k, `count(l)` is k − 1, `l[k]` is past the items (empty, §6.9.2), and the item's own
answers are read through x (`x.name`), not through `l`. After the block, the item is appended; then, when l holds
N items, the collect ends without asking "Another…?"; otherwise it asks it, and a yes starts item k + 1, a no (or
no answer yet) ends the collect.

8.6. **Keys.** Each question a run reaches has a key: a string worked out as the program runs, by this
construction, the same in every engine. Two questions reached on one path with the same key are S507.

8.6.1. **Grammar of a key.**
```
key      = (segment ".")* (tail | item turns) | (segment ".")* list generated;
segment  = call turns | item turns;
call     = function "(" [arg (";" arg)*] ")";
function = [library ":"] name;                 # library: the use path, e.g. people or forms/irs
arg      = name "=" value;
item     = name "[" whole "]";                 # a collect's list and the item's number
tail     = name ("." name)* turns;
generated = ("#any" | "[" whole "]#another") turns;   # a collect's own questions
list     = name;
turns    = ("[" whole "]")*;                   # loop turns, outermost first
```

8.6.2. **Construction.** The key of a question is built from the run's position, outermost first:
- each call, on the path from the program's start to the question, of a function that can reach a question (it
  asks or collects, or calls a function that can) adds the segment `function(args)`, with an empty argument list
  when the function has no known-only parameters: `first().name` and `second().name` are two questions. A call of
  a function that cannot reach a question adds nothing, since no key is built inside it;
- the function is written by its name, after its library's use path and `:` when it is declared in a library
  (`people:line_2(…)`), so two libraries' functions of one name never share a key; the program's own functions
  and the standard library's are written by their names alone;
- args are the function's known-only parameters (§11.2), every one, in the order the function declares them, each
  `name=value`, whether the call gave it by position, by name or by its default (§9.2): the key depends on the
  values, never on how the call was written;
- each collect item the question is in adds the segment `list[n]`;
- the loops (`for`, `for each`) between one segment (or the start) and the next add their turns to that next
  segment, or to the tail: `[i]` for a `for` (its counter's value) and `[n]` for a `for each` (the item's number);
- the tail is the question's name, or the field path it answers (`r.name` is written `name` after its item
  segment), then its turns. A question that answers a collect's item itself (a scalar collect, `collect x in names
  "…" { ask x: text "Name" }`) has no tail: its key ends with the item segment, `names[1]`.
- **A collect's own questions** are written with `#`, which no name or field can hold: `list#any` and
  `list[n]#another`, followed by the turns of the loops between the segment before them (or the start) and the
  collect, outermost first, as any key's last part carries its turns. In

  ```
  for i in 1..2 {
    var names: list of text most 2
    collect x in names any "Any?" "Another?" { ask x: text "Name" }
    fill "Name{i}" = first(names)
  }
  ```

  answered `names#any[1]` yes, `names[1][1]` "Ada", `names[1]#another[1]` no, and the same in the second turn, the
  questions are `names#any[1]`, `names[1][1]`, `names[1]#another[1]`, `names#any[2]`, `names[1][2]`,
  `names[1]#another[2]`: every turn its own key. With `most 1` instead, `#another` is never asked (§8.5.1): the
  questions are `names#any[1]`, `names[1][1]`, `names#any[2]`, `names[1][2]`. A record field called `another` or `any` is an ordinary tail, `rows[1].another`, and can never
  meet them.

8.6.3. **Values in a key.** Every type a known value can have (§11.1) has one encoding. A number by its words
(§3.3.5); a date `YYYY-MM-DD`; `yes`, `no`; empty by its type: an empty list `[]`, an empty set `{}`, and empty of
every other type (words, a number, a date, yes-no, an option, a record) `empty`, so each value has one encoding; a
list as `[` its items' encodings
joined by `,` `]` (`[]` when it holds none; its most is not part of the key); a set as `{` its options' encodings
in declaration order (§3.8) joined by `,` `}`; a record as its name, then `{` each field `name=encoding` in the
record's declaration order, joined by `;` `}`; words and options as a JSON string literal: `"` … `"`, with exactly this mapping, the one JSON.stringify uses: `"`
as `\"`, `\` as `\\`, U+0008 as `\b`, U+0009 `\t`, U+000A `\n`, U+000C `\f`, U+000D `\r`, every other
character U+0000–U+001F as `\u00` and two small hexadecimal digits (`\u001f`), and every other character, `/` and
U+007F and everything outside ASCII included, as itself. So a line break is always `\n`, never `\u000a`. So the arguments
`("a,b", "c")` and `("a", "b,c")` give `f(x="a,b";y="c")` and `f(x="a";y="b,c")`, which differ, and no value can
end a segment early.

Since every word is quoted, the signs `[ ] { } , ; = ( ) .` of the encodings can never come from a value, and
two different values of one type give different encodings — with one deliberate exception: a list's most is not
encoded, so two lists with the same items and different mosts give the same encoding (a key names the items a call
was given, not the room it had). `split("a,b", ",")` is `["a","b"]`; the list `["a,b"]` is `["a,b"]`.

8.6.4. **Examples.** `first().name`; `items(parts=["a","b"]).count`; `representatives[2].name`; `other_act[1]`; `line_2(n=2).name`; `people:address(who="spouse").city`;
`trips#any`; `trips[3]#another`; `names[2]` (a scalar collect's item); in `for i in 1..2 { for each n, c in kids { ask … } }`, `age[1][3]`.

8.7. **Answers given** come as the page holds them and are converted to the question's type; what does not convert
is empty (never a fault):
- **what an answer may be given as**: a words question (text, long-text, phone, email) takes words, or a JSON
  number as its exact token (`1.50` is the words `1.50`); anything else (yes or no, a list, an object) is empty,
  marked unreadable `not words`. A number question takes words or a JSON number; anything else is `not a number`.
  An answer given as JSON `null` is a valid empty answer, with no unreadable mark; only a key the answers do not
  hold at all brings the default (§8.4.1);
- words (text, long-text, phone, email): the words as given; nothing is empty; more than 100,000 Unicode code
  points (§3.1) is empty, marked unreadable `too long`: never cut short, never a fault, and the answer is still
  given, so its default does not come back (§8.4.1);
- number: optional spaces (U+0020; a tab or any other white space is not one), an optional `+` or `-`, optional
  spaces, digits with `,`, space or `'` between groups, an optional `.` and digits (digits on both sides of the point: `0.5` and `5.0` are numbers, `.5` and `5.` are not), optional spaces; `$ € £` ignored; else empty. `0x10`, `1e5`, `12abc` are empty. A number written with more than 34
  significant digits, of absolute value 10^34 or more, or finer than 10^-6176, is not rounded: it is empty, and the
  step is marked `unreadable` with the reason ("more than 34 digits", "too large", "too small") for the page to show, as a failed check is.
  When separators are used, the first group contains one to three digits and every following group exactly
  three. Separators occur only in the integer part and may be mixed. Ungrouped digits are also allowed. Thus
  `12,345` is valid; `1234,567` and `1,23` are not. An answer of only `$ € £` and plain spaces is a supplied empty
  answer, with no unreadable mark and no default; a sign alone (`-`, `+ `) is `not a number`;
- **Digits are kept from the person to the machine.** A host gives a number answer as the words the person typed
  whenever it has them. `stride run` and `stride test` read `answers.json` with every JSON number taken from its
  digits as written, never through a binary float (`12345678901234567890.25` stays exact). A host that hands the
  machine a JavaScript number gives up digits beyond what the float holds; the machine reads it from its shortest
  round-trip decimal (`0.1` is 0.1);
- **A JSON number in `answers.json`** is read exactly from its token, an exponent included: `1e5` is 100000 and
  `1.5E-7` is 0.00000015, never through a binary float and never rounded; the limits above apply to the number it
  writes (more than 34 significant digits, 10^34 or more, finer than 10^-6176: empty, unreadable). Words in quotes
  are read as a person's words: `"1e5"` is not a number. A words or one-of question given a JSON number receives
  the token as written, as its words (`1e5` is the words `1e5`). Number literals in programs are unchanged (§2.5);
- **the reasons an answer is unreadable**, the only ones: for a number `not a number`, `more than 34 digits`, `too
  large`, `too small`; for a date `not a date` (not `YYYY-MM-DD`, or no such day); for yes-no `not yes or no`; for one-of `not one
  of the options`; for any-of `not among the options` (when any value given is not an option: the others are
  kept); for words (text, long-text, phone, email) `too long` and `not words`;
- date: `YYYY-MM-DD` of a real day;
- yes-no: exactly `yes`, `Yes`, `on`, `true` and JSON true for yes; `no`, `No`, `Off`, `false` and JSON false for
  no; `null` and `""` are a valid empty answer; any other spelling is `not yes or no`;
- one-of: one of its values, given as words or a JSON number's exact token; anything else (a list among them) is
  `not one of the options`. any-of: a list of such members, giving those of its values named, in declaration order
  (§3.8); a member that is none of its values, or not words or a number, is `not among the options`, and the
  valid members are kept; an empty member (`null`, `""`) adds no option; an answer that is not a list is `not
  among the options`, and `null` or `""` as the whole answer is a valid empty one.

## 9. Functions

9.1. A function sees its parameters, its own names and its file's declarations; not the program's answers (S204).

9.2. **Parameters** with a default `name: type = e`: e known before the form opens (S393), of the parameter's type;
a required parameter after one with a default is S392.

9.3. A parameter's `list of T` without `most` takes a list of any most.

9.4. **Calls**: positional arguments first, then named `name: e` (S390). A named argument names a parameter (S388,
with a hint) not given already (S389). Every parameter without a default is given (S365). At most 255 arguments
and 255 parameters (S601). Each argument fits its parameter (S367). A value given goes as a copy (§3.4).

9.4.1. **Binding, step by step.** The arguments are bound in the order they are written, positional then named,
each completely before the next is worked out: the argument's expression is evaluated, then at once converted to
its parameter (a bare `empty` to a list, §3.7.3.1), copied (§3.4), and checked against the parameter's most at run
time (F017, §3.7.7); only then is the next argument evaluated. Parameters not given take their defaults after the
last argument is bound (a default is known and cannot fault). The function's body starts after every parameter is
bound. So in `takes_one(xs, 1 / z)`, with takes_one's first parameter `most 1`, xs carrying most 2 and z zero, the
run stops with F017 at `xs`, and `1 / z` is never worked out.

9.4.2. The same order holds wherever a value is placed (assignments: §7.5.1); in `new R { … }` and a list literal each field or item is evaluated
and checked before the next; a function's returned value is checked against its result type's most when the
`return` runs.

9.5. **Generic functions** `define f<t>(l: list of t) -> t` (a type parameter is a name like any other, §2.1:
`t`, or `T` written wholly in capitals; the `T` and `R` of §14's signatures are notation for the library's own): each call works out t from its arguments; t in no
parameter is S221; a call where the arguments do not tell t is S368.

9.5.1. **How a call binds a type parameter.** Every argument whose parameter mentions t gives t a candidate: the
argument's type where the parameter is `t`, the element type where it is `list of t` (at any depth). The binding
is the join (§3.9) of all the candidates, whatever order the arguments are written in; `empty` gives no candidate.
The candidates are taken from the arguments in the order they are written, then from the defaults of the
parameters not given, in the parameters' order; a join that succeeds does not depend on that order, and S367 names
the first written argument that brings a conflict: in `choose(b: "x", a: 1)` it is `1`.
With `define choose<t>(a: t, b: t) -> t`, `choose(phone_answer, "x")` and `choose("x", phone_answer)` both bind t
to text, so either result fits an `email` parameter. When the candidates have no join (a number and words), the
call is S367 at the first argument whose candidate does not join the ones before it. Once t is bound, every
argument is checked against its parameter with t replaced (§3.6), mosts included: a parameter `list of t most 3`
still takes no list of most 4.

9.5.2. **A worked-out result through a list without a most.** A function without `-> type` whose return gives a
list whose most is not known before the form opens (a parameter `list of t` without most, or something made from
it) is S211 at that return: its result type must be written, `-> list of number most 10`; the returned list is
then checked against it as the program runs (F017, §3.7.7). `define keep(xs: list of number) { return xs }` is
S211; `define keep(xs: list of number) -> list of number most 10 { return xs }` is allowed.

9.6. **Result**: `-> type`, or worked out from the returns when not written (S343, S344). A function with a result
returns one on every path (S405). One without `-> type` has its result worked out from its returns, so a value
returned is never a mistake, and its call is a value like any other: with `define identity(n: number) { return n }`,
`let x = identity(1)` is allowed. A function with no result (no `-> type`, and no return with a value, so nothing
is worked out) gives no value: its call is a statement, and used as a value it is a mistake: S324 when a `let` or
`var` keeps it, S370 anywhere the table of §16.4 names no more particular code.

9.7. A function may not reach itself, directly or through others (S401, S402).

9.8. `r.f(args)` is `f(r, args)`. A library kept under a name lends its functions to such calls; two such
libraries with the same function is S113.

9.9. A function that asks, writes boxes, collects, calls an impure native (`today`, `print`, `fail`), or calls a
function that does, has effects; else it is pure. An impure call is never worked out before the form opens, never
taken as known (§11.1), and runs exactly as often as the program says: a
function wrapping `today()` gives the run's date at each run, not the date it was compiled.

9.10. **Functions are not values.** A function is called, never passed, kept or returned: its name anywhere but
before `(` is S353. What other languages do by passing a function is written in Stride without one: keeping some
items, or changing each, is a comprehension (`[upper(x) for each x in names if x is not empty]`, §6.12); ordering
records is `sorted(l, by: "field")` (§14.4); anything else is a function that takes the list and loops over it.
So every call the program can make is written in it, and the compiler follows each one (§10, §11).

## 10. Boxes and the PDF check

10.1. A box's name is the PDF field's full name, after the program's `fields` prefix.

10.2. The program is checked against the form's header: the PDF's boxes and, for the boxes it lists them for, the
words printed beside each. The header is input: the check takes what it says and works nothing out about the form.
The header's PDF and form must be the program's (S501, S502).

10.3. Every box written exists (S508, with the nearest name), and is written by the statement of its kind: `fill`
a text or list box, `tick` a check box, `pick` a radio group (S509); a button the group has (S511); a list box's
entry it has (S514). A choice box accepts empty, or one of its entries. Words the PDF check can work
out for a path and that are not an entry are S514: a one-of answer is tried for every option still allowed on the
path, and for empty, and expressions made from it are worked out for each. Words it cannot work out beforehand
(made from words a person types, or from a date) are not a mistake: they go into the box as they are. Stride is
no stricter than the form. A value chosen by `if … then … else` is proved arm by arm: each arm's words are those its condition
allows, for an answer of any type, as a branch's condition restricts the code it guards (`fill "L" = if n > 5 then
"high" else "low"` puts "high" or "low", never both). A set placed straight in a choice box is S308; words made
from a set (`join(s, ", ")`) are proved like any others, each set its options allow. A question's `check`
does not restrict its possible words: a failed check does not stop the run. Empty clears the box and is always
allowed.

10.4. Following every path through the program with every answer unknown: a question is asked at most once on
each path (S507); a box written twice on one path is a warning (W008), and the later write is the one that
stays. **Stride is no stricter than the form**: a form lets a person leave a box empty or write over it, so
these are warnings, and the program compiles.
- 10.4.0. **Which paths.** The PDF check tracks current var values and uses pure-call results it can determine
  independently of answers and impure operations. A determined condition follows its selected branch; an
  undetermined condition follows both. These additional facts do not make values known under §11.1.
  Impure calls, including today, remain unknown. Paths may be combined only while preserving the information
  required by the remaining checks. This includes live values' types, carried list limits (§3.7), answer
  dependencies and predicate meanings. Each earlier write, ask, skip and pick retains the conditions under which it
  occurred. Values irrelevant to all remaining checks may be discarded. Ordinary `==` is not the test: it leaves a
  list's most out (§6.6). The conditions of two combined paths become the one path's or the other's. A determined
  value is never forgotten to save work: when the check would keep more paths apart than §15.1 allows, it stops with
  S602.
  An undetermined turn count does not itself erase determined values. Assignments update the state normally, and
  values proved invariant across possible iterations remain determined. Include zero turns when possible. If the
  required analysis exceeds its budget, compilation stops with S602. So `var x = "CA"` followed by `for i in 1..n
  { x = "CA" }` still leaves x as "CA" whenever execution reaches the following statement; a var a turn may give
  another value (`x = "NY"`), and the loop's counter, are undetermined from the turn where they may differ.
- 10.4.1. **What counts as a write on a path.** `fill` and `tick` always write their box; `pick` writes only when
  its condition is yes — a condition known to be no selects nothing, and one that depends on an answer is followed
  both ways, the path that takes it as yes knowing the answer that makes it so (`c`, `not c`, `o == "a"`). So
  picks whose conditions exclude each other, as `pick "K" "A" when o == "a"` and `pick "K" "B" when o == "b"`, are
  allowed.
  **What the check can prove.** Two conditions are proved to exclude each other only through these forms: an
  answer compared with a known value (`==`, `!=`, `<`, `<=`, `>`, `>=`); an answer's empty test (`== empty`, `is
  empty`); an answer's membership in a known list or set (`in`, `not in`); a known option's membership in an any-of
  answer (`"a" in s`, `"a" not in s`), the two opposites, each option's independent of every other's (`"a" in s`
  and `"b" in s` may both be yes); when s is empty, `"a" in s` is no and `"a" not in s` is yes; a yes-no answer itself; and
  `and`, `or` and `not` of these, with their facts kept through lets and through the branches (`if`, `match`) a
  path has taken. Every other condition is an unknown of its own, which may be yes or no whatever the others are.
  The same expression written twice is one unknown only when it is deterministic (no impure call: not `today`,
  not a call with effects) and nothing it reads has changed between the two; separate impure calls are never
  taken to give the same value. The search over the unknowns is complete: there is no size past which a possible
  double selection is accepted.
- 10.4.2. **Radio groups.** Selection is per group: two picks that write one radio group on one execution are W008,
  whatever their buttons. W008 for two picks means a double selection is possible, or that the check could not
  prove the picks exclude each other by §10.4.1; it does not claim a run that picks twice was found. A choice the
  check cannot read is written so it can: each pick in its own branch of one `if … else` or `match`. Coverage (§10.5) is per button: each button is covered by a reachable `pick` of it, or by
  a `skip` of its group. A reachable `pick` covers its button whatever its condition: `pick "K" "A" when no`
  selects nothing and covers A, and is not W009. A `pick` in code that never runs (§11.3.3) covers nothing.
- 10.4.3. **Write and skip.** A box (a radio group as one) written and skipped on one path is W008, at the later of
  the two; paths that exclude each other may write it on one and skip it on another. A box skipped again is
  harmless.

10.5. A box of the PDF that the program neither writes nor skips anywhere is a warning (W009, W010): the form
lets it stay empty, and the warning says which boxes the program has not got to. `skip` says a box is left
empty on purpose.

10.6. A question's printed words are the form's own. Which printed words stand beside a box is not in a PDF: the
header lists them (a box's `near`) when whoever prepared it gave them. Where it does, a question's printed words
are printed beside at least one of the boxes its answer goes into, within one normalised string of the words near
that box; when none matches, it is S517. An option's printed words are beside the box its own button ticks or picks
(S518). Boxes the header lists no words for are not checked: of them the program's word is taken. "Printed beside" is decided on normalised words, for both: each
text is lowercased; `‐ ‑ ‒ – — ― −` become `-`, `“ ” « »` become `"`, and `‘ ’` become `'`; every run of
characters other than Unicode letters, numbers and `( ) ' " $ % / & -` becomes one space; the ends are trimmed.
The normalised printed words must occur within one normalised string of the words near the box. So `A-B` does not
match `A B`.
An answer goes into a box when it is in the value of the box's `fill`, or in the condition of its `tick` or
`pick`, through lets too; and, for a `tick` or `pick` whose own condition is yes on its path, in the conditions of
the branches (`if`, `match`) taken to reach it: `if y { tick "T" when yes }` sends y into T as `tick "T" when y`
does. An option's button is found the same way: `match o { "a" => { tick "A" when yes } }`, `if o == "a" { … }`
and `let isa = o == "a"` with `tick "A" when isa` each make A option a's box. S517 asks for at least one of an
answer's boxes, as above.

10.7. Box names, button names, question keys and printed words are worked out as the program runs (§11.2).

## 11. Known before the form opens

11.1. Known: words, numbers, `yes`, `no`, `empty`; constants; lets made of known values; the counters of loops
that ask or write boxes; the numbers of a collect's or for each's items; the items of a `for each` over a known
list, when it asks or writes boxes (`for each b in ["Race", "Age"] { tick b when b in why }`); pure natives of known values; list
literals of known values; parameters every call gives a known value. An item of a known list at a known position is known
(`QUESTIONS[i]`, with QUESTIONS a constant list and i such a loop's counter). Not known: answers, vars, a
collect's items, fields, records made with `new`, calls of Stride functions. The one exception is a box's or a button's name: there a
call of a pure Stride function (§9.9) on known values is known too, so a function can build a row's box names
(`fill "Make{suffix(n)}" = v.make`). A known value is therefore a scalar, an option, a set, or
a list of known values (§8.6.3 encodes each).

11.2. **Worked out as the program runs.** A box's name and a button's, a question's printed words, a check's
message, a skip's reason, a collect's questions and a loop's bounds are ordinary expressions: they may be made of
answers, vars and calls, and are worked out when the statement runs (`fill "Row{n}" = v`, with n an answer). A
box's name written out that the form does not have is mistake S508; one worked out as the program runs that the
form does not have stops the run with F016. The compiler itself works out only a constant's value (S304), a
parameter's default (S393), an option's printed words and the words after `faults` (S412).

11.3. **A fault in what the compiler works out.** The compiler works out a constant's value (§5.3) and a
parameter's default (§9.2). One whose working out faults (`const X = 1 / 0`) is mistake S413 at the operation,
wherever it stands. Every other operation that faults does so when it runs (§13): `print(1 / 0)` compiles, and
is F001 when it runs. The compiler does not predict a run's faults.
- 11.3.3. **Unreachable code.** A branch whose condition is known before the form opens to be no (`if no`, `if
  MOST > 10` with `MOST = 4`, a `match` arm a known subject never takes), the body of a loop that runs zero times
  with known bounds, and statements after a `return`, `break` or `continue`, never run. They are checked for
  syntax, names, types and flow (S406 for the statements after a return), but not by the PDF check (§10): their
  boxes are not written and their questions not asked. This is what is known by §11.1; the PDF check also follows
  the further facts of §10.4.0 (vars, pure calls), which leave what §11.1 calls known as it is.
- 11.3.5. **Precedence.** S413 belongs to the flow phase, after the type phase (§16.1). A fault the type phase
  already reports keeps that code and is not reported again: a known list position outside 1 to the list's most is
  S360, not S413; a known number literal or constant out of range is S009.
- 11.3.6. **Loop facts.** To decide what code can run (S405, S407), the compiler follows a `for` with known bounds turn by turn, its counter known in each turn, and a
  `for each` over a list of known items (a literal) item by item, its item and its number known in each turn: in
  every loop, whether or not it asks or writes boxes. These additional loop facts do not enlarge what §11.1 calls
  known. A value already known under §11.1 remains usable wherever §11.2 requires a known value. A value known
  only from this loop reduction does not satisfy that requirement.

## 12. Names and scopes

12.1. Scopes, outermost first: the imports (standard library and used libraries), the file's declarations, a
function's type parameters and parameters, the program's or function's body, and each `for`, `for each`, `collect`
and comprehension body. `if` and `match` are not scopes: a name declared in a branch is in scope after the `if`
or `match`, from the statement that declares it on.

12.1.1. **What a branch-declared name holds after the branch.** A question's answer asked in a branch is empty when
the branch did not run, and may be read anywhere after it (an answer may always be empty). A `let` or `var`
declared in a branch follows definite assignment instead: a read of it is allowed only where every path from the
start has run a declaration of it (or, for a var, a declaration or an assignment); a read where some path skipped
its declaration is S407, which names the branch that skips it. Declarations of the same `let` or `var` in arms that
exclude each other (§12.4) are one name, of one type (S315), so

```
if c { let x = 7 } else { let x = 8 }
print(x)            # allowed: every path declares x
if c { let y = 7 }
print(y)            # S407: when c is no, y is never declared
```

The flow check reduces branches and loops whose conditions are known (§11.3.3, §11.3.6) before it decides.

12.2. A name is known from the statement that defines it on (S202 says where it is). A name defined inside a loop
is known only there (S203).

12.3. A name is not defined twice in one function or program body (S205), and does not hide its file's
declarations (S206); it may hide what a library brings in.
A parameter of a Stride function is a local name: one hiding its file's declaration is S206, while it may hide
an imported name.

12.4. The same question asked, or the same let or var declared, in branches that exclude each other (the arms of
one if or match) is one answer or one name, of one type (S315).

12.5. An unknown name is S201 with the nearest known name, the comparison ignoring case and `_`, at most a third of
the letters different.

## 13. Running

13.1. The machine runs a compiled program on the answers given so far, from the start, and gives the questions
the run reaches in order (key, printed words, value, default, whether its check failed, and whether the answer
given was unreadable and why, §8.7), the boxes written, the
words given to `print`, and a fault or none.

13.2. The page runs it again after every answer; a box the run does not write is emptied.

13.3. `today()` is the device's date, or the date the host fixes for a run.

13.4. **Faults.** A fault stops the run; nothing it wrote counts. A fault has a code, a message, and the place
(file, line, column) and function of the faulting operation and of every call that led there (§16.3).

| Code | Fault |
|---|---|
| F001 | division by zero |
| F002 | floor division or remainder by zero |
| F003 | a number of absolute value 10^34 or more |
| F004 | a list position or a loop bound not a whole number, or a position below 1 or above the list's most |
| F005 | a list item set outside 1 to (items + 1), or above its most |
| F006 | a field read or set on a value that is not a record and not empty: a compiler fault, never reached by a type-correct program |
| F007 | a native given a position that is not a whole number of 1 or more |
| F008 | a native given places that are not a whole number from 0 to 10 |
| F009 | `pad_left` given a width outside 0–1000, or padding that is not one character |
| F010 | a date pattern with none of YYYY YY MM DD M D |
| F011 | a date outside 0001-01-01 to 9999-12-31 |
| F012 | words longer than 100,000 characters |
| F013 | `fail(message)`: the program's own fault |
| F014 | more than 2,000,000 instructions in one run |
| F015 | calls deeper than 200 |
| F016 | a box name, worked out as the program runs, that the program does not know (a compiler fault) |
| F017 | a list given more than its most items; `split` giving more than 1000; mosts known only at run time adding to more than 1000, or placed where a smaller most is expected (§3.7.7) |
| F018 | an operator given values it does not take (a compiler fault) |
| F019 | the machine stopped on something else (a machine fault) |
| F020 | an assignment through an item that is not there: a position past a list's items read on the way to a field or a deeper position (`xs[3].name = v` when xs holds 2): a program fault |

## 14. The standard library

14.0. **Conventions for every function below.**
- 14.0.1. Each is written with its parameters' names and types and its result type. The names are the ones named
  arguments use (§9.4): `round(n, places: 2)`. A parameter shown `= v` has that default.
- 14.0.2. **Text parameters** (`text`) take any words: `long-text`, `phone`, `email`, an option (§3.6). A result
  `text` is `text`.
- 14.0.3. **Empty.** Unless the entry says otherwise: an empty text argument is treated as no characters; a function
  whose result is a number or a date, given an empty number or date, gives empty; one whose result is text gives
  the text it would for no characters (`upper(empty)` is empty).
- 14.0.3.1. **Checking comes before empty.** A function first checks its control arguments — positions, places,
  widths, paddings, patterns, separators where stated — and faults when one is wrong, whether or not its main
  argument is empty; only then does an empty main argument give empty. So `format(empty, "invalid")` is F010 and
  `grouped(empty, 2.5)` is F008. An empty control argument is wrong (F007, F008, F009, F010) unless the entry gives it a
  meaning.
- 14.0.4. **Positions** are whole numbers of 1 or more (F007 otherwise, empty included); characters are Unicode
  code points. A position past the end gives empty, or fewer characters.
- 14.0.5. Answer conversion never faults (§8.7). Operations and functions using the converted value can fault
  under their own rules, including the control-argument checks of §14.0.3.1: `divide(1, n)` faults when an answer
  supplies zero. A program's own mistake that the compiler cannot see faults too (§13.4).
  Every native here is pure but `today`, `fail` and `print` (§9.9).
- 14.0.6. **List results** state their most: `same` is the most of the list given (§3.7).
- 14.0.7. **Examples.** Every entry of these tables has at least one example in `lib/std.stride`, a line
  `# example: e gives w` (what `stride eval` shows for e), `# example: s prints w`, or `# example: e faults F…`,
  above the function's declaration; the examples may use the declarations `std.stride` writes out with them, and
  today() is 2026-11-09 for them. `stride doc` shows them, and the conformance suite runs every one in the machine
  and the intermediate form (§19.1): an example that does not do what it says is a bug.

### 14.1 Words

| Signature | Gives |
|---|---|
| `upper(t: text) -> text` | t in capitals (Unicode case mapping) |
| `lower(t: text) -> text` | t in small letters |
| `title(t: text) -> text` | each word's first letter a capital, the rest small; words are split on spaces, `-` and `'` |
| `capitalize(t: text) -> text` | the first character a capital, the rest as written |
| `trim(t: text) -> text` | spaces and tabs off both ends, inner runs of them made one space |
| `trim_start(t: text) -> text`, `trim_end(t: text) -> text` | spaces and tabs off the start, off the end |
| `remove_prefix(t: text, prefix: text) -> text` | t without prefix at its start, when it starts so (case as written); else t |
| `remove_suffix(t: text, suffix: text) -> text` | the same at the end |
| `length(t: text) -> number` | how many characters; empty: 0 |
| `chars(t: text, from: number, to: number) -> text` | characters from..to (positions) of t with spaces, `-`, `–`, `—`, `/`, `.` left out; the positions are checked first (§14.0.4: 0 is F007), then to < from: empty |
| `character(t: text, n: number) -> text` | the n-th character of t, the same separators left out |
| `slice(t: text, from: number, to: number) -> text` | characters from..to of t as written; the positions are checked first (§14.0.4: 0 is F007), then to < from: empty; list slices keep their own rule (§6.9.3) |
| `digits(t: text) -> text` | only the digits 0–9 |
| `letters(t: text) -> text` | only the letters (Unicode) |
| `is_digits(t: text) -> yes-no` | yes when t is not empty and every character is 0–9 |
| `is_letters(t: text) -> yes-no` | yes when t is not empty and every character is a letter |
| `replace(t: text, part: text, with: text) -> text` | every part replaced by with, left to right, not overlapping; part empty: t |
| `contains(t: text, part: text) -> yes-no` | whether part is in t, case ignored (Unicode simple case folding); part empty: yes |
| `starts_with(t: text, part: text) -> yes-no`, `ends_with(t: text, part: text) -> yes-no` | the same at the start, at the end |
| `find(t: text, part: text) -> number` | the position of the first part in t, case ignored; 0 when it is not there or part is empty |
| `occurrences(t: text, part: text) -> number` | how many times part is in t, not overlapping, case ignored; 0 when part is empty |
| `split(t: text, separator: text) -> list of text most 1000` | t cut at every separator (case as written), pieces kept even when empty; t empty: an empty list; separator empty: each character; more than 1000 pieces F017 |
| `line(t: long-text, n: number) -> text` | line n of t (lines end at `\n`, `\r\n`, `\r`), with spaces and tabs off both ends and its inner spacing kept as written (not `trim`); every other character, a non-breaking space among them, stays |
| `line_count(t: long-text) -> number` | how many lines, every line end (`\n`, `\r\n`, `\r`, each one) starting a new one, so a trailing end counts its empty last line: `line_count("a\n")` is 2; empty: 0 |
| `rest_lines(t: long-text) -> long-text` | every line after the first, joined by `\n`, with spaces and tabs off both ends of the whole and its inner spacing kept as written (not `trim`); every other character stays |
| `word(t: text, n: number) -> text` | word n of t, words split on runs of spaces and tabs |
| `word_count(t: text) -> number` | how many words; empty: 0 |
| `pad_left(t: text, width: number, padding: text = " ") -> text` | padding put before t until it is width characters; t at least width long: t. width a whole number 0–1000 and padding exactly one character, else F009 |
| `text_of(v: any) -> text` | v's words (§3.5); a list or record is S367 |
| `number_of(t: text) -> number` | the number t holds by §8.7, or empty |

### 14.2 Numbers

| Signature | Gives |
|---|---|
| `round(n: number, places: number = 0) -> number` | n rounded to places decimals, half away from zero; places a whole number 0–10, else F008 |
| `ceil(n: number) -> number` | the least whole number ≥ n |
| `floor(n: number) -> number` | the greatest whole number ≤ n |
| `whole(n: number) -> number` | n with its fraction cut off, towards zero |
| `abs(n: number) -> number` | n without its sign |
| `min(a: number, b: number) -> number`, `max(a: number, b: number) -> number` | the smaller, the larger; one empty: the other; both: empty |
| `grouped(n: number, places: number = 0) -> text` | n with places decimals (rounded half away from zero) and `,` between thousands: `1,234.50`; F008; empty: empty |
| `fixed(n: number, places: number = 0) -> text` | the same without separators: `1234.50` |
| `divide(a: number, b: number) -> number` | `a / b` (§6.4, F001) |
| `remainder(a: number, b: number) -> number` | `a % b` (§6.4, F002) |

### 14.3 Dates

| Signature | Gives |
|---|---|
| `today() -> date` | §13.3 |
| `date_of(year: number, month: number, day: number) -> date` | that day; no such day, or a part not whole: empty |
| `year(d: date) -> number`, `month(d: date) -> number`, `day(d: date) -> number` | its parts |
| `format(d: date, pattern: text) -> text` | pattern with `YYYY`, `YY`, `MM`, `DD`, `M`, `D` put in (longest first); a pattern with none of them F010; d empty: empty |
| `days_between(from: date, to: date) -> number` | days from from to to (negative when to is earlier) |
| `years_between(from: date, to: date) -> number` | whole years from from to to: an age on a day. When to ≥ from, the number of anniversaries of from that fall on or before to, where an anniversary on a day the year lacks (29 February in a common year) falls on the last day of that month (28 February). When to < from, minus `years_between(to, from)`: the count goes towards zero, and swapping the arguments changes only the sign. 2000-02-29 → 2001-02-28 is 1; 2000-02-29 → 2004-02-29 is 4; 2023-07-01 → 2024-06-30 is 0; 2024-06-30 → 2023-07-01 is 0 (not −1); 2024-07-01 → 2023-07-01 is −1 |
| `add_days(d: date, n: number) -> date` | the day n days after d, n cut towards zero; outside 0001–9999 F011 |

### 14.4 Lists and sets

`L` is `list of T most N` and `S` a `set of` an option set; a parameter `l: list of T` takes either kind where the
entry says "or a set" (its items are then options).

| Signature | Gives |
|---|---|
| `count(l: list of T or set) -> number` | how many items, or options chosen |
| `join(l: list of T or set, separator: text = ", ") -> text` | T a type with words (§3.5): words, a number, a date, yes-no, an option; a list of records or of lists is S367. The items' words, empty items left out, joined |
| `first(l: list of T or set) -> T`, `last(l: list of T or set) -> T` | the first, the last item; empty when there is none |
| `filled(l: list of T) -> list of T most same` | the items that are not empty, in order |
| `index_of(l: list of T, x: T) -> number` | the position of the first item equal to x (§6.6); 0 when none |
| `append(l: list of T, x: T) -> list of T most same` | the list with x after its last item; the list already holding its most: F017 |
| `without(l: list of T, x: T) -> list of T most same` | the list without the items equal to x |
| `reversed(l: list of T) -> list of T most same` | the items in the other order |
| `sorted(l: list of T, descending: yes-no = no) -> list of T most same` | T a number, a date or words (else S367): the items in order (§6.7), equal items keeping their order; **empty items come last**, in their order, ascending or descending |
| `sorted(l: list of R, by: "field", descending: yes-no = no) -> list of R most same` | R a record; `by` is given by its name only (a second value given without a name is `descending`, which is yes-no); `by` is plain words known before the form opens naming a field of R (S399 when it is not one, with the nearest; S399 when the field's type is not a number, a date or words); the items in the order of that field, equal ones keeping their order, items whose field is empty (and empty items) last |
| `sum(l: list of number) -> number` | the items added up, an empty item counting as 0; no items: 0 |
| `smallest(l: list of T) -> T`, `largest(l: list of T) -> T` | T a number, a date or words: the least, the greatest of the items that are not empty; none: empty |
| `any(l: list of yes-no) -> yes-no` | yes when some item is yes (an empty item counts as no); an empty list: no |
| `all(l: list of yes-no) -> yes-no` | yes when every item is yes; an empty list: yes |
| `union(a: S, b: S) -> S`, `intersection(a: S, b: S) -> S`, `difference(a: S, b: S) -> S` | a and b sets of one option set (S387); the options of a or b, of both, of a and not b; in declaration order (§3.8) |
| `l + m` (an operator, not a function) | §6.5.1: l's items then m's, `list of` the join of the element types (§3.9, by the larger mosts within) `most` the sum of the two operands' mosts, whether or not either holds items |

### 14.5 Empty, faults and output

| Signature | Gives |
|---|---|
| `either(a: T, b: T) -> T` | a when it is not empty, else b |
| `fail(message: text)` | no value: fault F013 with the message |
| `print(v: any)` | no value: gives v's words to the host (§13.1); a list's or a record's words are written as `[a, b]` and `R { field: v, … }` for this function only |

## 15. Limits

| Limit | |
|---|---|
| nesting of blocks, brackets and expressions | 200 (S019) |
| arguments of a call, parameters of a function | 255 (S601) |
| a list's most | 1000 (S213) |
| options in an option set | 1 to 1000 (S235) |
| words | 100,000 characters (F012) |
| significant digits of a number | 34 (S009; §3.3) |
| instructions in one run | 2,000,000 (F014) |
| depth of calls | 200 (F015) |
| mistakes reported | 20; the rest are counted |

15.1. **Analysis budgets.** The checks the compiler must make (§10, §11) work within these budgets. A check that
would pass one stops compilation with S602, naming the check and the budget; no bytecode is produced, and nothing
is taken as proved.

| Budget | Counts | |
|---|---|---|
| working out a value before the form opens | the expressions of one working out of a constant, a default or another value that must be known (§11.2) | 100,000 (S602) |
| loop turns in the flow phase | turns actually followed one by one (§11.3.6) over the whole flow phase, every repeated visit of the analysis counted, not the size of the written range; a safe summary or an early exit is allowed | 100,000 (S602) |
| paths in the PDF check | paths the PDF check keeps apart at one analysis point in one context (§10.4.0): one call of a function, one turn of each loop it follows by known turns; separate calls and known loop turns are not alternative paths at one point | 100,000 (S602) |
| loop turns in the PDF check | paths the PDF check follows into the head of a loop (§10.4.0), over the whole check, every visit counted, known turns and turns of a loop whose turns are not known alike | 100,000 (S602) |
| a pure call in the PDF check | steps of the intermediate form's interpreter working out one pure call whose arguments are determined (§10.4.0) | 100,000 (S602) |
| one proof that conditions exclude each other | search and formula nodes of one radio-overlap proof (§10.4.1, §10.4.2): each choice of an unknown, each part of a condition looked at; exhaustion is S602, never "no clash" | 100,000 (S602) |
| answer values for one choice box | combinations of answer values tried to prove the words of one choice box write (§10.3); an any-of answer counts every set of its options | 4,096 (S602) |

## 16. Mistakes, warnings and how they are shown

16.1. **A mistake** stops the compiler after its phase: syntax, libraries, names, types, flow, the PDF check. A
phase runs only when those before it found none, so one mistake is not reported again as others. Within a phase,
a mistake that follows from another is not reported beside it: S106 takes precedence over S232 at the same
statement. Independent mistakes in other parts of an expression, and in other calls,
are still reported. A phase finds
and records every mistake it can (the parser stops after 20 syntax mistakes, §15); the command line shows the first
20 in order of place and says how many more there are; `--json` lists them all.

16.2. **Shown** as:

```
irs-2848.stride:42:17: mistake S318: the record representative has no field nmae; did you mean name?
  42 |   fill "Name" = r.nmae
     |                 ^^^^^^ no field nmae
  12 | record representative {
     |        -------------- representative is declared here
  stride explain S318
```

16.2.1. **The place of a mistake** is where its line and column point, and what the first label underlines:
- a lexical mistake (S001–S009, S016, S017, S021): the first character of what is wrong — the character not read,
  the opening `"` of words not closed, the `\` of a bad escape, the `{` not closed or empty, the lone `}`, the
  first digit of a bad number, the first character of a bad id or sha256;
- S015: the operator the line ends on; S014: the second comparison's operator; S011: the `=`; S019: the first
  token met beyond the 200th level, with what surrounds it — an inner value after brackets, or the operator that
  crosses the limit; it need not be an opening bracket;
- S401 and S402: the call that closes the circle (in S402, the call in the first function of the circle in the
  order the file declares them); S518: the option's own line in its set or block; W009 and
  W010: the program's first line (the header), with the box named in the message; S501: the `pdf` line; S502:
  the `form` line; S503 and S508: the box name's expression; S511: the button name's expression; S514: the
  entry's value; S517: the question's printed words; S323: the second `default`, the first as related code;
  S372, S374, S375 and S379: the smallest operation that offends, never the statement around it; S413: the operation that faults; S602: the loop whose turns passed the budget, the call whose working out did, the statement where the
  PDF check kept one path too many, the statement whose proof that conditions exclude each other did, or the write
  whose answer values did; S407: the read,
  with a label on a path that leaves the name without a value — the branch that skips it, a loop that may run no
  turns, or the declaration when nothing gives it a value (no branch is named where there is none);
- any other mistake: the first character of the smallest construct the "When" column names — the name, the
  operator, the argument, the field, the statement's first word — and it underlines that construct to its end.

The first label is the place, the others related code (where a name is defined, where a box was written first,
the calls that led there).

`--json` makes a command's stdout one JSON document, on one line. A command given properly gives it whenever it
exits 0 or 1:
- when it did its work, or found mistakes or a fault, the command's document below, whose `ok` is false exactly
  when it exits 1;
- when it could not do its work (a file that cannot be read or written, answers that are not JSON, a program with
  no tests, a project stride.json refuses, a bug in stride), `{"ok": false, "error": "<what went wrong>"}`, those
  two fields only.

A usage mistake (exit 2, §17.5) gives no document: its three lines are on stderr. Mistakes and warnings are in the
document, never on stderr. What the person asked for on stderr stays there: the trace (`--trace`) and the
questions (`--prompt`); `--json` never prompts unless `--prompt` is given. `--quiet` and `--color` change nothing
in the document.

A mistake or warning is `{code, severity, file, line, column, endLine, endColumn, message, labels: [{file, line,
column, endLine, endColumn, message}]}`. The documents, every field always present:
- `run` (in the terminal, §17.18): `{ok, diagnostics, questions, prints, boxes, fault}`. A question is `{key, type, printed, answered,
  value, default, unreadable, failed}`; `prints` the lines printed; `boxes` box name to what it holds; `fault`
  null or `{code, message, file, line, column, stack: [{function, file, line, column}]}`, a place null when there
  is none. With mistakes, `questions` and `prints` are `[]`, `boxes` `{}`, `fault` null.
- `check`: `{ok, files: [{file, ok, error, diagnostics}]}`; `error` null or what kept the file from being checked.
- `compile`: `{ok, diagnostics, output, bytes, questions, boxes}`; with mistakes, `output` null.
- `test`: `{ok, files: [{file, ok, error, diagnostics, tests: [{name, ok, problems}]}]}`.
- `eval`: `{ok, value, diagnostics, fault}`: `value` the words `stride eval` prints, or null.
- `map`: `{ok, diagnostics, questions: [{key, printed, boxes: [{box, direct}]}], writtenFromNoAnswer,
  onlySkipped}`.

Values: a number as its words (§3.3.5), a JSON string, so no digit is lost (`"1.5"`); words and a date
(`"2024-01-02"`) as JSON strings; yes and no as `true` and `false`; an option as its value; an any-of answer as
the list of its values; empty as `null`. A field may be added in a minor version; none is removed or changed but
in a major one (§21.1).

With compilation mistakes, `compile` still includes every result field: `output` is null and `bytes`,
`questions` and `boxes` are 0. With mistakes, `map` includes empty `questions`, `writtenFromNoAnswer` and
`onlySkipped` arrays.

Lines and columns count from 1
(§1.3); an end is exclusive: endLine and endColumn are the position just after the last character, so `r.nmae` at
42:17 ends at 42:23. `stride explain CODE` prints the
code's explanation below.

16.3. **A fault** is shown with its code, message, place, and the place of every call that led there, innermost
first:

```
fault F001: division by zero
  at half, irs-2848.stride:3:12
  called from main, irs-2848.stride:7:12
```

16.3.1. **The place of a fault** is the first character of the operation that faults: a binary operator's sign
(`/` for F001), the `[` of a position (F004, F005, F020), the field's `.` (F006), the function's name for a call
of a native or of `fail` (F007–F013, F017 for `split`), the expression placed for F017 at a place (§3.7.7), and
the call's name for F015 (the program's own body is the first of the 200 frames; the call that would make the
201st faults); a loop bound that is not whole faults at the bound's first character (F004); F014 at the
instruction where the count is passed. Each frame of the stack is the place of
its call: the function's name in the call.

16.4. **The codes.** Each code's explanation, as `stride explain` prints it.

| Code | When | Explanation |
|---|---|---|
| S001 | a character Stride does not read (or a file not UTF-8) | Outside words in quotes, Stride reads names (a–z, digits, _), numbers, and the signs of §2.7. Put other characters in "…". |
| S002 | words in quotes not closed on their line | Words in quotes end on their line. Close them with `"`; for a line break inside, write `\n`. |
| S003 | an escape Stride does not have | Inside "…", `\` is followed by `"`, `\`, `{`, `}`, `n`, `t` or `u{hex}`. |
| S004 | a lone `}` in words | `{` and `}` in words put a value in; a brace itself is written `\{` or `\}`. |
| S005 | a `{` in words not closed | A value put in words is written `{value}`; close it, or write `\{`. |
| S006 | `{}` with nothing in it | Put a value between the braces, or write `\{\}`. |
| S007 | a number running into letters | A name cannot start with a digit; a number ends before a letter. |
| S008 | a number with a leading zero | `0755` is not a number in Stride; an id with leading zeros is words: `"0755"`. |
| S009 | a number of more than 34 significant digits, or a number literal or constant of 10^34 or more or finer than 10^-6176 | Numbers are exact to 34 digits and below 10^34; longer digits are an id: write them in quotes. |
| S010 | anything the grammar does not allow there | The message says what was found and what could stand there. |
| S011 | `=` where a comparison is meant | `=` gives a var a value; to compare, write `==`. |
| S013 | a keyword where a name is meant | Keywords (§2.3) are the language's words; choose another name. |
| S014 | comparisons chained | `a < b < c` is written `a < b and b < c`. |
| S015 | a line ending on an operator with no operand following it | An operator needs a value after it, on the same line or the next. |
| S016 | a form id that is not one | A form id is letters, digits, `.`, `-` and `_`. |
| S017 | a PDF sha256 that is not one | The sha256 is 64 hexadecimal digits in small letters, from `stride header`. |
| S018 | `{…}` in words that must be plain | Option values, `use` paths, `fields` and match values are plain words. |
| S019 | nesting deeper than 200 | Blocks, brackets and expressions go 200 deep at most; split it into functions or lets. |
| S021 | a `\u{…}` out of range | A character is `\u{0}` to `\u{10FFFF}`, not D800–DFFF. |
| S022 | an option of a question's own without `option` | A question's own options are written `option "value" "printed words"`. |
| S023 | `==` where a statement is meant | `x == 1` on its own does nothing; to give a value, `x = 1`. |
| S101 | `use "std"` | The standard library is in every file already. |
| S102 | a library path that is not one | Small letters, digits, `-`, `_`, with `/` between folders. |
| S103 | libraries using each other in a circle | A library cannot use, through others, a library that uses it. |
| S104 | a library that is not there | `use "x"` reads `lib/x.stride`. |
| S105 | a `use` in the standard library | The standard library stands on its own. |
| S106 | a statement in a library, or one other than `let` and `expect` in a test file | A library holds only declarations; statements are a program's. |
| S107 | `export` in a program or a test file | Nothing uses a program or a test file; export is for libraries. |
| S108 | a native outside the standard library | Natives are the machine's; write the function in Stride with define. |
| S109 | two libraries exporting one name | Bring one in with `as`: `use "b" as b`, then `b.name`. |
| S110 | a library name brought in twice | Each `as` name names one library. |
| S111 | a library's name used as a value | Name what it exports: `p.full_name(…)`. |
| S112 | a library that exports nothing by that name | The message gives its nearest export. |
| S113 | a function of two libraries kept under names | Say which: `a.f(x)`. |
| S201 | a name not defined | The message gives the nearest name visible here. |
| S202 | a name used before the line that defines it | Statements run in order; move the use after the definition. |
| S203 | a name defined in a loop used after it | A loop's names are known only inside it; collect into a var declared before. |
| S204 | a program's name used in a function | A function sees only its parameters and its file's declarations; pass the value. |
| S205 | a name defined twice | One name, one thing, in a function or program; rename one. |
| S206 | a local name hiding its file's declaration | Rename the local. |
| S207 | two declarations of one name | Rename one; the note shows the other. |
| S208 | a declaration named like a type | `text`, `number`, … are types. |
| S209 | a type that is not one | Types are §5.6; the message gives the nearest. |
| S210 | `set of` something that is not an option set | `set of` takes an option set's name. |
| S211 | a list type without `most`, or a worked-out result whose list's most is not known | Every list says how many it holds at most: `list of text most 4`; only a parameter may leave it out, and a function returning such a list writes its result type (§9.5.2). |
| S212 | a `most` that is not a whole number of 1 or more, known | `most 4`, or a constant. |
| S213 | a `most` above 1000, or a list literal of more than 1000 items | A list holds at most 1000. |
| S214 | `any` or `element` outside the natives | Write the type. |
| S215 | an option value twice | Values in a set are unique. |
| S216 | an empty option value | An option's value is words. |
| S217 | a record holding itself | A record that holds itself could never be made; a list of it would also not end. |
| S218 | a record field twice | Field names are unique. |
| S219 | two parameters of one name | Rename one. |
| S220 | a type parameter's name that cannot be one | Use a name that is not a type or another parameter. |
| S221 | a type parameter in no parameter | No call could tell what it is. |
| S222 | a question's option set that is not one | `one-of S` takes an option set. |
| S223 | a question with a set and its own options | One or the other. |
| S224 | a one-of or any-of without options | Give a set, or `{ option "v" "printed" … }`. |
| S225 | options on a question that is not a choice | Only one-of and any-of have options. |
| S226 | a record or option set used as a value | A record is made with `new R { … }`; an option set is a type. |
| S227 | a call of a function not defined | The message gives the nearest function. |
| S228 | a call of something that is not a function | Only functions are called. |
| S229 | a call of an expression | Functions are called by their names. |
| S230 | a method call with no such function | `r.f()` calls `f(r)`; a record's fields are read without `()`. |
| S231 | one name for an item and its number | `for each n, x in l` needs two names. |
| S232 | a value on its own as a statement | A statement asks, writes, gives a value or calls. |
| S233 | `break` or `continue` outside a loop | They belong in `for` or `for each`. |
| S234 | `break` or `continue` in a collect | A collect ends when the person says there is no other. |
| S235 | an option set of no options or of more than 1000 | An option set declares 1 to 1000 options, as a list holds at most 1000 items. |
| S236 | `expect` in a program, in a library, or inside a function | Expectations stand at the top level of a test file, `<name>.test.stride` (§4.3). |
| S301 | a native the machine does not have | The standard library declares only what the machine provides. |
| S302 | a native declared with other parameters | As many as the machine's. |
| S303 | a constant made of itself | A constant's value cannot need itself. |
| S304 | a constant not known before the form opens | Constants are made of words, numbers and other constants. |
| S305 | a constant's value not of its type | Fix the type or the value. |
| S306 | a constant that is a record | Constants are words, numbers, dates, yes or no, sets, and lists of them. |
| S307 | `fill` with yes-no | A yes-no goes into a check box: `tick "box" when c`. |
| S308 | `fill` with several options | `fill "box" = join(s, ", ")`, or a tick for each option. |
| S309 | `fill` with a list or record | Fill a box with one value: `l[1].name`, `join(…)`. |
| S310 | a condition of words or an option | Compare it (`== "…"`) or test it (`is not empty`). |
| S311 | a condition that is not yes-no | Conditions are yes or no. |
| S313 | a `for` bound that is not a number | `for i in 1..n` counts numbers. |
| S314 | `for each` over something not a list or set | `for each` goes through a list or a set of options. |
| S315 | one answer, let or var with two types | The same question asked, or the same let or var declared, in branches that exclude each other is one name of one type (§12.4). |
| S316 | a collected item asked with another type | The list's items are of its type. |
| S317 | a field path through something with no fields | Only records have fields. |
| S318 | no such field | The message gives the nearest field. |
| S319 | an answer into something that cannot hold it | An answer goes into a new name, a var's field or a collect's item. |
| S320 | an answer of another type than its place | The place's type and the question's must fit. |
| S321 | a var's field asked twice | One question per field. |
| S322 | a default of another type | The default is a value of the answer's type. |
| S323 | two defaults | A question has one default. |
| S324 | `let`/`var` of a call with no result | The function gives nothing to keep. |
| S325 | a value not of the declared type | Fix one. |
| S326 | `var x` without a type or a value | `var x: text`, or `var x = …`. |
| S327 | `= empty` without a type | `var x: text = empty`. |
| S328 | a `let` or `var` without a type whose list value no item tells the type of (`[]`, `[empty, empty]`, `[[empty]]`) | `var l: list of text most 4`. |
| S329 | `match` on something that is not an option or words | Use if. |
| S330 | `else` not last in a match | `else` comes last. |
| S331 | a match value twice | Each value once. |
| S332 | a match value the option can never be | The message lists the set's values. |
| S333 | collect into something not a var | Declare `var l: list of T most N`. |
| S334 | collect into something not a list | A collect fills a list. |
| S335 | a collected list of lists or sets | Collect records or plain values. |
| S336 | collect into a list that has items | A collected list starts empty. |
| S337 | a list collected twice | A list is collected once. |
| S338 | the program returning a value | The program gives no value; `return` ends it. |
| S339 | a bare return where the others give a value | Every return gives a value. |
| S340 | a bare return in a function with a result | Return a value of its type. |
| S342 | a returned value of another type | Of the function's result type. |
| S343 | returns whose types have no join | A function's worked-out result is the join of its returns (§3.9); or write `-> type`. |
| S344 | a function returning only empty | Write its result type. |
| S345 | a value given to an answer, let, constant, parameter, counter or item | The message says what it is and what to do. |
| S346 | a collected list changed | Its items are answers. |
| S347 | a field or item of a non-var changed | Only a var's fields and items change. |
| S348 | an asked field given a value | An answer cannot be changed. |
| S349 | a value given to something that is not a place | Only a var, its field or its item. |
| S350 | a value given from a call with no result | The function gives nothing. |
| S351 | a value of another type given | The place's type. |
| S352 | `{…}` of a list, record or no value | Put in words, a number, a date or an option. |
| S353 | a function used as a value | Call it: `f(…)`. |
| S354 | `-` before something not a number | Only numbers are negated. |
| S355 | `not` of something not yes-no | `not` is for conditions. |
| S356 | `is empty` of a call with no result | It gives no value to test. |
| S357 | a field of something with no fields | Records have fields; for a list, `count(l)` or `l[n]`. |
| S358 | a list position that is not a number | Items are chosen by number, from 1. |
| S359 | a position into something not a list | Only lists have items. |
| S360 | a known position outside 1 to the list's most | The list holds items 1 to its most. |
| S361 | a list literal whose items' types have no join | A list's items join into one type (§3.9): words of different kinds join as text; numbers and words do not join. |
| S362 | a field given twice in `new` | Once. |
| S363 | `new` with a field the record lacks | The message gives the nearest. |
| S364 | `new` with a field of another type | The field's type. |
| S365 | a call with the wrong number of values | The message lists the parameters. |
| S366 | an argument with no value | The function called gives nothing. |
| S367 | an argument of another type | The parameter's type. |
| S368 | a generic call whose arguments do not tell its type | Give a value of the type (an empty list says nothing). |
| S369 | `first`/`last`/… of something not a list | They take a list or a set. |
| S370 | a call with no result used as a value | Call it on its own line. |
| S371 | an operand with no value | The function gives nothing. |
| S372 | `+` of a number and words | Put the number in words: `"…{n}…"`. |
| S373 | `+` of other types, or of lists whose element types have no join | `+` adds numbers, joins words, or joins lists whose elements join (§3.9). |
| S374 | `- * / // %` of something not a number | They are for numbers. |
| S375 | a date minus a date | `days_between(a, b)`. |
| S376 | yes-no compared with words | `x == yes`, or `x` alone. |
| S377 | a set compared with `==` against words | Ask whether one is chosen: `"v" in s`. |
| S378 | values that cannot be compared | Of one type, or words with words, or an option with words or with an option of another set. |
| S379 | an order of values that have none | Numbers, dates, words. |
| S380 | `and`/`or` of something not yes-no | They join conditions. |
| S381 | an option of one set in a set of another | Of the same set. |
| S382 | `in` a set with something not an option | `"value" in s`. |
| S383 | `in` a list with another type | Of the list's element type. |
| S384 | `in` words | `contains(t, part)`. |
| S385 | `in` something else | A set of options or a list. |
| S386 | words that are not one of the set's values | The message lists the values. |
| S387 | set operations on two option sets | Both sets of one option set. |
| S388 | a named argument the function does not have | The message gives the nearest parameter. |
| S389 | a parameter given twice | Once, positionally or by name. |
| S390 | a positional argument after a named one | Positional first. |
| S392 | a required parameter after one with a default | Defaults come last. |
| S393 | a default not known before the form opens | Defaults are made of known values. |
| S394 | a conditional whose two values' types have no join | `if c then a else b` takes the join of a's and b's types (§3.9); a number and words have none. |
| S395 | `l + m` holding more than 1000 | A list holds at most 1000. |
| S396 | a slice bound that is not a number | `l[a..b]`, numbers. |
| S398 | a comprehension that asks, writes boxes or collects | A comprehension makes a value; use for each. |
| S399 | `sorted(l, by: "f")` with f not a field of l's records, not known before the form opens, or not a number, date or words | `by` names a field of the list's record type, in plain words, whose values can be ordered. |
| S401 | a function calling itself | Every program ends; a function may not call itself. |
| S402 | functions calling each other in a circle | The same, through others. |
| S405 | a function giving a value on some paths only | End every path with a return. |
| S406 | a statement after return, break or continue | It never runs; remove it. |
| S407 | a let or var read where not every path declared it or gave it a value | Declare it, or give it a value, on every path before the read (§12.1.1). |
| S412 | an option's printed words, or the words after `faults`, not known before the form opens | They are written out, or made of constants. |
| S413 | a constant's value or a default that faults | The compiler works these out; the message gives the fault. |
| S501 | the header for another PDF | Run `stride header <form>.pdf` again, or fix the `pdf` line. |
| S502 | the header for another form | The same. |
| S503 | a skip of a box the PDF lacks | The message gives the nearest. |
| S507 | a question asked twice on one path | The notes show where. |
| S508 | a box the PDF lacks | The message gives the nearest. |
| S509 | a box written by the wrong statement | fill a text or list box, tick a check box, pick a radio group. |
| S511 | a radio button the group lacks | The message lists its buttons. |
| S514 | a list box entry it lacks | The list box's entries. |
| S517 | printed words not beside the boxes of their answer | The question's words are the form's own: they must be among the words the header lists beside a box the answer goes into. If the form does print them there, add them to that box's `near` in the header; if not, the answer is going into the wrong box. |
| S518 | an option's printed words not beside its box | The same, for an option and the box it ticks or picks. |
| S601 | more than 255 arguments or parameters | Use a record. |
| S602 | compiler analysis limit exceeded (§15.1) | The message names the check and the budget. Split the work: fewer turns, fewer vars that differ between paths, a smaller working out. |
| W001 | a match on an option missing options, without else | Warning: nothing happens for those. |
| W002 | a function never called | Warning. |
| W003 | a constant never used | Warning. |
| W004 | an answer never used | Warning: Write it, use it, or do not ask it. |
| W005 | a field asked and never read | Warning: Use it, or do not ask it. |
| W006 | a collected item asked and never read | Warning: The same. |
| W007 | a let or var never used | Warning: Remove it. |
| W008 | a box written twice on one path; two picks of one radio group not proved to exclude each other (§10.4.1) | Warning: The notes show where first, and the calls. Picks the check cannot prove exclusive go in the branches of one `if … else` or `match`. |
| W009 | a box neither written nor skipped | Warning: Write it, or `skip "box" because "…"`. |
| W010 | more such boxes | Warning: Counted after the first 40. |
| F001–F020 | §13.4 | |

## 17. The command line

| Command | Does |
|---|---|
| `stride compile <file> [-o out.sbc] [--json]` | writes the program's bytecode, everything a run needs but its PDF (§17.18); `-o` is `--output` |
| `stride check [path …] [--json]` | every check, nothing written; folders §17.13. `run` and `compile` make the same checks first, so it is never needed before them |
| `stride run <file\|.sbc> [--pdf <file.pdf>] [--port N]` | a program: its workflow in the browser, beside its PDF (§17.18) |
| `stride run <file\|.sbc\|-> --terminal [answers.json\|-] [key=value …]` | a program in the terminal, and a script always (§17.18); answers §17.12; `--trace` §17.7; `--json` §16.2 |
| `stride debug <file> [answers] [key=value …]` | §17.15 |
| `stride test [path …] [--match words] [--json]`, or `stride test <file.stride> [name …]` | as before; folders §17.13 |
| `stride eval "<expression>" [--use lib] [--today D]` | the value of one expression, with the standard library (and libraries) |
| `stride repl` | §17.14 |
| `stride explain <code>` | §16.4 |
| `stride guide [topic]` | the guide and `coming-from`, built in; a topic: the parts whose heading holds it; `topics`: the headings |
| `stride doc [word]` | the standard library's entries (§14) whose name, section or description holds the word, each with its signatures, what it gives and its examples (§14.0.7); no word: all of them |
| `stride new <name> [--pdf <file.pdf>]` | §17.6 |
| `stride init [folder]` | §4.7 |
| `stride header <file.pdf> [-o file.boxes.json]` | §17.6 |
| `stride map <file>` | for each question, the boxes its answer goes into, marked `=` where it goes as given (§10.6); the boxes written from no answer; the boxes only skipped |
| `stride lsp` | §17.6 |
| `stride dap` | §17.15 |
| `stride vscode [-o file.vsix]` | §17.16 |
| `stride asm <file> [--ir]` | the instructions with their places, or the intermediate form |
| `stride fmt <path …> [--check]` | Stride's one layout, comments kept; folders §17.13 |
| `stride help [command]` | the commands; with a command, its options and an example. `--help` or `-h` after a command, or alone, says the same (exit 0) |
| `stride version` | the tools' version, the language's (§21), the bytecode's (§18.1), the build, the Node inside, the platform (§17.17) |

17.1. **--today** fixes the date `today()` gives (`run`, in the browser and in the terminal, `test`, `eval`). It is checked before anything runs: a
missing value, a date not written `YYYY-MM-DD`, a day that does not exist, or a year outside 0001–9999 is a usage
mistake (exit 2). The device's date is never put in its place. A test case's `today` (§17, `<file>.tests/`) is
checked the same way. For program tests, a case’s own today takes precedence over --today; otherwise --today is
used, or the device’s date when neither is supplied.

17.2. **stride eval** takes exactly one complete expression: it may run over lines and be followed by a comment, but
a second argument, more than one expression, a named value, or input that closes the expression and goes on is a
usage mistake (exit 2), and nothing runs. Malformed syntax inside the attempted expression receives its normal
diagnostic (`stride eval 'let x = 1'` is S010, exit 1); empty input, or input of only whitespace and comments, is a
usage mistake (exit 2); extra arguments, or trailing input after a complete
expression, are usage mistakes (exit 2). Neither runs anything. Positions in the supplied expression start at line 1, column 1; positions
belonging to libraries retain their original files and locations.

17.3. **stride fmt** keeps every comment. A comment on its own line (a test's directives among them) stays a line
of its own, in order. A comment after code may move to the end of another line or join another such comment,
its words kept whole as a comment; no place in its line is kept.

17.4. **stride test names.** After a program, names choose which of its tests in `<file>.tests/` run. After a
`.test.stride` file a name is a usage mistake (exit 2), before anything runs: its expectations have no names.
Options such as `--today` stay allowed.

17.5. **Exit and usage mistakes.** A command exits 0 when it did what it says; 1 when it found mistakes, a fault, a
failing test, a layout `fmt --check` would change, or a bug; 2 for a usage mistake, after which nothing runs. A
command takes only the options its row shows: an unknown option, an option of another command, or one that takes a
value given none, is a usage mistake. So is an argument that names nothing: `stride explain` with a code that is not
one, `stride test` with a name no test of the program has, `stride eval --use` with a name that is not a library's
or names no library. A library that holds mistakes is reported as any program's mistakes are, at their places
(exit 1). A program without tests is said so by `stride test` (exit 1). Expected diagnostics or faults in tests
do not cause exit 1. A command takes the number of arguments its row
shows; more or fewer is a usage mistake, and so is a path to a file that is not there. `stride doc` with a word no
entry holds is a usage mistake.
A usage mistake of a command is three lines on stderr: `stride <command>: <what is wrong>`, the command's usage
line, `stride help <command> says more.` A word that is not a command is `stride: no command <word>` and the list
of commands. A file or folder that cannot be read or written is said by its path and why (`out.sbc: cannot be
written (its folder is not there)`, `x.stride: a folder, not a file`), never as a stack trace; a bug in stride
itself says so, and that `STRIDE_DEBUG=1` shows where.

17.6. **Starting and editing.**
- `stride header <file.pdf>` writes the form's header (§10) from its PDF: its sha256, and each box (a check box or
  radio button one per export value) as the PDF gives it: its kind, export value, longest length, place on its page
  and its maker's description, when it has one. It works nothing out: the words printed beside a box (§10.6) are
  not in a PDF, and are added to the header by whoever knows them. It is written to -o, or beside the PDF as `<file>.boxes.json`; the header's
  file name gives the form's id. A file that is not a PDF, or a PDF with no box a person fills, writes nothing
  (exit 1).
- `stride new <name>` writes a script `<name>.stride` (§4.6) and a test of it `<name>.tests/first.json`; with
  `--pdf`, a program for that form instead: its header `<name>.boxes.json`, the PDF beside it as `<name>.pdf`, a
  program asking one question for the first text box and skipping every other box, and a test of that question. The
  question's words are the box's description, else the box's own name, to be replaced by the form's own; its name
  is made from those words as a name (§2.1), never a keyword or a library function's name; the words and every box's name are written in quotes with `\`, `"`,
  `{` and `}` escaped (§2.6), so they are taken as written. When the form has no text box, or the
  program with the question would not compile, the program skips every box and its test gives no answers and
  expects every box empty. What it writes compiles and its test passes; a PDF for which even that cannot be made
  is said, and nothing is written (exit 1). It writes over nothing: when any file it would write is there already
  (the PDF at `<name>.pdf` included), that is said and nothing is written (exit 1); the one exception is the PDF
  given with `--pdf` when it is itself `<name>.pdf`, which is used as it is. A name that is not a form id (§4.1) is
  a usage mistake.
- `stride lsp` is the language server for editors, on stdin and stdout (the Language Server Protocol): the file as
  the editor holds it is compiled at each change, against the header and libraries beside it on disk, and its
  mistakes and warnings shown at their places with their labels (§16.2), a library (`lib/<name>.stride`) checked as
  the library it is, used from the folder that holds `lib/`; places as the protocol counts them, characters in
  UTF-16 units (columns of §1.3 are characters); a declaration in another file found at that file's own path;
  the rest as §17.16.

17.7. **Tracing.** `stride run --terminal --trace` (for a script, `stride run --trace`) on a source file runs the program as written, in the
intermediate form (which agrees with the machine, §19.1). It prints each statement's file, line and text when it
starts, a `let` known before the form opens included, and under it the names it gave a value; each turn of a loop,
at the loop's line, with its counter, or its item and number, as that turn has them; each call of a function with
its arguments, and what it gives back; each call of a standard library function with its arguments and what it
gives. All of it is indented by how deep the calls go. A loop's own work (its counter going up, its item taken, the
test of whether to go on) is not a statement of the program and is not shown as one. On bytecode, `--trace` prints
each instruction with its function, address, the top of the stack and the locals it changes, by name.
The trace goes to stderr (§17.11), so the program's own lines on stdout are as without it. An `if`, a `match` and
a `return` are statements and are shown as each.

17.8. **Program tests.** A test in `<file>.tests/` is a JSON object; every member is optional. `answers` (question
key to answer, as the page holds them; none: `{}`); `boxes` (box name, as the program writes it, to what it holds
after the run; none: `{}`; a box not listed must be empty unless `loose` is yes); `asked` (keys that must be asked,
in that order, others allowed before, between and after them); `unasked` (keys that must not be asked); `today`;
`prints` (exactly every line the run prints, in order); and `fault` (the code the run stops with; without it, a run
that stops fails the test). Each test runs in the machine and in the intermediate form, and any difference §19.1
names between the two fails it as a fault in the compiler, whatever the test expects.

17.9. **Help, versions and the library.** `stride help` lists every command; `stride help <command>`, or the
command with `--help` or `-h`, gives its options and an example; `--help` or `-h` alone is `stride help`; each exits
0, and a command that is not one is a usage mistake. `stride version` gives the language's version (§21) and the
bytecode's (§18.1). `stride doc` gives the entries of §14 whose name, section or description holds its word, each
with its signatures, what it gives and its examples (§14.0.7).

17.10. **The command line's grammar.** After the command come its options and arguments, in any order.
- An option is `--name`, `--name=value` or `--name value`. The short options are exactly `-h` (`--help`), `-q`
  (`--quiet`) and `-o` (`--output`); `stride help <command>` shows each beside its long form.
- `--` ends the options: everything after it is an argument.
- A dash followed by a digit (`-1`), a lone `-`, and a dash followed by more than one letter (`-odd.stride`,
  `-abs(2)`) are arguments; so a negative number, stdin, and a file or expression starting with a dash need no
  `--`, though one is allowed.
- Every command takes `--help`, `--quiet` and `--color` (§17.11).
- An option given twice, one that takes a value given none, a value given to one that takes none, an unknown
  option, and one of another command are usage mistakes (§17.5), each naming the option as it was written
  (`-o needs a value: -o file.sbc`).

`stride --version` is `stride version`; `stride --help` and `stride -h` are `stride help`.

17.11. **Output.** What a command gives goes to stdout: a run's questions, prints and boxes, a value, test
results, a map, a header, help asked for. Everything about it goes to stderr: mistakes, warnings, faults, the
trace, what a command did (`x.stride: no mistakes`), prompts.
- stdout is written whole before stride exits, to a terminal, a file or a pipe.
- A reader that closes the pipe early ends stride at once, quietly: with 1 when a failure (a mistake, a fault,
  what went wrong) was already said, else 0.
- `--quiet`/`-q` leaves out warnings and what a command did; never what it gives, its mistakes or its faults.
- `--json`: §16.2.
- **In the browser** (§17.18), a run's output is the page's: what the program prints goes to the browser's
  console, a console line for each printed line, each time a change of answers makes the run print other lines
  than it last did; a fault is said there in full as §16.3 shows it, its code, words, place and the calls that led
  there. Nothing the page runs goes to the terminal or anywhere else. `stride run`'s own stdout and stderr then carry
  only its address, what it did and its mistakes; the terminal's output (`--terminal`) is as this rule says above.
- `--color=auto|always|never`: `auto`, the default, colours a stream only when it is a terminal and `NO_COLOR` is
  not set; another value is a usage mistake.

17.12. **Answers** for `run` in the terminal (§17.18) and `debug`, combined in this order, a later one winning for its key:
1. one answers file, `answers.json`, or `-` for the same on stdin: a JSON object of question key to answer, as
   §8.7 takes them, read as bytes and refused when they are not UTF-8;
2. `key=value` words. The key is the question's key exactly as §8.6 builds it (`total`, `people[2]`,
   `people[1]#another`, `ask_person(n=1).age`, `people:address(who="my spouse").city`); the `=` that ends it is
   the first one outside a quoted word and outside brackets. The value is the answer's words exactly as written,
   converted as §8.7 converts words. For a one-of question, the value is an option's value. For an any-of
   question, the value is one option's value when it is one; else values separated by commas; an option whose
   value holds a comma, given with others, is given in an answers file.

A word is `key=value` when it starts with a letter or `_` and holds such an `=`; any other word is the answers
file. A file whose name would read as `key=value` is given as `./name`. A second answers file, `-` used for both
the program and the answers, and `--prompt` with `--no-prompt` are usage mistakes.

**Asking.** With `--prompt`, or with no answers given, stdin a terminal and neither `--no-prompt` nor `--json`,
each question the run reaches without an answer is asked, in the order the run reaches them, even when the run
with the answers so far would stop at a fault after it. A question is its printed words, its default in brackets,
its options numbered, on stderr. The line typed is the answer as typed, converted by §8.7 like a `key=value`
value, except for these, which are all: an empty line leaves the question unanswered (its default, if it has
one, is used); for yes-no, `y` or `Y` is yes and `n` or `N` is no; for one-of and any-of, a whole number is the
option of that number when no option has that value. The line is read as UTF-8, a character never split by how
stdin arrives. Piped answers are written after their question, so stderr reads as a session; the end of stdin
leaves the rest unanswered. With stdin not a terminal and no answers given, nothing is asked.

`stride run -` reads the program, a script, from stdin, as bytes checked as UTF-8 as a file's are (§1.1).

17.13. **A folder of files.** `stride check`, `stride test` and `stride fmt` take files and folders. A folder
stands for every `.stride` file in it and below, leaving out folders whose name starts with a dot,
`node_modules`, and `<name>.tests` folders. `check` leaves out libraries (§4.7: in a `lib` folder or a project's
library folder), which are checked by the programs that use them; `test` takes the programs that have a
`<name>.tests/` folder and the `.test.stride` files. `check` and `test` with no path take the folder they are run
in. Files are taken in the order of their paths, and named as the platform writes paths. `fmt --check` prints on
stdout each file it would change. `stride test --match words` runs only the tests whose name holds the words.
`stride test file.sbc` runs `file.tests/` beside the bytecode, without the source.

17.14. **stride repl** is a session. Each line, or each set of lines until its brackets close, is an entry.
- A declaration, `use`, `let`, `var`, `ask` or other statement is compiled as the end of a script (§4.6) holding
  every entry kept before it, and run; it is kept when it has no mistake and its run does not fault.
- An expression's value is printed on stdout, as `print` would print it; an expression is not kept.
- An entry with a mistake or a fault is said on stderr, and nothing of it is kept: no name, no value, no answer.
- **Each kept entry runs once.** The session is run from its start with what it had the first time: each
  library as it was when the session first read it, the answers kept, and the date the session began (or
  `--today`). A run is the same for the same of these (§13), so no later entry changes what an earlier one gave,
  and each entry's prints are shown once, when it is typed. `:reload` reads the libraries again and runs what is
  kept with them; if they give the session a mistake or a fault, the session stays as it was, and that is said.
- **Answers.** An `ask` asks its question there and then, as §17.12 asks. The answers an entry is given are kept
  when the entry is, and not otherwise; `:undo` forgets the last entry and the answers it brought.
- W004–W007 (a name, answer, function or constant not used yet) are not given in a session.
- `:list` shows what is kept, numbered; `:answers` the answers kept; `:reset` forgets everything, answers and the
  libraries read; `:help` lists these; `:quit` or the end of stdin ends it.
- `--use` and `--today` are as `eval`'s; the session stands in the folder it is run in (§4.7).

17.15. **The debugger.** `stride debug <file>` runs a program or script as `--trace` does (the intermediate
form), with its answers taken exactly as `run` takes them (§17.12), and stops before its first
statement. It is driven from stdin, a command a line. Where it stopped and everything it says go to stderr; the
program's prints go to stdout exactly as `run` prints them; a fault is said exactly as `run` says it (§16.3), with
its calls; it exits as `run` would.
- `break N`, `b N`, `b file:N` sets a breakpoint on line N of the program or of a library. The file is named from
  the folder you are in, from the program's folder, or by the end of its path, with either separator; a full path
  is taken as it is. A line where no statement starts is refused, and that is said. `delete` removes one;
  `breaks` lists them.
- `continue`/`c` runs to the next breakpoint, in any turn of a loop or call of a function; `step`/`s` to the next
  statement, into a call; `next`/`n` to the next statement in this function or the one that called it; `out`/`o`
  to the statement after this function's call.
- `print NAME`/`p`, `locals`/`l`, `where`/`w` (the calls, innermost first, each with its file and line) and `list`
  (the lines around this one) show; `quit`/`q` ends; `help` lists these.

`stride dap` is the same debugger for editors, the Debug Adapter Protocol on stdin and stdout: `initialize`,
`launch` (`program`, a path from the adapter's folder or a full one; `answers`, a JSON object as §17.12's file;
`today`; `stopOnEntry`), `setBreakpoints` (each verified or not, as `break` decides), `configurationDone`,
`threads` (one), `stackTrace`, `scopes`, `variables` (a record's fields and a list's items as children),
`evaluate` (a name), `continue`, `next`, `stepIn`, `stepOut`, `disconnect`, `terminate`. It sends `stopped`
(`entry`, `breakpoint` or `step`), `output` (the program's prints as `run` prints them, a fault as `run` says
it), `exited` and `terminated`.

17.16. **Editors.** `stride lsp` (§17.6) also gives:
- completion after `name.`: a library's exports when `name` is a library's `as` name, a record's fields when
  `name` holds a record;
- the signature of the function being called, and which argument the cursor is in;
- references: every place the name's declaration is named, in the file and, for a name a library declares, in
  every file of the project (§4.7) that uses it;
- rename: the edits that rename the declaration and every reference to it, in every file references would find.
  The new name is refused, with why, and no edit given, when it is not a name (§2.1), is a keyword, or is a standard library name; and when the project's files, with the edits made,
  would have a mistake they did not have, or any name in them would refer to another declaration than it did (a
  name captured, or capturing). A standard library name is never renamed.

`stride vscode` writes the VS Code extension, a `.vsix` (`stride-<version>.vsix`, or `-o`), to install with `code
--install-extension`. It gives highlighting, the language server's features, snippets and the debugger (F5 runs
the open file under `stride dap`). It runs `stride`, or the command the `stride.command` setting names.

17.17. **Building, installing and sharing.** This release supports Linux x64, including WSL2. Other platforms
are outside this release's scope. Building or running from the repository requires Node 22 or later and the
repository's dependencies. `node scripts/build.mjs` makes `dist/stride`, one Linux executable holding the
tools, the standard library, the guides, the workflow page (§17.18) and the VS Code extension; the installed executable
needs neither a separate Node installation nor the repository.

A build's name is `YYYY-MM-DD.` and twelve hex digits of the sha256 of the bundle as built (everything put in
the executable) and the Node version; `stride version` gives it.

`sh scripts/install.sh` copies `dist/stride` to `/usr/local/bin` when run as root, else `~/.local/bin`. It
replaces a stride there at once (never half-written), says `installed: <path>, stride <version> (build <id>)
(was <the one replaced>)`, says how to add the folder to PATH when it is not on it, and changes nothing else.
Upgrading is the same build and install commands.

A compiled program (`.sbc`) runs, and its tests run, wherever stride of the same bytecode version is, without
its source or libraries (§21.2).

17.18. **Running a workflow.** `stride run` runs a program (a file with a form, §4.1, or bytecode compiled from
one) in the browser, and a script (§4.6, or bytecode compiled from one) in the terminal.
- **In the browser.** A source program is checked against its form's header (`<name>.boxes.json`, §10) and
  compiled, with every check `stride check` makes; when it has mistakes they are said as §16.2 shows them and
  nothing is served (exit 1). Else the workflow is served at `http://127.0.0.1:<port>/` (8080, or `--port`; `--port
  0` takes any free port), to this computer only, until stopped: the PDF, the questions one at a time beside it,
  each answer going into its boxes as Stride's runner (`runtime/runner.js`) puts it, and the filled PDF to download. Its
  address is printed on stdout and the computer's browser is opened at it, unless the environment variable
  `BROWSER` is `none`. It needs no answers: they are given in the page, and the page sends them nowhere.
- **In the page.** When the workflow is opened the run's writes are put in the boxes, those made from no answer
  among them, and again at each answer. Every question the run reaches is asked, even when the run with the answers
  so far stops at a fault after it, as the prompt asks (§17.12): the fault is shown after the last question
  reached, and the person can go back to any question and change its answer. Output: §17.11.
- **Reloading.** A source program is compiled again each time the page is loaded, its libraries and header read
  again, so saving the source and reloading shows the change. When it has mistakes then, the page shows them,
  with their places, in place of the questions, and gives no workflow until they are mended.
- **The PDF** is `--pdf`, else `<name>.pdf` beside the program or the bytecode. It is read again at each reload,
  with the source and its header, so the three may be replaced together while the run goes on. One whose sha256 is
  not the one the program's header names, or for bytecode the one compiled into it, is refused when the run starts
  (exit 1) and at each reload after, with that said, and so is one no longer there; the page is given the reason,
  never the program.
- **Bytecode.** `stride compile <name>.stride` writes `<name>.sbc` (or `-o`): the program and the library code it
  uses, its questions with their keys, words, checks and defaults, the boxes each answer goes into with their kinds
  and export values, and the sha256 of its form's PDF: everything a run needs but the PDF. It needs no answers,
  runs nothing and opens no browser; it takes source, and bytecode given to it (or to `map`) is a usage mistake.
  `stride run
  <name>.sbc` serves the same workflow from it alone, with no source, library or header, and its PDF.
- **In the terminal.** `--terminal` runs a program in the terminal, saying the questions it asked with their
  answers, what it printed and the boxes it wrote, with answers (§17.12), `--prompt`, `--no-prompt`, `--json`
  (§16.2) and `--trace` (§17.7). A script always runs in the terminal; `--terminal` changes nothing for it.
- **Options of the other place.** In the browser, answers (a file, `-` or `key=value`), `--prompt`, `--no-prompt`,
  `--json` and `--trace` are usage mistakes, which say to add `--terminal`; in the terminal, `--pdf` and `--port`
  are. `--today` is taken by both: in the browser it is the date the page's `today()` gives.
- **One run, three places.** For the same answers and the same date, a program run in the browser, in the
  terminal, and from its bytecode in either, reaches the same questions with the same keys, writes the same boxes
  with the same values and prints the same lines (§19.1).
- Sample answers belong to tests (§17.8), which run a program on them and compare what it does; looking at the
  source's logic step by step is the debugger's (§17.15). `stride check` remains, for checking without running or
  writing anything, and for a folder (§17.13).

## 18. Bytecode

18.1. Version 3. A file is `STRD`, the version byte, then sections (tag, length, bytes); a reader skips a section
it does not know; a section that holds more or fewer bytes than it says is refused. The program and code sections
must be there, each once; a tag that comes twice is refused. The places section may be left out: then no fault
has a source place. The compiler always writes it. Sections may come in any order.

18.2. Numbers are written as their words (§3.3.5). Each function keeps its locals' names; the place table holds a
line and a column for each instruction that can fault.

18.3. Loading verifies: every instruction known and complete; every operand in range (a native's argument count
its native's); every jump onto an instruction of its function (forward, `LOOP` backward); every function ending;
the stack's height the same where paths meet, never below what an instruction takes, nothing left at a return.

## 19. Conformance

19.1. An implementation conforms when every test in `tests` passes in the machine and in the
intermediate form's interpreter, and they agree on: every question reached, in order, with its
key, printed words, value, default, failed checks' messages in order, and unreadable answer with its reason;
every box written and its value; every `print`, in order; and every fault: its code, its message, and its whole
stack — the function and place of the faulting operation and of every call that led there, innermost
first (§13.4).

19.1.1. **Resource limits are not semantics.** F014 (instructions) and F015 (call depth) depend on the engine:
the machine counts instructions and the interpreter counts steps. Two engines that agree on every question, box, `print` and fault may still exhaust a limit
differently. So:
- the **reference** is the program in the machine;
- **semantic comparison** (§19.1) is made only on runs the reference finishes within the limits; on those, every
  engine must finish and agree, so an engine stopping where the reference finishes is a conformance failure;
- a run the reference exhausts is not compared, whatever the other engines do.
19.1.2. **Each engine's enforcement is tested on its own.** The machine is tested to stop with F014 at 2,000,000
instructions and with F015 past 200 frames, counted as it runs the program it was given; the interpreter to stop
at its own count of steps and frames; each test runs one engine on a program built to exhaust that engine, and
names the engine. No test claims that every engine exhausts on the same run.
19.1.3. `node scripts/fuzz.mjs` drops a generated run that the reference exhausts.

19.2. `node scripts/fuzz.mjs [runs] [seed]`, in the repository, generates valid programs and answers and runs each in both engines, and
through the PDF check; a disagreement, a crash, or a mistake on a valid program is a bug. It reports apart the
programs that agreed, those stopped by a budget (S602), and the runs the reference exhausted.

19.3. **Faults no type-correct program reaches.** F006, F016, F018 and F019 guard against a fault in the
compiler or the machine itself; no program the compiler accepts can reach them. They are tested by the machine's
own tests (`tests/machine/*.mjs`), which hand the machine bytecode built by hand with exactly that fault,
name the fault's code with `// rule F006`, and are run and counted by `node scripts/selftest.mjs` like every other test.

19.4. **Tests of the standard library's declarations** (S301, S302) give their own standard library with
`# std <file>` (a file in `tests/lib/`), since only the standard library declares natives.

## 20. Not used

This number named a list that is no longer part of the specification. It stays so that §21 keeps its number.

## 21. Versions

21.1. This specification is Stride 1.0.0, `stride version`'s first number. A version is MAJOR.MINOR.PATCH. What a
program does is what §19.1 compares: the questions it reaches, with their keys, words, values, defaults, checks and
unreadable marks; the boxes it writes; what it prints; and the fault it stops with; for the same source, libraries,
header (the PDF's boxes and printed words), answers and run date (today()). Its mistakes and warnings are part of
it too.
- A **patch** changes no rule: it makes the tools do what this specification already says. What a program does
  changes only where the tools did not follow the specification, and the release names those rules.
- A **minor** version adds, keeping what every program the version before accepted does: a function, a statement,
  a command, a warning. A change counts as minor only when it keeps that; one that seems an addition and does not
  is major. Raising a limit is not minor when a program could see it: more digits change what a calculation gives,
  and a longer list or longer words remove an F017 or F012 a program stopped with. The one exception is §19.1.1's:
  a run the instruction or call-depth budget stops (F014, F015) may finish in a later version, as an engine with
  more room may finish it now.
- A **major** version is any other change: a rule's meaning changed, a mistake given to a program accepted before,
  a fault removed or added, a limit changed where a program could see it, a function removed. The release lists
  every rule changed, by its number.

The conformance suite (§19) is how a version keeps its word: a release passes every test of the version before,
except the tests of the rules a major release lists as changed.

21.2. The bytecode has its own version (§18.1). It names everything a machine must agree on to run a program as its
compiler meant: the file's layout, the instruction set and what each instruction does, the natives a program may
call with their arguments and results, and what every value and operation means (§3, §6, §13, §14). Any change to
one of these raises it, even when the layout is unchanged; a machine runs only its own version, so a form's page
never runs a program compiled for another. Compile again with the new `stride` to move a program.
