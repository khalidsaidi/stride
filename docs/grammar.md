# Stride reference manual

Stride is the language a form's workflow is written in. A program says which questions a form needs, in what
order and under what conditions, and what each answer writes into the issuer's own PDF boxes. How the
questions are shown, in which human language, and how a person moves between them belong to the page that runs
the program (`runtime/runner.js`), not to the language.

This is the short guide. The definition is `spec.md`: where the two differ, the spec is right, and each rule
here names its section (§x.y).

One program per form, `<form>.stride`, written against one exact PDF. Beside it:

- `<form>.boxes.json`, the header: the PDF's boxes, as the PDF gives them, written by
  `stride header <form>.pdf`; and, where whoever prepared the form added them, the words printed beside each. A program is checked against it, as a C program is against its headers.
- `<form>.tests/*.json`: the program's tests.

Libraries are in `lib/`; the standard library is `lib/std.stride`. A test file `<name>.test.stride`
stands beside a library and holds `use`, declarations, `let` and `expect` (§4.3). The grammar is at the top of
`src/syntax.mjs`, the hand-written lexer and parser that read it.

## Files

A program starts with its header, then holds imports, declarations and statements in any order (§4):

```
form irs-2848                      # the form's id
pdf 14377021f958…                  # the sha256 of the PDF it is written against (64 hex digits, small letters)
fields "topmostSubform[0]."        # optional: put before every box name below
use "people"                       # a library from lib/people.stride, its exports by their own names
use "people" as p                  # or kept under a name: p.full_name(…), p.person
```

A library has no header and holds only imports and declarations; `export` makes a declaration visible to the
files that use it. Libraries may not use each other in a circle. The standard library is used by every file
without a `use`. Declarations may be used before the line they stand on (§5.7).

Whitespace and line breaks are free between tokens, except that a line break before `[` or `(` ends the
expression before it, and a `return`'s value is on its line (§1.4); `#` starts a comment to the end of the line.
Names are ASCII: a letter or `_`, then letters, digits and `_` (`name`, `maxRows`, `MOST`)
(§2.1). Keywords cannot be names (§2.3): `and as ask because break check collect const continue default define
each else empty export expect fields fill for form if in is let list match most native new no not of options or
pdf pick record return set skip then tick use var when yes`. `option`, `any`, `another` and `faults` are keywords
only where the grammar uses them (§2.3.1).

## Types

| Type | Values |
|---|---|
| `text`, `long-text`, `phone`, `email` | words; the last three are text with a shape, and fit wherever text does |
| `number` | an exact decimal: at most 34 significant digits, below 10^34, a multiple of 10^-6176 (§3.3) |
| `date` | a day, 0001-01-01 to 9999-12-31 |
| `yes-no` | `yes` or `no` |
| an option set's name | one of its options |
| `set of` an option set's name | several of its options (an `any-of` answer), always in the set's declared order (§3.8) |
| a record's name | a record of that type |
| `list of T most N` | up to N values of type T; N a whole number 1–1000 known before the form opens (a parameter may leave out `most N`: any length) |

Numbers are exact: `0.1 + 0.2 == 0.3` is yes; `+ - *` round to 34 digits only past them, and `/` rounds its
quotient to 34 digits, half to even (§3.3). A number has no exponent and no leading zero (`0755` is a mistake;
an id with leading zeros is words in quotes, §2.5).

Every value may also be empty: an answer not given yet. `empty` is the empty value of any type; `x is empty`
and `x is not empty` test it (§3.2). In a condition an empty yes-no counts as no; `< <= > >=` with an empty
value is no; words joined with an empty value are the other words; a number added to an empty value is the
number; `- * / // %` with an empty value give empty (§6.3).

A list or a record is a value, not a place: `var b = a` copies, and a function given a list changes only its
copy (§3.4).

## Declarations

```
record representative {            # a record: named fields, each with its type
  name: text
  caf: text
  copies: yes-no
  changed: set of changes
}

options changes {                  # an option set: values, each with the words printed beside its box
  "address" "Check if new: Address"
  "fax" "Fax No."
}

const MOST = 4                     # known before the form opens: words, a number, a date, yes or no

define line_2(n: number, r: representative) {        # a function; `-> type` after the parameters
  fill "Page1[0].RepresentativesName{n}[0]" = r.name  # when it gives a value
}

define label(r: representative) -> text {
  return "{r.name} ({r.caf})"
}

define money(n: number, places: number = 2) -> text {  # a parameter may have a default, known before the
  return grouped(n, places)                            # form opens; defaults come last (§9.2)
}
```

