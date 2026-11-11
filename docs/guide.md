# Writing Stride

Stride is a language for a form's workflow: the questions a form's page asks, one at a time,
and which boxes of the issuer's PDF each answer fills. This guide is for someone writing those programs. The
specification, `spec.md`, is the authority on what every construct means; this guide says how to use them and
points to it (`§6.2` is section 6.2 of `spec.md`). Every example below is run by Stride's own test suite, so what
it shows is what Stride does. It is built into the tools: `stride guide` shows it, `stride guide topics` lists its
parts, and `stride guide coming-from` is the short version for someone who knows Go, Java, JavaScript or Python.

## 1. Write and run

`stride` is one command (section 23 says how to install it). Save this as `hello.stride`:

```stride
print("Hello, world")
```
```output
Hello, world
```

and run it with `stride run hello.stride`. A file that does not start with a `form` line is a *script* (§4.6): it
runs on its own and fills no form. Everything in sections 3 to 9 works in a script. What it prints goes to stdout,
and nothing else does: mistakes, warnings and faults go to stderr, so `stride run hello.stride > out.txt` holds
exactly its lines (§17.11).

A program takes its input by asking: it never reads files or its command line. `stride run` answers its questions
in whichever of these ways suits (§17.12):

| | |
|---|---|
| `stride run greet.stride` at a terminal | each question is asked there as the run reaches it; an empty line leaves it unanswered |
| `stride run greet.stride name=Ada born=1815-12-10` | answers as arguments, question key = answer; an any-of answer's options with commas, `likes=red,blue` |
| `stride run greet.stride answers.json` | a JSON object, question key to answer |
| `cat answers.json \| stride run greet.stride -` | the same object on stdin |
| `printf 'Ada\n1815-12-10\n' \| stride run greet.stride --prompt` | the questions asked in turn, the answers read from stdin |
| `echo 'print(1 + 1)' \| stride run -` | a script read from stdin |

```stride answers={"name":"Ada","born":"1815-12-10"}
ask name: text "Your name"
ask born: date "Date of birth"
print("Hello, {either(name, "there")}")
print("You were born in {year(born)}.")
```
```output
Hello, Ada
You were born in 1815.
```

To try things, `stride repl` keeps what you type: declarations and statements are kept and run, an expression shows
its value, and a question is asked as it comes (§17.14). `stride eval "expression"` works out one expression.

```
$ stride repl
stride> let names = ["Ada", "Bo"]
stride> names[1]
Ada
stride> define twice(n: number) -> number {
   ...>   return n * 2
   ...> }
stride> twice(21)
42
```

## 2. A first form

A program that fills a form starts with the form's id and the sha256 of its PDF, and is checked against the form's
*header*: every box of the PDF and its kind, as the PDF itself gives them. `stride new` makes it from the PDF:

```
stride new consent --pdf consent.pdf
```

writes `consent.boxes.json` (the header), `consent.stride` and a test in `consent.tests/`. The program it writes
asks one question for the first text box, named after the box, and lists every other box in a comment. A PDF does not say which
printed words stand beside which box: you read the form and write them. `stride run consent.stride` shows the form with
each box's name on it, so you see which box is which; the compiled workflow (`stride run consent.sbc`) does not. For a PDF with a box "name" beside the
words "Full name" and a check box "agree" beside "I agree to the terms", the program, with the form's words put in,
is:

```stride form
form consent
pdf 40b82a8804e4bc4b946750dd7b2aca7bdccc4c14fbeb48ada3d91f8c6a125c76

ask full_name: text "Full name"
fill "name" = full_name

# tick "agree" when …
```

It compiles as it is. Under it, the starting file lists every other box of the form in a comment, with the
statement that writes it; write those you need. A box the program never mentions stays empty, as on the form.

```stride form
form consent
pdf 40b82a8804e4bc4b946750dd7b2aca7bdccc4c14fbeb48ada3d91f8c6a125c76

ask full_name: text "Full name"
fill "name" = full_name
ask agrees: yes-no "I agree to the terms"
tick "agree" when agrees
```

A PDF's own names for its boxes are often a machine's (`topmostSubform[0].Page1[0].f1_05[0]`). Give such a box
a name of your own once, as a constant, and use that name wherever the box goes (§7.9):

