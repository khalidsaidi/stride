# Stride against Starlark-Go: the gap list

> History. This was written before Stride 1.0 and describes the language as it was planned then, not as it is. What
> Stride is now: [the guide](../guide.md) and [the specification](../spec.md).

Every behaviour of Starlark-Go (github.com/google/starlark-go, cloned and read file by file: syntax/scan.go,
parse.go, syntax.go, walk.go, quote.go, options.go; resolve/resolve.go, binding.go; internal/compile/compile.go,
serial.go; internal/spell; starlark/interp.go, eval.go, value.go, library.go, int.go, debug.go; lib/math, lib/time,
lib/json; starlarkstruct; starlarktest/assert.star; cmd/starlark; doc/spec.md), with what Stride does today.

Verdicts: **same**, **shallower**, **missing**, **n/a** (does not apply, with the reason). A shallower or missing
line is closed only by a test in `tests` that shows the behaviour and passes in the machine and the
intermediate form; the last column names it.

Once, rather than on every line: these parts of Starlark-Go are Python's dynamic language, or Go's embedding of it,
and have no place in a statically typed language for workflows: dynamic types and `type()`, `dir`, `getattr`,
`hasattr`, `hash`, `repr`; `*args`/`**kwargs`; dicts and their methods (a record's fields are known before the form
opens, which the PDF check needs to follow every box); tuples (a record says what each part is); `bytes`;
bit operations `& | ^ ~ << >>` (nothing on a form is a bit pattern); threads, `Cancel`, freezing values for sharing
between threads; Go interop (`Value` implemented in Go, `unpack.go` reflection); the REPL; Go CPU and memory
profiles; lib/json and lib/proto (a program reads answers and writes boxes; it exchanges no data); trigonometry,
logarithms and gamma in lib/math; time zones, durations and timestamps in lib/time (a form's date is a day).

Probes behind the findings are in the scratchpad (`probe.mjs` compiles a program as the self-tests do and runs it
in the machine and the intermediate form).

## 1. Scanner (syntax/scan.go, quote.go)

| # | Starlark-Go | Stride today | Verdict | Closed by |
|---|---|---|---|---|
| 1.1 | Columns count characters (runes) | counts UTF-16 units (syntax.mjs:71): after two emoji, a mistake at column 16 is reported at 18 (probe) | shallower | |
| 1.2 | `\r\n` and a lone `\r` are one line end | `\r` is a space (syntax.mjs:95): a file with `\r` line ends is one line; a mistake on line 3 is reported at 1:97 (probe) | shallower | |
| 1.3 | Identifiers of letters of any script | ASCII; `é` gives `"é" is not understood here` | n/a for the rule (printed words carry every script; names are the program's); shallower for the message, which should say names are a–z, 0–9, _ | |
| 1.4 | Integer literals of any size are exact | `Number(value)`: `9007199254740993` is silently `9007199254740992` (probe) | shallower (with 6.1) | |
| 1.5 | Float literals with exponents | refused with a clear message | n/a: amounts are written in decimals | |
| 1.6 | `0755` refused: "obsolete form of octal literal" | `0755` is silently 755 (probe) | shallower: a leading zero is refused (an id with leading zeros is words in quotes) | |
| 1.7 | Escapes `\a \b \f \n \r \t \v \\ \' \" \ooo \xhh \uhhhh \Uhhhhhhhh`, bad ones and surrogates refused; `Quote` writes them back | `\" \\ \{ \} \n` (syntax.mjs:174); no `\t`, no `\u`; the formatter writes a tab raw | shallower: `\t`, `\u{hex}` with range and surrogate checks, the formatter writing them | |
| 1.8 | Triple-quoted and raw strings | one line only | n/a: printed words are one line; a long question is a long line | |
| 1.9 | Nesting limited to 1000, reported at its place ("excessive nesting") | the engine's stack overflow, caught, reported without a place (probe: 3000 parentheses) | shallower | |
| 1.10 | An unmatched closing bracket is a mistake at it | reported by the parser | same | |
| 1.11 | Python's other words (`class`, `import`, `try`, `while`, …) reserved, so a program in another language's habits fails clearly | `let x = true` says "nothing called true … did you mean trim?" (probe); `while`, `null`, `false`, `elif`, `function`, `def` get no help | shallower: words of other languages (`true false null none while def function elif else-if`) answered with what Stride writes instead | |
| 1.12 | A lexer mistake is reported and the file not used | reported; the line is set aside and the rest read for more | same, deeper | |

## 2. Parser (syntax/parse.go, syntax.go, walk.go)

| # | Starlark-Go | Stride today | Verdict | Closed by |
|---|---|---|---|---|
| 2.1 | Depth counted on every cycle of the grammar (`enter`/`leave`), limit 1000, reported at the place | none (1.9) | shallower | |
| 2.2 | Conditional expression `a if c else b` | none: a value chosen by a condition needs a var and an if | missing | |
| 2.3 | Comprehensions `[f(x) for x in l if c]` | none: a list made from a list needs a var and a for each | missing | |
| 2.4 | Slices `x[lo:hi]` of lists and strings | `slice()` for text; none for lists | missing for lists | |
| 2.5 | Augmented assignment `+= -= *= /=`, the target worked out once | none | missing | |
| 2.6 | `%` remainder and `//` floor division as operators | `remainder()` native; no floor division | missing | |
| 2.7 | Optional parameters with defaults `def f(a, b=1)`, rules (required after optional refused) | every parameter required | missing | |
| 2.8 | Named arguments `f(x=1)`, repeated or positional-after-named refused, unknown names refused with a hint | none | missing | |
| 2.9 | `break`, `continue` (and `while`, `pass`) | none | missing for break and continue; n/a for while (every loop is bounded, so every run ends and the PDF check follows every path) and pass (`{}` is an empty block) | |
| 2.10 | `lambda`, nested `def`, closures | none | n/a: functions are top-level declarations, not values; the PDF check follows each call to its function, which a function passed as a value would hide | |
| 2.11 | Comparisons do not chain ("== does not associate with <") | refused | same | |
| 2.12 | `ParseExpr`/`Eval`: one expression on its own | Program or Library only | missing: `stride eval "expr"` | |
| 2.13 | Comments kept and attached to nodes, for a printer that keeps them | the formatter finds comments by line and puts them back | same | |
| 2.14 | Stops at the first mistake | recovers at the next statement, up to 20 | same, deeper | |

## 3. Resolver (resolve/resolve.go, binding.go, internal/spell)

| # | Starlark-Go | Stride today | Verdict | Closed by |
|---|---|---|---|---|
| 3.1 | Every name resolved before anything runs | same | same | |
| 3.2 | Duplicate parameter refused | same (resolve.mjs:195) | same | |
| 3.3 | A top-level name defined twice refused, with where it was first | same, with a note at the first | same | |
| 3.4 | `break`/`continue` outside a loop refused | with 2.9 | missing | |
| 3.5 | `return` outside a function refused | a `return` in the program ends it | n/a: ending the workflow early is the program's own return | |
| 3.6 | `load` only at the top, not in a function, loop or if | `use` only at the top | same | |
| 3.7 | More than 255 arguments in a call refused | no limit on arguments, parameters, locals, constants, list literals | shallower: a limit, refused with a mistake at the place | |
| 3.8 | Free variables and cells | none (2.10) | n/a | |
| 3.9 | Spelling hint folds case and `_` (`FullName` finds `full_name`), allows up to half the letters wrong | Damerau-Levenshtein with transpositions, 1–3 edits, no folding (source.mjs:144) | shallower: case and `_` folded | |
| 3.10 | Uses before definitions at top level | declarations anywhere; statements in order with "used before it is defined, on line N" | same, deeper | |

## 4. Compiler (internal/compile/compile.go)

| # | Starlark-Go | Stride today | Verdict | Closed by |
|---|---|---|---|---|
| 4.1 | A position (line and column) recorded before every instruction that can fail (`setPos`) | a line per statement, no column (codegen.mjs:69) | shallower | |
| 4.2 | Code from a function keeps the function's position | an inlined function's statements carry the call's line: a division by zero inside `half()` is reported at the caller, with no "called from" (probe) | shallower | |
| 4.3 | `if a and b` / `not` compiled straight into jumps (`ifelse`), no value made | `and`/`or` make a value (JUMP_IF_*_KEEP), then the branch tests it again | shallower | |
| 4.4 | Max stack computed per function, underflow found | the verifier does both at load | same | |
| 4.5 | Jump threading; the next block placed to fall through | reverse post-order layout, jumps to the next block left out, peephole | same | |
| 4.6 | Adjacent string literals folded | concat folding in the optimiser | same | |
| 4.7 | Constant pool without duplicates | texts and numbers pooled | same | |
| 4.8 | Each pass linear in the code | the peephole pass starts over from the first instruction after every change and looks labels up with indexOf (codegen.mjs:412-504): quadratic or worse on a long function | shallower | |
| 4.9 | Docstrings kept on functions | none | n/a: nothing reads a function's documentation at run time; comments document | |

## 5. Bytecode (internal/compile/serial.go)

| # | Starlark-Go | Stride today | Verdict | Closed by |
|---|---|---|---|---|
| 5.1 | Magic, version; a different version refused | same, plus sections a reader may skip | same, deeper | |
| 5.2 | Each function's locals kept with their names and positions (for a debugger and messages) | only counts (stride-bytecode.mjs:285) | shallower: names kept, so a fault and the trace can name values | |
| 5.3 | The position table holds line and column | line only (stride-bytecode.mjs:290) | shallower (with 4.1) | |
| 5.4 | Big integers written as decimal text | numbers as 8-byte floats | shallower (with 6.1) | |
| 5.5 | Decoding trusts the compiler | verified on load: operands, jumps, stack heights | same, deeper | |
| 5.6 | — | the verifier does not check a NATIVE's argument count against the native (stride-bytecode.mjs:351) | shallower: a damaged file can call a native with the wrong count | |

## 6. Numbers (starlark/int.go, value.go Float, eval.go Binary)

| # | Starlark-Go | Stride today | Verdict | Closed by |
|---|---|---|---|---|
| 6.1 | Integers exact at any size | doubles: `9007199254740993` is `…992` (probe) | shallower | |
| 6.2 | Exact integer arithmetic; floats separate, their mixing defined | `0.1 + 0.2 == 0.3` is no (probe); sums of money drift | shallower: Stride numbers exact decimals | |
| 6.3 | Division by zero faults at the operation | faults | same | |
| 6.4 | An overflowing or non-finite result cannot become an int or a string unseen | `n * 1e36` with n = 1e300 is Infinity, written as an empty box, no fault (probe) | shallower | |
| 6.5 | A number shown exactly | `2.5000000000000002e+36` in a box (probe) | shallower | |
| 6.6 | `//` and `%` (floored) | `remainder` (truncated), no floor | missing (with 2.6) | |
| 6.7 | lib/math `ceil`, `floor`, `round`, `pow`, `sqrt` | `round`, `whole` (truncate); `round(2.5, 2.5)` gives `2.50136162919` (probe) | shallower: `round` with places not whole faults; missing `ceil`, `floor` | |
| 6.8 | `int("x")` of a bad string is an error naming the string | `number_of` and answers accept `0x10` as 16 and `1e5` (Number()) | shallower: an answer or words read as a number take only decimal digits, a sign, separators and a point | |

## 7. Values, indexing, comparison (starlark/value.go, eval.go getIndex/setIndex/getAttr, starlarkstruct)

| # | Starlark-Go | Stride today | Verdict | Closed by |
|---|---|---|---|---|
| 7.1 | An index out of range faults: "index 7 out of range [-3:2]" | `l[n]` with n = 7, 0, -1 or 2.5 is empty (probe; stride-vm.mjs:191, interpret.mjs:150) | shallower: an index not a whole number from 1 to the list's most faults; within the most but past the items it is empty (a form's empty row) | |
| 7.2 | A field of a value that has none faults, with a spelling hint | GET_FIELD of a non-record is empty (stride-vm.mjs:175; interpret.mjs:110,145) | shallower: of an empty record (a list's absent item) it is empty; of anything else, a fault | |
| 7.3 | A list cannot change while a loop goes over it ("cannot assign to element of list during iteration") | `l[3] = x` inside `for each x in l` grows the list and the loop runs 3 times over 2 items (probe) | shallower: refused by the checker where the list is the loop's, a fault otherwise | |
| 7.4 | Structs compare by value | records cannot be compared ("p and p cannot be compared", probe) | missing: `==`/`!=` on records of one type, field by field | |
| 7.5 | Lists compare element by element; `<` lexicographic | `==` only | same for `==`; n/a for `<` on lists (no form orders lists) | |
| 7.6 | Strings ordered (`<`) | refused ("not text and text", probe) | missing: words ordered (sorting names) | |
| 7.7 | `list + list` | refused (probe) | missing | |
| 7.8 | An operator on values it does not take is an error naming both types | the checker refuses; the machine turns `undefined` into empty silently (stride-vm.mjs:314; stride-ops.mjs binary) | shallower: the machine faults ("cannot apply < to …"), so a compiler fault is not hidden | |
| 7.9 | Comparison depth limited (`CompareLimit`) | equal() recursion unbounded | n/a: values are trees of bounded depth (records cannot hold themselves, lists have a most) | |
| 7.10 | Allocation limited (`maxAlloc`: "excessive repeat") | `s = s + s` forty times builds 2^40 characters before anything stops it; `pad_left` silently cuts a width to 1000 (probe) | shallower: words over a fixed length fault; `pad_left` past it faults | |
| 7.11 | Truth of values defined for each type | a condition is yes-no only (checked); empty is no | same | |

## 8. The machine (starlark/interp.go, eval.go Call/setArgs, debug.go)

| # | Starlark-Go | Stride today | Verdict | Closed by |
|---|---|---|---|---|
| 8.1 | An error carries the call stack; `Backtrace()` prints "Traceback (most recent call last)" with each frame's position | the fault carries the stack (stride-vm.mjs:121); `stride run` prints only the innermost line (stride-cli.mjs:121) | shallower | |
| 8.2 | Recursion refused at run time, or a depth limit | refused by the compiler; the machine stops past 200 frames | same | |
| 8.3 | Step limit (`SetMaxExecutionSteps`), "too many steps" | 2,000,000 instructions, a fault | same | |
| 8.4 | A frame's locals readable by a debugger (`DebugFrame.Local`) with their names | the trace prints the stack top only | shallower (with 5.2): `stride run --trace` names the locals that change | |
| 8.5 | A native given the wrong kind of value fails with the native's name and what it wanted | natives turn what they cannot use into empty: `character(t, 0)`, `character(t, 2.5)`, `word(t, -1)`, `line(t, 0)` give "" (probe); `grouped`, `fixed` clamp places to 0–10 silently | shallower: a position not a whole number of 1 or more, places not whole or outside 0–10, fault with the native's name | |
| 8.6 | `fail(msg)` stops a run with the program's own message | none | missing | |
| 8.7 | `print(…)` writes to the host (stderr, or the host's function) | none | missing: `print` goes to the host; `stride run` shows it, the page ignores it | |
| 8.8 | An error inside the interpreter that is not the program's is "internal error", kept apart | anything thrown becomes "the machine stopped: …" | same | |

## 9. The standard library (starlark/library.go, lib/math)

| # | Starlark-Go | Stride today | Verdict | Closed by |
|---|---|---|---|---|
| 9.1 | `len` of strings, lists, sets | `length` (words), `count` (lists, sets) | same | |
| 9.2 | `any(l)`, `all(l)` of a list of bools | none | missing | |
| 9.3 | `min(l)`, `max(l)` of a list | two numbers only | missing for lists | |
| 9.4 | `sorted(l, reverse=)`, `reversed(l)` | none | missing (children by birth date, names in order) | |
| 9.5 | `enumerate` | `for each n, x` | same | |
| 9.6 | `range(a, b, step)` | `for i in a..b` | same; n/a for step (no form counts in steps) | |
| 9.7 | `zip` | none | n/a: two lists side by side are one list of records | |
| 9.8 | `str`, `int`, `float`, `bool` | `text_of`, `number_of` | same | |
| 9.9 | `list.index`, `list.insert`, `list.pop`, `list.remove`, `list.extend`, `list.clear` | none but `l[i] = v` | missing: `index_of`, `without` (a new list), `+` (7.7) | |
| 9.10 | `str.split(sep)`, `rsplit`, `partition` | `word`, `line`; no split on a separator | missing: `split(t, sep)` | |
| 9.11 | `str.find`, `index`, `rfind`, `count` | `contains` | missing: `find` (position from 1, 0 when absent), `occurrences` | |
| 9.12 | `str.strip(chars)`, `lstrip`, `rstrip`, `removeprefix`, `removesuffix` | `trim` (spaces only) | missing: `trim_start`, `trim_end`, `remove_prefix`, `remove_suffix` | |
| 9.13 | `str.title`, `capitalize` | none | missing (names as the form wants them) | |
| 9.14 | `str.isdigit`, `isalpha`, `isalnum`, `isspace`, `isupper`, `islower` | `digits()`, `letters()` | missing: `is_digits`, `is_letters` (for checks) | |
| 9.15 | `startswith`/`endswith` case-sensitive | case-insensitive | n/a: answers are typed in any case; the manual says so | |
| 9.16 | Sets: `union`, `intersection`, `difference`, `issubset` | `in` on a set of options | missing for `set of`: `|`-like union, intersection, difference via functions | |
| 9.17 | `string.format` | `"…{e}…"` | same | |
| 9.18 | Each built-in checks its arguments and names itself in its errors ("chr: got 2 arguments, want 1") | arguments checked by the compiler; values at run time see 8.5 | with 8.5 | |
| 9.19 | lib/math `ceil`, `floor`, `pow`, `sqrt` | none | missing: `ceil`, `floor` (6.7); n/a `pow`/`sqrt` (no form computes them) | |
| 9.20 | lib/time `parse_time(words, format)` | dates come as date answers | n/a: a date is asked as a date | |

## 10. Tests, command line, manual (starlarktest, cmd/starlark, doc/spec.md)

| # | Starlark-Go | Stride today | Verdict | Closed by |
|---|---|---|---|---|
| 10.1 | `assert.eq`, `assert.true`, `assert.fails(f, pattern)`: a library's functions tested in the language itself | a library function is tested only through a program that fills boxes | missing: tests of a library's functions on their own (`stride test lib.stride`, expectations of a call's value or fault) | |
| 10.2 | `starlark -c 'expr'`, the REPL | none | missing: `stride eval` (2.12); n/a REPL | |
| 10.3 | `-disassemble` | `stride asm`, `--ir` | same | |
| 10.4 | `-showenv`: the globals after a run | `stride run` prints questions and boxes | same | |
| 10.5 | `-profile` | none | n/a: a run takes 0.06 ms | |
| 10.6 | doc/spec.md, 4,354 lines: every lexical element, every operator on every type with its errors, evaluation order, every built-in with its parameters, results and errors | grammar.md, 300 lines: the natives by name only ("each is described where it is declared"); no escapes table, no evaluation order, no operator-by-type table; says "up to ten" mistakes (line 208) where the parser reports twenty | shallower | |

## 11. Stride's own parts (types, flow, optimiser, PDF check; Starlark-Go has none of these)

| # | Behaviour | Stride today | Verdict | Closed by |
|---|---|---|---|---|
| 11.1 | A fault certain before the form opens is a mistake (as Go refuses a constant division by zero) | `1 / 0`, a pure call on known values that faults, are left to the machine: the optimiser and the constant evaluator catch and drop the fault (optimise.mjs:72, 104, 329; constant.mjs:67, 90) | shallower | |
| 11.2 | The PDF check's own evaluation of a fault | a fault on a known path becomes an unknown value (pdf.mjs:469, 487, 500) | shallower: with 11.1, a mistake | |
| 11.3 | The intermediate form's interpreter means what the machine means | the same silent empties as the machine (interpret.mjs:110, 111, 145, 150) | with 7.1, 7.2 | |
