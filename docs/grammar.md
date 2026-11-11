# Stride reference manual

Stride is the language a form's workflow is written in. A program says which questions a form needs, in what
order and under what conditions, and what each answer writes into the issuer's own PDF boxes. How the
questions are shown, in which human language, and how a person moves between them belong to the page that runs
the program (`runtime/runner.js`), not to the language.

This is the short guide. The definition is `spec.md`: where the two differ, the spec is right, and each rule
here names its section (§x.y).

One program per form, `<form>.stride`, written against one exact PDF. Beside it:

- `<form>.boxes.json`, the header: the PDF's boxes, as the PDF gives them, written by
  `stride header <form>.pdf`. A program is checked against it, as a C program is against its headers.
- `<form>.tests/*.json`: the program's tests.

Libraries are in `lib/`; the standard library is `lib/std.stride`. A test file `<name>.test.stride`
stands beside a library and holds `import`, declarations, `let` and `expect` (§4.3). The grammar is at the top of
`src/syntax.mjs`, the hand-written lexer and parser that read it.

## Files

A program starts with its header, then holds imports, declarations and statements in any order (§4):

```
form irs-2848                      # the form's id
pdf 14377021f958…                  # the sha256 of the PDF it is written against (64 hex digits, small letters)
fields "topmostSubform[0]."        # optional: put before every box name below
import "people"                    # a library from lib/people.stride, its exports by their own names
import "people" as p               # or kept under a name: p.full_name(…), p.person
```

A library has no header and holds only imports and declarations; `export` makes a declaration visible to the
files that import it. Libraries may not import each other in a circle. The standard library is there in every file
without an `import`. Declarations may be used before the line they stand on (§5.7).

Whitespace and line breaks are free between tokens, except that a line break before `[` or `(` ends the
expression before it, and a `return`'s value is on its line (§1.4); `#` starts a comment to the end of the line.
Names are ASCII: a letter or `_`, then letters, digits and `_` (`name`, `maxRows`, `LIMIT`)
(§2.1). Keywords cannot be names (§2.3): `and as ask break check collect const continue default else
enum expect export false fill for form function if import in let match native new not null or pdf pick record
return tick true var while`. `list`, `map`, `set`, `fields`, `when`, `then`, `option`, `any`, `another`
and `faults` are words of the language only where the grammar uses them, and names everywhere else (§2.3.1).
A field's name may be any word, a keyword among them: `r.default` (§2.3.2).

## Types