```
const exempt_code_box = "f1_05[0]"
fill exempt_code_box = exempt_code
```

Then the one path from here to a workflow someone fills:

1. **The form's header**, which `stride new` wrote from the PDF (`consent.boxes.json`): every box and its kind. The
   program is checked against it.
2. **The source**, `consent.stride`, edited as above.
3. **The workflow in your browser**: `stride run consent.stride` checks and compiles the program, opens the
   workflow beside its PDF, and asks its questions one at a time, each answer going into its boxes; the filled PDF
   downloads from the page. Nothing needs answering beforehand. Save the source and reload the page to see a
   change; a mistake shows in the page, at its place, instead of a broken workflow.
4. **Tests**: `stride test consent.stride` runs the program on the sample answers in `consent.tests/` and compares
   the boxes it writes (§13).
5. **The compiled workflow**: `stride compile consent.stride` writes `consent.sbc`, the whole program with all it
   needs but the PDF. `stride run consent.sbc`, with `consent.pdf` beside it, opens the same workflow, with no
   source, library or header (§21).

`stride run consent.stride --terminal` runs it in the terminal instead, with answers given as for a script (§1):
`stride run consent.stride --terminal full_name=Ada agrees=yes` says the questions asked and the boxes written. `stride
check` checks without running, and `stride map consent.stride` says which boxes each question fills; `run` and
`compile` make every check themselves.

`stride header form.pdf` writes a header again, for a new edition of the PDF.

## 3. Values and types

| Type | Values | Written |
|---|---|---|
| `text` | words | `"words"`, `"Line {n}"` |
| `number` | an exact decimal: `0.1 + 0.2` is `0.3` | `12`, `1.5` |
| `date` | a day, 0001-01-01 to 9999-12-31 | `date_of(2026, 7, 4)`, `today()` |
| `yes-no` | `yes`, `no` | |
| an option set | one of its options | `"red"` where one is expected |
| `set of` an option set | some of its options | `["red", "blue"]` where one is expected |
| a record | a value for each of its fields | `new person { name: "Bo" }` |
| `list of T` | any number of items | `[1, 2, 3]` |

Every type also has **empty**: the value of a question not answered, a field not set, an item past the end of a
list. Empty is never a mistake to hold; operations treat it so a form's empty boxes stay empty (§6.3): `+` gives
the other side, other arithmetic gives empty, an order comparison with empty is `no`, and empty counts as `no` in a
condition. Test for it with `is empty`, and replace it with `either`:

```stride
let price: number = empty
print(price + 5)
print(price * 2 is empty)
print(either(price, 0))
print(either("", "none given"))
```
```output
5
yes
0
none given
```

Numbers are exact decimals of up to 34 significant digits (§3.3), not binary floating point: `0.1 + 0.2` is `0.3`,
and `+`, `-` and `*` are exact while their result fits. A result that does not fit, and every `/` that does not come
out even, is rounded once to 34 significant digits, so `1 / 3 * 3` is not quite 1. `round`, `fixed` and `grouped`
say how many decimals to keep or show:

```stride
print(0.1 + 0.2)
print(10 / 4)
print(1 / 3)
print(1 / 3 * 3)
print(round(1 / 3 * 3, 2))
print(grouped(1234567.891, 2))
```
```output
0.3
2.5
0.3333333333333333333333333333333333
0.9999999999999999999999999999999999
1
1,234,567.89
```

## 4. Expressions

Arithmetic `+ - * / // %`, comparisons `== != < <= > >=`, `in` and `not in` for lists and sets, `is empty`, and
`and`, `or`, `not`. Operands are worked out left to right, and `and` and `or` stop as soon as the left side decides
(§6.2), so the right side of this `and` never divides by zero:

```stride
let n: number = 0
print(n != 0 and 10 / n > 1)
print(if n > 0 then "some" else "none")
print("{n} items")
```
```output
no
none
0 items
```

Comparisons do not chain: `a < b < c` is a mistake; write `a < b and b < c`.

## 5. Control flow