A call gives its arguments by position, then by name: `money(total, places: 0)` (§9.4).

A function may be generic: `define first_of<t>(l: list of t) -> t` takes a list of any type and gives one of
its items; each call works out what `t` is from its arguments (§9.5). A parameter's list may leave out its most
(`list of t`): it takes a list of any length. A function that returns a value and does not write its result's
type has the join of its returns' types (§3.9, §9.6); when that is a list whose most is not known, it must write
its result type (§9.5.2).

A function sees its parameters, its own names, and its file's declarations; it does not see the program's
answers: what it needs is passed. A function may not call itself, directly or through others, so every program
ends. A function that asks a question, writes a box, collects a list, calls `today`, `print` or `fail`, or calls
a function that does, has effects; any other is pure (§9.9).

`r.label()` calls `label(r)`: any function can be called on its first argument. A library kept under a name
lends its functions to such calls.

Only the standard library declares natives, functions the machine provides: `native define upper(t: text) ->
text`. A native's parameter may be `any`; its result may be `any` (the type of its first argument) or `element`
(the type of the items of the list given first).

## Statements

| Statement | Does |
|---|---|
| `ask name: type "printed words"` | asks a question; its answer is the value of `name` from here on |
| `ask r.field: type "…"` | the answer goes into a field of a var's record, or of a list's item |
| `… default e` | the value the answer has until the person answers; once they answer, even with nothing, it does not come back (§8.4.1) |
| `… check c "message"` | a condition the answer should meet; when it does not, the page shows the message (the answer stays); an empty answer is not checked |
| `let name = e`, `let name: type = e` | a name for a value that does not change |
| `var name = e`, `var name: type`, `var name: type = e` | a name for a value that may change; without a value, a list or record starts empty, anything else must be given a value before it is read |
| `name = e`, `name.field = e`, `name[i] = e` | gives a var, its field or its item a new value |
| `x += e`, `-=`, `*=`, `/=` | `x = x + e`, with x's place worked out once (§7.5) |
| `fill "box" = e` | writes words, a number, a date or an option into a text box or a list box |
| `tick "box" when c` | ticks a check box (with the box's own export value) when the condition is yes |
| `pick "group" "button" when c` | picks that button of a radio group when the condition is yes |
| `skip "box" because "reason"` | a box the workflow leaves alone, and why |
| `const b = "box"`, then `fill b = e` | a box named once: where words in quotes must be known (a box's name, a question's words, a reason), a constant that holds them goes too (§7.9.1) |
| `if c { } else if c { } else { }` | one branch |
| `match e { "a", "b" => { } else => { } }` | one branch by an option's value (or words) |
| `for i in a..b { }` | its block for each whole number from a to b; a and b worked out once (§7.11) |
| `for each x in list { }`, `for each n, x in list { }` | its block for each item of a list or option of a set, n counting from 1 |
| `break`, `continue` | end the innermost `for` or `for each`, or go to its next turn; not in a collect (§7.12) |
| `collect x in list "Add another…?" { }`, `collect n, x in list any "Any…?" another "Another…?" { }` | asks for the items of a list one at a time (below) |
| `return`, `return e` | ends a function (with its value), or the program |
| `f(…)` | calls a function for what it does |
| `expect e "words"`, `expect e faults "F001"` | test files only: e must be yes, or working out e must give that fault (§7.17) |

Question types: `text`, `long-text`, `number`, `date`, `phone`, `email`, `yes-no`, `one-of S`, `any-of S` (S
an option set), and `one-of` / `any-of` with their own options:

```
ask kind: one-of "Kind of taxpayer" {
  option "individual" "Individual"
  option "business" "Business"
}
```

An `if` and a `match` are not scopes: a question asked in a branch is known after it, and empty when that branch
did not run. A `let` or `var` declared in a branch may be read after it only where every path has declared it
(§12.1.1). Loops, collects, comprehensions and functions are scopes. A name is used only after the statement
that defines it; the same name is not defined twice in one function or program.

### Lists and collect

```
var representatives: list of representative most 4
collect n, r in representatives "Add another representative?" {
  ask r.name: text "Name and address"
  if n <= 2 {
    ask r.copies: yes-no "Check if to be sent copies of notices and communications"
  }
}
for each n, r in representatives {
  fill "Page1[0].RepresentativesName{n}[0]" = r.name
}
```

`collect` asks the first item, then the quoted yes-no question; a yes asks the next item, up to the list's
most, where it stops without asking (Docassemble's gathering loop, bounded by the rows the PDF has). An item
enters the list when its block ends (§8.5.1). A list that may stay empty (trips abroad, arrests) asks first
whether there are any:

```
collect t in trips any "Did you take any trips outside the United States?" another "Did you take another trip?" {
  …
}
```

A no leaves the list empty. The collect's own questions have the keys `trips#any` and `trips[n]#another`, with
the turns of any loops around the collect after them: `trips#any[2]` (§8.6.2). The items are answers: a program
cannot change them. A list is collected once, into a var declared as an empty list of records or plain values.

## Expressions

Loosest first (§6.1): `if c then a else b`; `or`; `and`; `not`; comparisons `== != < <= > >=`, `in`, `not in`,
`is empty`, `is not empty` (they do not chain); `+ -`; `* / // %`; unary `-`; then `.field`, `[n]` (from 1),
`[a..b]` and calls; then values: numbers, `"words"`, `yes`, `no`, `empty`, names, `[a, b]`,
`[e for each x in l if c]`, `new record { field: e, … }`, `( … )`.

- `+` adds numbers, joins words, or joins two lists (the most is the sum, §6.5.1); `- * / // %` are for
  numbers. `//` is floor division and `%` its remainder, both exact (§6.4.1). Dividing by zero is a fault.
- `< <= > >=` compare two numbers, two dates, or two words by code points (§6.7).
- `==` and `!=` compare values of one type; an option is compared with one of its own values, checked.
- `"x" in s` asks whether an option is among those of a set of options, or a value among a list's items.
- `and` and `or` decide on the left when they can; the right is then not worked out. They always give yes or no.
- `if c then a else b` works out only the chosen value; its type is the join of a's and b's (§6.13).
- `l[a..b]` is the items a to b (§6.9.3). `[r.name for each r in reps if r.copies]` makes a list; it may not
  ask, write boxes or collect (§6.12).
- `"Line {n + 1}"` puts any value's words into words. `\"`, `\\`, `\{`, `\}`, `\n`, `\t` and `\u{h…}` stand
  for themselves (§2.6).

## Known before the form opens

A box's name, a button's name, a question's printed words, an option's printed words, the quoted questions of a
collect, a skip's reason, a list's most, a constant's value, a parameter's default, and the bounds of a loop
that asks or writes boxes must be known before the form opens (§11.2): made of words and numbers, `yes`, `no`,
`empty`, constants, the counters of such loops, the numbers of a collect's or a for each's items, lets made of
them, pure natives of them, list literals of them, and parameters every call gives a known value. A parameter
used where a known value is needed becomes such a parameter; every call must then give it one, the same in every
turn of a loop that does not count it.

Loops, collects, for eaches and calls run in the machine as they are written. A question's key is worked out
as it runs, from where it is asked (§8.6): its name, with the turn of each loop it is in (`other_act[1]`), on the
item of a list it answers (`representatives[2].name`), or after the call it is in (`line_2(n=2).name`, the
call's key holding, by name, the parameters that name boxes or questions).

The PDF check follows the program on every path with every answer unknown, working out exactly what does not
depend on an answer (a counter, a list's length in each turn, a call's arguments), so it knows each box name and
question key where it is used.

## The standard library

`lib/std.stride`, used by every file; §14 gives every signature and what each does with empty. Words: `upper
lower title capitalize trim trim_start trim_end remove_prefix remove_suffix length chars character slice digits
letters is_digits is_letters replace contains starts_with ends_with find occurrences split line line_count
rest_lines word word_count pad_left text_of number_of`. Numbers: `round ceil floor whole abs min max grouped
fixed divide remainder`. Dates: `today date_of year month day format days_between years_between add_days`.
Lists and sets: `count join first last filled index_of append without reversed sorted sum smallest largest any all union
intersection difference`. Empty, faults and output: `either fail print`.

`chars(t, from, to)` and `character(t, n)` leave out spaces, dashes, slashes and dots: one answer over a row of
one-character boxes. `format(d, "MM/DD/YYYY")` writes a date the way a box asks (any of `YYYY YY MM DD M D`).
`contains`, `starts_with`, `ends_with` and `find` ignore case.

## What the compiler refuses

Every mistake comes with its file, line and column, a code (`S318`), a message in plain words, and the source
line with a caret under the place; `stride explain S318` says more (§16.2). A phase runs only when those before
it found none. Each phase records every mistake it finds; the parser goes on after a syntax mistake and stops
after twenty; the command line shows the first twenty and counts the rest (§16.1).

- **Syntax:** anything the grammar does not allow.
- **Libraries:** a library that is not there, libraries that use each other in a circle, two libraries
  exporting one name to the same file, a statement in a library.
- **Names:** a name not defined (with the nearest one as a hint), used before the line that defines it, defined
  twice; a type that is not one; a record that holds itself.
- **Types:** an operator on values it does not take; an option compared with a value it does not have; a call
  with the wrong number or types of arguments; a function giving a value of the wrong type, or none where it
  must; an answer, a let, a constant, a parameter or a counter given a new value; a list collected twice, or not
  into a var; a box filled with yes-no, a set, a list or a record.
- **Flow:** a function that reaches itself; something that must be known before the form opens and is not; a let
  or var read where not every path has given it a value; a function with a result that does not return one on
  every path; a statement after a return, break or continue; a constant's value or a default that faults, such as `const X = 1 / 0` (§11.3).
- **The PDF** (against the header): a box the PDF does not have (with the nearest one); a statement of the wrong
  kind for its box; a button a radio group does not have; a question asked twice on one
  path through the program; a question's printed words not among those
  the header lists beside the boxes its answer goes into; an option's not among those beside the box it ticks or picks; a list box filled
  with an entry it does not have; a program written for another PDF.

Limits (§15): nesting 200 deep, 255 arguments or parameters, a list's most 1000, 1 to 1000 options in a set,
words of 100,000 characters, numbers of 34 significant digits.

Warnings do not stop the compiler: a match with no else that misses options; a function, a constant, an answer,
a let or a var never used; a field asked and never read; a box written twice on one path; a box the program
neither writes nor skips. Stride is no stricter than the form (§10.4).

## The compiler

`src/`, one module per phase: `parse` (the hand-written lexer and recursive-descent parser in
`syntax.mjs`, which recovers after a mistake and reports up to twenty), `load` (libraries),
`resolve` (names, scopes), `check` (types), `flow`, `lower` (to the intermediate form: functions of basic
blocks; question keys, printed words and box names as expressions worked out as the program runs), `pdf`
(the check against the header: an abstract interpretation over every path, answers unknown and everything else
worked out, paths with the same known live values taken together, functions followed from each call), and
`codegen` (an instruction list, a peephole pass, then the assembler).

## Bytecode

Version 3 (§18, `runtime/bytecode.mjs`). A file is `STRD`, the version byte, then sections, each a tag,
its length and its bytes, so a reader skips a section it does not know, and refuses one that holds more or fewer
bytes than it says: texts, numbers (as their words, never a binary float), the program (form, PDF, prefix),
boxes (name, how written, export value), records, questions (name, type, option set, options, flags, line),
natives, functions (name, parameters, locals' names, code range, pure), code, places (the line and column of
each instruction that can fault or ask), resources (named blobs kept for the host: the page's words), links (for
each question key the PDF check found: the boxes its answer goes into). Integers are LEB128 varints; jump
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
2,000,000 instructions (F014) or calls 200 deep (F015). The page runs the program again after every answer; a
box the run does not write is emptied.

| Instructions | Do |
|---|---|
| `TEXT NUMBER TRUE FALSE EMPTY` | push a constant |
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
  "asked", "unasked", "loose" }`; every box the test does not list must be empty unless it is loose. Each test
  runs in the machine and in the intermediate form, and they must agree. `stride test <name>.test.stride` runs a
  test file's `expect`s.
- `stride eval "<expression>" [--use lib]` prints the value of one expression.
- `stride explain <code>` explains a mistake's or a fault's code.
- `stride asm <file> [--ir]` prints the instructions with their source lines, or the intermediate form.
- `stride fmt <file.stride> … [--check]` puts files in Stride's one layout, comments kept.
- `stride version`.