| Type | Values |
|---|---|
| `string` | words (a `long_text`, `phone` or `email` question's answer is a string too) |
| `number` | an exact decimal: at most 34 significant digits, below 10^34, a multiple of 10^-6176 (§3.3) |
| `date` | a day, 0001-01-01 to 9999-12-31 |
| `bool` | `true` or `false` |
| an option set's name | one of its options |
| `set<S>`, S an option set's name | several of its options (an `any_of` answer), always in the set's declared order (§3.8) |
| a record's name | a record of that type |
| `list<T>` | values of type T, as many as are added |
| `map<K, V>` | values of type V under keys of type K: `{"a": 1}`, `m["a"]`, `m["b"] = 2` (§3.10) |
| `function(T, …) -> R` | a function as a value: `function apply(f: function(number) -> number, n: number)` |

A function written in place, where a value goes: `function(n: number) -> number { return n * 2 }` (§9.11).

Numbers are exact: `0.1 + 0.2 == 0.3` is true; `+ - *` round to 34 digits only past them, and `/` rounds its
quotient to 34 digits, half to even (§3.3). A number has no exponent and no leading zero (`0755` is a mistake;
an id with leading zeros is words in quotes, §2.5).

Every value may also be null: no value, an answer not given yet. `null` is the null value of any type; `x ==
null` and `x != null` test it, and `x ?? y` gives y in its place (§3.2, §6.16). `""`, `[]` and `{}` are
values, not null. In a condition null counts as false; `"{x}"` and `fill` put in no characters for it; `==`
compares it. Anything else that needs a value — arithmetic, `< <= > >=`, joining with `+`, a field, an item, a
slice, `for`, a library function — stops the run when it is given null (fault F023, §6.3).

A list, a record or a map is shared: `var b = a` makes `b` the same list as `a`, and a function given a list
changes that list; `copy(a)` makes another (§3.4).

## Declarations

```
record representative {            # a record: named fields, each with its type
  name: string
  caf: string
  copies: bool
  changed: set<changes>
}

enum changes {                     # an option set: values, each with the words printed beside its box
  "address" "Check if new: Address"
  "fax" "Fax No."
}

const LIMIT = 4                    # worked out by the compiler: words, a number, a date, true or false, a list of them

function line_2(n: number, r: representative) {       # a function; `-> type` after the parameters
  fill "Page1[0].RepresentativesName{n}[0]" = r.name  # when it gives a value
}

function label(r: representative) -> string {
  return "{r.name} ({r.caf})"
}

function money(n: number, places: number = 2) -> string {  # a parameter may have a default, any expression,
  return grouped(n, places)                                # worked out at the call; defaults come last (§9.2)
}
```

A call gives its arguments by position, then by name: `money(total, places: 0)` (§9.4).

A function may be generic: `function first_of<t>(l: list<t>) -> t` takes a list of any type and gives one of
its items; each call works out what `t` is from its arguments (§9.5). A function that returns a value and does not write its result's
type has the join of its returns' types (§3.9, §9.6).

A function sees its parameters, its own names, its file's declarations, and the program's top-level names (an
answer, a let, a var); it may give the program's var a new value. A function may call itself. A function is a value too: its name can be passed,
kept and called through (§9.10).

`r.label()` calls `label(r)`: any function can be called on its first argument. A library kept under a name
lends its functions to such calls.

Only the standard library declares natives, functions the machine provides: `native function upper(t: string) ->
string`. A native's parameter may be `any`; its result may be `any` (the type of its first argument) or `element`
(the type of the items of the list given first).

## Statements

| Statement | Does |
|---|---|
| `ask name: type "printed words"` | asks a question; its answer is the value of `name` from here on |
| `ask r.field: type "…"` | the answer goes into a field of a var's record, or of a list's item |
| `… default e` | the value the answer has until the person answers; once they answer, even with nothing, it does not come back (§8.4.1) |
| `… check c "message"` | a condition the answer should meet; when it does not, the page shows the message (the answer stays); a null answer is not checked |
| `let name = e`, `let name: type = e` | a name that keeps the value it is given; the items and fields of a list, record or map it holds may be given values (§3.4) |
| `var name = e`, `var name: type`, `var name: type = e` | a name for a value that may change; without a value, a list starts with no items, a map with no keys and a record null; anything else must be given a value before it is read |
| `name = e`, `name.field = e`, `name[i] = e` | gives a var a new value; gives a field or an item of the record, list or map a name holds a new value (§7.5) |
| `x += e`, `-=`, `*=`, `/=` | `x = x + e`, with x's place worked out once (§7.5); `l += m` adds m's items to the list l holds |
| `fill "box" = e` | writes words, a number, a date or an option into a text box or a list box |
| `tick "box" when c` | ticks a check box (with the box's own export value) when the condition is true |
| `pick "group" "button" when c` | picks that button of a radio group when the condition is true |
| `const b = "box"`, then `fill b = e` | a box named once: where words in quotes go (a box's name, a question's words), an expression that starts with a name goes too (§7.9) |
| `if c { } else if c { } else { }` | one branch |
| `match e { "a", "b" => { } else => { } }` | one branch by an option's value, by words, or by a number (`1, 2 => { }`) |
| `for i in a..b { }`, `for i in a..<b { }` | its block for each whole number from a to b, or with `..<` to before b; a and b worked out once (§7.11) |
| `for x in list { }`, `for n, x in list { }` | its block for each item of a list or option of a set, n counting from 0 |
| `while c { }` | its block as long as the condition is true (§7.11.1) |
| `try { } catch problem { }` | a fault in the try runs the catch, its message in `problem` (§7.18) |
| `break`, `continue` | end the innermost `for` or `while`, or go to its next turn; not in a collect (§7.12) |
| `collect x in list "Add another…?" { }`, `collect n, x in list any "Any…?" another "Another…?" { }` | asks for the items of a list one at a time (below) |
| `return`, `return e` | ends a function (with its value), or the program |
| `f(…)` | calls a function for what it does |
| `expect e "words"`, `expect e faults "F001"` | test files only: e must be true, or working out e must give that fault (§7.17) |

Question types: `string`, `long_text`, `number`, `date`, `phone`, `email`, `bool`, `one_of S`, `any_of S` (S
an option set), and `one_of` / `any_of` with their own options:

```
ask kind: one_of "Kind of taxpayer" {
  option "individual" "Individual"
  option "business" "Business"
}
```

An `if` and a `match` are not scopes: a question asked in a branch is known after it, and null when that branch
did not run. A `let` or `var` declared in a branch may be read after it only where every path has declared it
(§12.1.1). Loops, collects, comprehensions and functions are scopes. A name is used only after the statement
that defines it; the same name is not defined twice in one function or program.

### Lists and collect

```
var representatives: list<representative>
collect n, r in representatives "Add another representative?" {
  ask r.name: string "Name and address"
  if n < 2 {
    ask r.copies: bool "Check if to be sent copies of notices and communications"
  }
}
for n, r in representatives {
  fill "Page1[0].RepresentativesName{n + 1}[0]" = r.name
}
```

`collect` asks the first item (n is 0), then the quoted bool question; true asks the next item, and false ends it. An item
enters the list when its block ends (§8.5.1). A list that may hold no items (trips abroad, arrests) asks first
whether there are any:

```
collect t in trips any "Did you take any trips outside the United States?" another "Did you take another trip?" {
  …
}
```

False leaves the list with no items. The collect's own questions have the keys `trips#any` and `trips[n]#another`, with
the turns of any loops around the collect after them: `trips#any[2]` (§8.6.2). The items are answers: a program
cannot change them. A list is collected once, into a var declared as a list of records or plain values, with no items.

## Expressions

Loosest first (§6.1): `if c then a else b`; `??`; `or`; `and`; `not`; comparisons `== != < <= > >=`, `in`, `not in`,
`== null`, `!= null` (they do not chain); `+ -`; `* / // %`; unary `-`; then `.field`, `[n]` (from 0),
`[a..b]`, `[a..<b]` and calls; then values: numbers, `"words"`, `true`, `false`, `null`, names, `[a, b]`,
`[e for x in l if c]`, `new record { field: e, … }`, `( … )`.

- `+` adds numbers, joins words, or joins two lists (§6.5.1); `- * / // %` are for
  numbers. `//` is floor division and `%` its remainder, both exact (§6.4.1). Dividing by zero is a fault.
- `< <= > >=` compare two numbers, two dates, or two words by code points (§6.7).
- `==` and `!=` compare values of one type; an option is compared with one of its own values, checked.
- `"x" in s` asks whether an option is among those of a set of options, or a value among a list's items.
- `and` and `or` decide on the left when they can; the right is then not worked out. They always give true or false.
- `a ?? b` is a when a is not null, else b; b is worked out only then. It chains from the left, and its type is
  the join of a's and b's (§6.16): `fill "Total" = amount ?? 0`, `upper(name ?? "")`.
- `if c then a else b` works out only the chosen value; its type is the join of a's and b's (§6.13).
- `l[n]` is the item at position n, the first at 0; a position outside the list is a fault (§6.9.2). `l[a..b]`
  is the items a to b, and `l[a..<b]` the items a to before b (§6.9.3). `[r.name for r in reps if r.copies]` makes a list (§6.12).
- `"Line {n + 1}"` puts any value's words into words. `\"`, `\\`, `\{`, `\}`, `\n`, `\t` and `\u{h…}` stand
  for themselves (§2.6).

## What is worked out when

A box's name, a button's name, a question's printed words and a loop's bounds are ordinary
expressions, worked out as the program runs (§11.2). The compiler works out only a constant's value, a parameter's
default and an option's printed words.

Loops, collects and calls run in the machine as they are written. A question's key is worked out
as it runs, from where it is asked (§8.6): its name, with the turn of each loop it is in (`other_act[1]`), on the
item of a list it answers (`representatives[0].name` for the first), or after the call it is in (`line_2.name`; a second call is `line_2#2.name`).

## The standard library

`lib/std.stride`, there in every file; §14 gives every signature; a function given null where it needs a value is fault F023 (§14.0.3). Words: `upper
lower title capitalize trim trim_start trim_end remove_prefix remove_suffix length chars character slice digits
letters is_digits is_letters replace contains starts_with ends_with find occurrences split line line_count
rest_lines word word_count pad_left string_of number_of`. Numbers: `round ceil floor whole abs power min max grouped
fixed divide remainder`. Dates: `today date_of year month day format days_between years_between add_days add_months`.
Lists and sets: `count join first last filled index_of append insert remove_at clear copy without reversed sorted sum
smallest largest any all union intersection difference`; `append`, `insert`, `remove_at` and `clear` change the list
they are given, the others give a new one. Null, faults and output: `either fail print`.

`chars(t, from, to)` and `character(t, n)` leave out spaces, dashes, slashes and dots: one answer over a row of
one-character boxes. Their positions count from 0, as a list's do, and `find` and `index_of` give -1 for none. `format(d, "MM/DD/YYYY")` writes a date the way a box asks (any of `YYYY YY MM DD M D`).
`contains`, `starts_with`, `ends_with` and `find` compare words as written; `lower` first to ignore case.

## What the compiler refuses

Every mistake comes with its file, line and column, a code (`S318`), a message in plain words, and the source
line with a caret under the place; `stride explain S318` says more (§16.2). A phase runs only when those before
it found none. Each phase records every mistake it finds; the parser goes on after a syntax mistake and stops
after twenty; the command line shows the first twenty and counts the rest (§16.1).

- **Syntax:** anything the grammar does not allow.
- **Libraries:** a library that is not there, libraries that import each other in a circle, two libraries
  exporting one name to the same file, a statement in a library.
- **Names:** a name not defined (with the nearest one as a hint), used before the line that defines it, defined
  twice; a type that is not one; a record that holds itself.
- **Types:** an operator on values it does not take; an option compared with a value it does not have; a call
  with the wrong number or types of arguments; a function giving a value of the wrong type, or none where it
  must; an answer, a let, a constant, a parameter or a counter given a new value; a list collected twice, or not
  into a var; a box filled with bool, a set, a list or a record.
- **Flow:** a let
  or var read where not every path has given it a value; a function with a result that does not return one on
  every path; a statement after a return, break or continue; a constant's value or a default that faults, such as `const X = 1 / 0` (§11.3).
- **The form** (against the header): a box written out that the PDF does not have (with the nearest one); a
  statement of the wrong kind for its box; a button a radio group does not have; a list box filled with an entry,
  written out, that it does not have; a program written for another PDF.

Limits (§15): nesting 200 deep, 255 arguments or parameters, numbers of 34 significant digits.

Warnings do not stop the compiler: a match with no else that misses options; a function, a constant, an answer,
a let or a var never used; a field asked and never read. Stride is no stricter than the form (§10.4).

## The compiler

`src/`, one module per phase: `parse` (the hand-written lexer and recursive-descent parser in
`syntax.mjs`, which recovers after a mistake and reports up to twenty), `load` (libraries),
`resolve` (names, scopes), `check` (types), `flow`, `lower` (to the intermediate form: functions of basic
blocks; question keys, printed words and box names as expressions worked out as the program runs), `form`
(the boxes a program names, looked up in the form's header), and `codegen` (an instruction list, then the
assembler).

## Bytecode

Version 9 (§18, `runtime/bytecode.mjs`). A file is `STRD`, the version byte, then sections, each a tag,
its length and its bytes, so a reader skips a section it does not know, and refuses one that holds more or fewer
bytes than it says: texts, numbers (as their words, never a binary float), the program (form, PDF, prefix),
boxes (name, how written, export value), records, questions (name, type, option set, options, flags, line),
natives, functions (name, parameters, locals' names, code range), code, places (the line and column of
each instruction that can fault or ask), links (for each question whose key is written out: the boxes its answer goes into). Integers are LEB128 varints; jump
addresses 4 bytes.

Loading verifies a program before it runs: every instruction known and complete, every operand in range (a
native given as many values as it takes), every jump onto an instruction of its own function (forward; `LOOP`
backward), every function ending, and the stack's height the same wherever paths meet, never below what an
instruction takes, and nothing left at a return.

## The machine

`runtime/vm.mjs`: a stack machine with call frames. `run(program, answers)` gives the questions the
run reaches, in order (each with its key, printed words, value, default, failed checks, and whether the answer
given was unreadable and why), what goes into each box, the words given to `print`, and a fault or none (§13.1).
It reaches nothing outside: no network, no storage, no page. A fault stops the run, nothing it wrote counts, and
it is shown with its code, message and place and the calls that led there (§13.4, §16.3); a run stops at
calls 10,000 deep (F015), and at the host's limit of instructions when it sets one (F014). The page runs the program again after every answer; a
box the run does not write is emptied.

| Instructions | Do |
|---|---|
| `TEXT NUMBER TRUE FALSE NULL` | push a constant |
| `LOAD STORE POP DUP` | locals and the stack |
| `NEW_RECORD GET_FIELD SET_FIELD ENSURE_RECORD ENSURE_FIELD ENSURE_ITEM` | records |
| `NEW_LIST GET_ITEM GET_ITEM_THERE SET_ITEM CHECK_SLOT APPEND SLICE` | lists |
| `ADD SUB MUL DIV FLOOR_DIV MOD EQ NE LT LE GT GE IN NOT_IN NEG NOT TO_BOOL CONCAT KEY` | operators |
| `JUMP JUMP_IF_FALSE JUMP_IF_TRUE LOOP` | jumps (`LOOP` back to a counted loop's head) |
| `CALL RETURN RETURN_NONE NATIVE HALT` | calls |
| `ASK ASK_DEFAULT CHECK_FAILED` | questions (the key and printed words from the stack) |
| `FILL TICK PICK` | boxes named by known words |
| `FILL_AT TICK_AT PICK_AT` | boxes named as the program runs |
| `EXPECT EXPECT_DONE` | a test file's expectations |

## Command line

`stride`, one executable: `npm run build` builds it (`scripts/build.mjs`: the command line, compiler,
machine and standard library bundled with Node inside);
`sh scripts/install.sh` installs it. Every command is in §17.

- `stride compile <file.stride> [-o <file.sbc>] [--json]` compiles to bytecode; `--json` gives the mistakes in
  one JSON document.
- `stride check <file.stride> [--json]` runs every check and writes nothing.
- `stride run <file.stride|.sbc> [answers.json] [--trace] [--today D]` runs with answers (`{ "key": answer }`)
  and prints the questions asked, the boxes written, what `print` gave and a fault; `--trace` each instruction.
- `stride test <file.stride> [name …]` runs the tests in `<file>.tests/`: each `{ "answers", "boxes",
  "asked", "unasked", "loose" }`; every box the test does not list must be empty unless it is loose. `stride test <name>.test.stride` runs a
  test file's `expect`s.
- `stride eval "<expression>" [--use lib]` prints the value of one expression.
- `stride explain <code>` explains a mistake's or a fault's code.
- `stride asm <file> [--ir]` prints the instructions with their source lines, or the intermediate form.
- `stride fmt <file.stride> … [--check]` puts files in Stride's one layout, comments kept.
- `stride version`.