```stride
let ages = [12, 30, 67]
for each n, age in ages {
  if age < 18 {
    print("{n}: child")
  } else if age >= 65 {
    print("{n}: senior")
  } else {
    print("{n}: adult")
  }
}
for i in 1..10 {
  if i % 2 == 0 {
    continue
  }
  if i > 5 {
    break
  }
  print(i)
}
```
```output
1: child
2: adult
3: senior
1
3
5
```

`match` chooses by words, or by an option, and `return` ends a function, or the program:

```stride
define size(code: text) -> text {
  match code {
    "S", "M" => {
      return "small"
    }
    else => {
      return "large"
    }
  }
}
print(size("M"))
print(size("XL"))
```
```output
small
large
```

`while c { … }` runs its body as long as c is yes. A program that never ends runs until its host stops it;
calls deeper than 10,000 stop the run (F015).

## 6. Functions

```stride
define greeting(name: text, polite: yes-no = yes) -> text {
  if polite {
    return "Good morning, {name}."
  }
  return "Hi {name}"
}
print(greeting("Ada"))
print(greeting("Bo", polite: no))
```
```output
Good morning, Ada.
Hi Bo
```

A parameter may have a default; arguments are given in order, then by name. A function without `-> type` has its
result worked out from its returns. `define biggest<t>(l: list of t) -> t` is generic: `t` is worked out at each
call (§9.5). A value given to a function is a copy, so a function never changes what it was given (§3.4).
A function reads the program's own names (an answer, a let, a var), and may change its vars (§9.1).

## 7. Lists, records and sets

Lists count from 1. Reading past the items gives empty (a form's empty row); a position below 1 is a fault (§6.9.2). A list grows as items are added (`l += [x]`, `append(l, x)`).
Lists and records are values: `var b = a` copies, and `==` compares items:

```stride
options colour {
  "red" "Red"
  "green" "Green"
  "blue" "Blue"
}
record person {
  name: text
  age: number
}
var names: list of text = ["Ada", "Bo"]
var copy = names
copy[3] = "Cy"
print(names)
print(copy)
print(names[3] is empty)
print(names == ["Ada", "Bo"])
let p = new person { name: "Ada", age: 36 }
print(p.name)
let warm: set of colour = ["red", "green"]
print("green" in warm)
print([upper(x) for each x in copy if x != "Bo"])
```
```output
[Ada, Bo]
[Ada, Bo, Cy]
yes
yes
Ada
yes
[ADA, CY]
```

A map holds values under keys (§3.10). Reading a key it does not have gives empty:

```stride
var ages: map of text to number = {"Ann": 30, "Bo": 41}
ages["Cy"] = 25
ages["Ann"] = ages["Ann"] + 1
print(ages["Ann"])
print(ages["Zed"] is empty)
for each name, age in ages {
  print("{name}: {age}")
}
print(has(ages, "Bo"))
```
```output
31
yes
Ann: 31
Bo: 41
Cy: 25
yes
```

## 8. Functions as values

A function's name, where a value goes, is the function itself (§9.10): it can be given to another function, kept
in a `let`, and called through that name. Its type is written `function(number) -> number`.

```stride
define double(n: number) -> number {
  return n * 2
}
define apply(f: function(number) -> number, n: number) -> number {
  return f(n)
}
print(apply(double, 21))
let f = double
print(f(4))
```
```output
42
8
```

A function can be written where it is used, without a name (§9.11). It reads the names around it, and shares
the vars around it:

```stride
define adder(k: number) -> function(number) -> number {
  return function(n: number) -> number { return n + k }
}
let add5 = adder(5)
print(add5(1))
let less = function(n: number) -> number { return n - 1 }
print(less(10))
```
```output
6
9
```

For the common cases there are shorter ways: keeping some items or changing each is a comprehension
(`[upper(x) for each x in names if x is not empty]`), and ordering records is `sorted(l, by: "field")`.

## 9. Files and libraries

A library is a file in `lib/` beside the program, `lib/<name>.stride`, holding declarations; `export` makes one
visible to the files that use it:

```stride file=lib/money.stride
# lib/money.stride
export define dollars(n: number) -> text {
  return "${grouped(n, 2)}"
}
```

and `use "money"` in a program makes `dollars` its own; `use "money" as m` makes it `m.dollars`. A library may use
others, never in a circle. The standard library is used everywhere without a `use`.

## 10. The standard library

`stride doc` lists every function with its signature, what it gives and an example; `stride doc date` finds those
whose name or description holds the word. The tables are in §14.

```
$ stride doc pad
pad_left(t: text, width: number, padding: text = " ") -> text    14.1 Words
  padding put before t until it is width characters; t at least width long: t. …
  example: pad_left("7", 3, "0") gives 007
```

`stride eval 'pad_left("7", 3, "0")'` works out any one expression.

## 11. Mistakes and faults

A **mistake** is found by the compiler, before anything runs: it has a code, the place, and labels on the related
code; `stride explain W009` says what the code means and what to do. `--json` gives them all in the command's one JSON document (§16.2).

```stride form mistake=S508
form consent
pdf 40b82a8804e4bc4b946750dd7b2aca7bdccc4c14fbeb48ada3d91f8c6a125c76

ask full_name: text "Full name"
fill "nmae" = full_name
```

gives, from `stride check consent.stride`:

```
consent.stride:5:6: mistake S508: the PDF has no box "nmae"; did you mean name?
  5 | fill "nmae" = full_name
    |      ^^^^^^ the PDF has no box "nmae"
  stride explain S508
```

A **fault** happens as the program runs, on some answers: it stops the run and says where, and every call that led
there (§16.3), on stderr, with exit status 1:

```stride answers={"n":"0"}
define share(total: number, n: number) -> number {
  return total / n
}
ask n: number "How many people"
print(share(100, n))
```
```stderr
fault F001: division by zero
  at share, guide.stride:2:16
  called from main, guide.stride:5:7
```

A `try` catches a fault: the catch runs, with the fault's message, and the program goes on (§7.18).

```stride
define share(total: number, n: number) -> number {
  return total / n
}
try {
  print(share(100, 0))
} catch problem {
  print("could not share: {problem}")
}
print("still running")
```
```output
could not share: division by zero
still running
```

## 12. What stops a program, and what does not

| | When | What happens |
|---|---|---|
| a mistake | before anything runs | nothing runs, and nothing is compiled |
| a fault | as it runs, on some answers | the run stops; nothing it wrote counts; the page says so and keeps the answers |
| a question's `check` that fails | as it runs | the page shows its message; the run goes on |
| an answer that is not a number or a date | as it runs | it is empty, and marked unreadable |

A program can also guard against faults before they happen (`if n != 0`, `either`), and stops itself with `fail("why")` when it must. A test can say a fault is expected (`expect …
faults`, below).

## 13. Tests

A function is tested in a test file, `<name>.test.stride` beside a library, with `expect`:

```stride file=lib/money.test.stride then=test
# lib/money.test.stride
use "money"
expect dollars(1234.5) == "$1,234.50"
expect dollars(1 / 0) faults "F001"
```

`stride test lib/money.test.stride` runs it. A whole workflow is tested with answers: each file in
`<program>.tests/` is a JSON object of the answers, the boxes they fill, and optionally the questions that must or
must not be asked, what it prints and the fault it stops with (§17.8):

```
{
  "answers": { "full_name": "Ada Lovelace", "agrees": "yes" },
  "boxes": { "name": "Ada Lovelace", "agree": "Yes" },
  "asked": ["full_name", "agrees"]
}
```

`stride test consent.stride` runs every one. `stride test`
with no path runs every test in the folder you are in and the folders in it: each program's `.tests/` and every
`.test.stride` file; `--match words` runs only those whose name holds the words (§17.13).

## 14. Debugging

`print` shows any value, a list or record included. `stride run --trace` follows the program line by line: each
statement as it starts, the values it gives, each call and what it gives back:

```
$ stride run total.stride --trace
total.stride:5  var total: number = 0
      total = 0
total.stride:7  total = total + double(i)
  → double(n = 1)
  total.stride:2  let d = n * 2
        d = 2
  ← double gives 2
      total = 2
```

`stride debug` stops where you say and lets you look (§17.15). It stops before the first line; then:

```
$ stride debug sum.stride n=10
sum.stride:2  ask n: number "A number"
(debug) break 5
(debug) continue
breakpoint at sum.stride:5  total = total + twice(i)
(debug) print i
i = 1
(debug) step
lib/maths.stride:2  let d = n * 2
(debug) where
  → twice  lib/maths.stride:2
    main  sum.stride:5
```

`next` goes to the next line without going into calls, `out` to the end of this call, `locals` shows every value,
`list` the lines around, `help` the rest. In VS Code, F5 on a Stride file debugs it the same way, with breakpoints in
the margin (section 15). `stride asm` shows the instructions the machine runs, each with its source line.

## 15. Editors

For VS Code:

```
stride vscode
code --install-extension stride-1.0.0.vsix
```

It highlights Stride, shows mistakes as you type, completes keywords, library functions with their signatures, your
names, a library's names after `m.` and a record's fields after `p.`, shows a call's parameters as you type its
arguments, goes to a declaration, finds every use of a name, renames one across the files, says what a name is,
formats, and debugs (F5). Set `stride.command` if `stride` is not on the path.

Behind it are `stride lsp`, a language server, and `stride dap`, a debug adapter: Neovim, Helix, Zed, Emacs and other
editors that speak those protocols take `stride lsp` as the language server for `*.stride` files and `stride dap` as
the debugger (§17.15, §17.16).

## 16. Formatting

`stride fmt file.stride` puts a file in Stride's one layout, comments kept; `stride fmt .` every Stride file in the
folder and the folders in it; `--check` only lists those not in it. There is no other option.

## 17. The tools

`stride help` lists every command; `stride help run`, `stride run --help` or `-h` says one command's options with
an example. `stride --version` gives the tools' version, the language's, the bytecode's and the build.

The command line works as most do (§17.10): `--name value` or `--name=value`; `-q` for `--quiet`, `-h` for `--help`;
`--` ends the options, so `stride run -- -odd-name.stride` and `stride eval -- -x` take what follows as it is. A
negative number is never an option: `stride eval -1`.

| | |
|---|---|
| stdout | what the command gives: a program's prints and report, a value, test results, docs |
| stderr | mistakes, warnings, faults, the trace, and what a command did (`no mistakes`, `made …`) |
| `--quiet`, `-q` | no warnings, and nothing about what a command did; never its results, mistakes or faults |
| `--json` | stdout is one JSON document (`check`, `compile`, `run`, `test`, `eval`, `map`) |
| `--color=auto`, `always`, `never` | colour; auto colours a terminal unless `NO_COLOR` is set |

Every command exits 0 when it did what it says, 1 when it found mistakes, a fault or a failing test, and 2 when it
was given something it cannot take (§17.5).

## 18. A project's files

A single script needs nothing but itself. A folder of programs that share libraries is a *project*: `stride init`
makes `stride.json`, saying the Stride it needs, and `lib/`. Every program in the project, in any folder under it,
finds its libraries in `lib/` beside it first, then in the project's `lib/`, then in the folders `stride.json` names
under `"libraries"`, so libraries are shared without copying them (§4.7):

```
forms/
  stride.json          {"stride": "1.0", "libraries": ["../shared/lib"]}
  lib/money.stride     shared by every program below
  w9/w9.stride         use "money"
  w9/w9.boxes.json     the header: the PDF's sha256 and its boxes   (stride header, stride new)
  w9/w9.pdf            the issuer's PDF, beside its workflow          (stride new copies it)
  w9/w9.tests/*.json   its tests                                     (stride new starts one)
```

`stride check`, `stride test` and `stride fmt .` with no file work on the whole project from where you are. A project
that needs a newer Stride than the one installed says so. There is no package registry: a library from elsewhere is
copied into `lib/`, or named in `"libraries"`.

## 19. Running a workflow

`stride run w9.stride` serves the workflow on this computer only (`http://127.0.0.1:8080/`, or `--port`), opens your
browser at it, and runs until stopped with Ctrl-C; `BROWSER=none` leaves the browser closed, `--pdf` gives the PDF
when it is not `w9.pdf` beside the program, and `--today` fixes the date the page's `today()` gives. A PDF that is
not the one the program is for (its sha256 differs) is refused. Nothing a person types leaves the computer.

`--terminal` runs a program in the terminal, with every way of giving answers of §1, `--prompt`, `--json` and
`--trace`; a script always runs there. The browser's options with `--terminal`, or answers without it, are a usage
mistake that says which to use. For the same answers and date, the browser, the terminal and the compiled program
write the same boxes.

## 20. The PDF

- `fill "box" = e` writes words into a text box or a list box; `tick "box" when c` ticks a check box; `pick
  "group" "button" when c` chooses a radio button.
- **No stricter than the form.** A box written out that the PDF does not have is a mistake, as a misspelt name
  is. A box the program never mentions stays empty, and a box written twice keeps the later write (§10).
- **The question beside its box.** A question's printed words are the form's own, so a person meets the same words
  on the page and on the form. Stride does not read them off the PDF: you do.
- **Conditional questions** are questions inside an `if`: asked only when the condition holds.
- **Repeated rows** are a `collect`: it asks a block of questions for one item, then "Another?", until
  the answer is no; a `for each` then fills one row of boxes per item, `"Name{n}"`.

  ```
  record vehicle { vin: text, make: text }
  var vehicles: list of vehicle
  collect n, v in vehicles "Add another vehicle?" {
    ask v.vin: text "Vehicle Identification Number"
    ask v.make: text "Make"
  }
  # The form calls its rows' boxes "Make", "Make_2", "Make_3" …: a function builds the names.
  define row(n: number) -> text {
    return if n == 1 then "" else "_{n}"
  }
  for n in 1..5 {
    fill "Vehicle Identification Number{row(n)}" = vehicles[n].vin
    fill "Make{row(n)}" = vehicles[n].make
  }
  ```

```stride form
form consent
pdf 40b82a8804e4bc4b946750dd7b2aca7bdccc4c14fbeb48ada3d91f8c6a125c76

ask full_name: text "Full name"
ask agrees: yes-no "I agree to the terms"
if agrees {
  fill "name" = full_name
}
tick "agree" when agrees
```

- A box's name and a question's printed words are ordinary expressions, worked out as the program runs (§11.2):
  `fill "Row{n}" = v`. `stride map` lists the boxes a program names outright.
- A program never changes the PDF: it only fills its boxes, and nothing a person types leaves their browser.

## 21. Sharing a program

`stride compile w9.stride` writes `w9.sbc`: the whole program in one file, with its libraries, its questions and
their words, the boxes each answer goes into, and the fingerprint (sha256) of its form's PDF. Share it with the
PDF: `stride run w9.sbc`, with `w9.pdf` beside it (or `--pdf`), opens the same workflow wherever `stride` of the same
bytecode version is, and `stride test w9.sbc` runs its tests when `w9.tests/` is beside it; neither needs the source,
the libraries or the header. A different PDF is refused. To share the source, share the folder: the program, its
`lib/`, its header and its tests.

## 22. Versions

`stride version` says which version of the language the tools are. A minor version only adds: a program that
compiled before compiles and does the same. A major version may change a rule, and lists every rule it changes.
The bytecode has its own version; compile again after upgrading (§21).

## 23. Installing and upgrading

From the repository on Linux, with Node 22 or later and the repository's dependencies installed:

```
node scripts/build.mjs
sh scripts/install.sh
stride version
```

The first makes `dist/stride`, one executable with everything in it (the standard library, the guides, the workflow
page, the VS Code extension); the second copies it to `/usr/local/bin` when run as root, else `~/.local/bin`. The
installer says where it put stride and, when that folder is not on your PATH, that it should be. To upgrade, do the
same again: the new one replaces the old, and both builds are named.

This release supports Linux x64, including WSL2. Its programmer workflow and VS Code extension are tested on
Linux. Other platforms are outside this release's scope.

## 24. Limits, stated upfront

| | |
|---|---|
| loops | `for`, `for each`, `while`, `collect` |
| recursion | a function may call itself; calls deeper than 10,000 stop the run (F015) |
| functions | are values: passed, kept, returned, written in place (§9.10, §9.11) |
| outside access | none: no network, files, clock but `today()`, or randomness; the program sees only its answers |
| the PDF | never changed; only its boxes are filled |
| a run | calls at most 10,000 deep (F015); no limit of instructions unless the host sets one (F014) |
| values | numbers below 10^34 with 34 digits |
| errors | at most 20 mistakes shown; the rest are counted |
