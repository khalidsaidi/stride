# Stride: design

> History. This was written before Stride 1.0 and describes the language as it was planned then, not as it is. What
> Stride is now: [the guide](../guide.md) and [the specification](../spec.md).

Stride is the language a form's workflow is written in. This is its design: what it must do,
the language, the compiler, the virtual machine and the tools, and how each is built. The construction is
taken from Docassemble (`jhpyle/docassemble`, MIT, read in full on 2026-11-07 at commit 36d7bd4) where it
solved the same problem, and from how real compilers are built where it did not. `grammar.md` becomes the
reference manual once this is built.

## 1. What a workflow must do

A program says which questions a form needs, in what order and under what conditions, and what each answer
writes into the PDF's own boxes. How the questions are shown, in which human language, and how a person moves
between them belong to the page that runs the program, not to the language. Nothing a program does leaves the
browser, and it never changes the PDF.

| # | What a program must express | Docassemble builds it with | Stride |
|---|---|---|---|
| 1 | Questions that fill the PDF's boxes | attachment `fields:` rendered to (field, text) pairs, `parse.py:7440-7511` | `fill`, `tick`, `pick` |
| 2 | Only the questions that apply | `if:` and `show if`, evaluated every pass, `parse.py:9154` | `if`, `match`, re-run on every change |
| 3 | The same thing several times (representatives, table rows, children) | `DAList.gather`, `util.py:3339-3448` | list types, `collect` |
| 5 | An answer offered from an earlier one | `default:`, `parse.py:4104-4117` | `default` |
| 6 | Answers that fit the box and make sense (a date, a number) | datatype conversion, `views.py:1335-1652` | types, the box's own length, `check` |
| 10 | Boxes ticked the way the PDF expects | export-value mapping, `pdftk.py:498-534` | the box's own export value from the header |
| 11 | One answer across a row of single-letter boxes (SIN, dates) | none: a field per box | `chars`, `digits`, `date` in the standard library |

## 2. How Docassemble is built, and what Stride takes

- **The answers are the only state; the program runs from the top on every change** (`Interview.assemble`,
  `parse.py:8547-9062`). Taken: `run(program, answers)` is a pure function, called after every answer.
- **Every value knows its full name** (`instanceName`, `util.py:836-860`): the name an answer is stored and
  found under. Taken: every question's key is its path, `representatives[2].name`.
- **Lists gathered by a loop that is safe to re-run** (`there_are_any`, `there_is_another`,
  `_necessary_length`). Taken as `collect`, bounded by the rows the PDF has (section 3.5).
- **Ask when a value is needed.** Docassemble's blocks are unordered; reading a missing name raises
  `NameError` and `askfor` (`parse.py:9069-9888`) searches for the block that sets it. A Stride program is
  ordered and typed: an answer is read only after the `ask` that gives it, which the compiler proves
  (definite assignment, 4.4). Same order, found at compile time, no search at run time. Not taken.
- **Engine and host separate:** the engine hands a plain object to whatever shows it (`as_data`,
  `parse.py:677-1190`) and reaches the server only through 119 named hooks (`hooks.py`). Taken: the machine
  returns the questions reached and the box writes, and reaches nothing else.
- **Dependants deleted when an answer changes** (`invalidate_dependencies`, `views.py:2168-2237`). Not taken:
  a run is pure, so an answer in a branch that no longer runs writes nothing, and counts again if the branch
  does.
- **Export values** read from the PDF (`pdftk.py:117-130`). Taken.

Left out, each for a reason: accounts and server sessions (what a person types stays on their device); Word,
flattened or stamped PDFs, signature images (the PDF is never changed); email, SMS, web calls (they send what
a person typed); Python or Mako inside a workflow (a workflow is data run by one machine, and always ends);
generated grammar. Translation, screens and navigation are the page's.

## 3. The language

### 3.1 A program

```
form irs-2848
pdf 14377021f958…
fields "topmostSubform[0]."
use "people"                       # lib/people.stride

record representative {
  name: text
  address: long-text
  caf: text
}

ask taxpayer_name: text "Taxpayer name and address"
fill "Page1[0].TaxpayerName[0]" = taxpayer_name
…
```

A program is a header (form, PDF, field prefix), imports, declarations (records, functions, constants) and
statements run in order.

### 3.2 Types

| Type | Values | Written |
|---|---|---|
| `text`, `long-text` | words | `"…"`, `+` joins |
| `number` | numbers | `12`, `3.5`, `+ - * /` |
| `date` | a day | an answer, `date("2026-11-07")`, `today()` |
| `yes-no` | yes, no | an answer; conditions are yes-no |
| `phone`, `email` | text with a shape | an answer |
| an option set | one of its options | `one-of` answers, `option` values |
| `set of` an option set | several | `any-of` answers |
| a record | named fields | `record` declarations |
| `list of T, most N` | up to N values of T | `collect`, list literals |

Every value may be empty: an answer not given yet. `is empty` tests it; a text that is empty writes nothing.
Types are checked at compile time; nothing is converted silently except a number or date into text where a
box is written, by the standard library's rule.

### 3.3 Declarations

- `let name = expression`, `var name = expression` (a `let` is never assigned again).
- `const name = expression`: worked out at compile time.
- `record name { field: type … }`.
- `options name { "value" "printed words" … }`: a named option set, reusable by several questions.
- `define name(param: type, …) -> type { … }`: a function; it runs in the machine, with its own frame. It
  may ask questions; their keys are under the call's path. A function cannot call itself (directly or not),
  so every program ends.
- `use "file"`: brings in a library's exported declarations (`export define`, `export record`). A library
  has no header and writes no box.

### 3.4 Statements

| Statement | Does |
|---|---|
| `ask path: type "printed words" [default e] [check c "message"]` | asks; the answer is the value at `path` |
| `fill "box" = e` | writes text or a number into a text box or a list box |
| `tick "box" when c` | ticks a check box, with the box's own export value |
| `pick "group" "button" when c` | picks that button of a radio group |
| `skip "box" because "reason"` | a box the workflow leaves alone |
| `if c { } else if c { } else { }` | one branch |
| `match e { "value" => { } … else => { } }` | one branch by an option's value |
| `for i in a..b { }` | bounds known at compile time |
| `for each x in list { }` | each item of a list, with its number as `x.number` |
| `collect list "Add another …?" { }` | asks one item at a time (3.5) |
| `return e` | the function's value |
| `name = e` | assigns a `var` |

### 3.5 Lists and `collect`

```
var representatives: list of representative, most 4
collect representatives "Add another representative?" {
  ask item.name: text "Name and address"
  ask item.address: long-text "Name and address"
  …
}
for each r in representatives {
  fill "Page1[0].RepresentativesName{r.number}[0]" = r.name
}
```

`collect` is Docassemble's gather loop with the bound the PDF gives. The first item is asked; after each
item but the last possible one, the quoted yes-no (key `representatives[n].another`); a yes reaches the
next item. The compiler knows `most`, so it can prove each box `{r.number}` names exists for every number up
to it; a `most` larger than the PDF's rows is refused at the `fill` that would name a missing box.

### 3.6 Expressions

Loosest first: `or`, `and`, `not`, comparisons (`== != < <= > >=`, `in`, `not in`, `is empty`, `is not
empty`), `+ -`, `* /`, unary `-`, then postfix (`.field`, `[index]`, calls), then values (literals, names,
lists `[a, b]`, records `representative { name: "x" }`, parentheses). `"… {e} …"` puts any expression's text
into a string.

### 3.7 The standard library

Written in Stride where it can be (`lib/std.stride`, brought in by every program), native in the
machine where it cannot. Text: `upper`, `lower`, `trim`, `length`, `chars(t, from, to)`, `digits`,
`replace`, `join`, `split`, `first_line`, `other_lines`. Numbers: `round`, `money(n)` (two decimals),
`whole`. Dates: `today`, `year`, `month`, `day`, `format(d, "MM/DD/YYYY")`, `age(d)`, `days_between`.
Lists: `count`, `first`, `last`, `contains`. A box per character: `boxes(t, n)` gives the n-th character
for single-letter rows.

## 4. The compiler

Written in JavaScript (`src/`), one module per phase; the command line and the tool use it the same
way. Every phase adds mistakes to one list; each mistake has its file, line, column, a plain message, and
the source line with a caret under the column.

1. **Parse.** A hand-written lexer and recursive-descent parser (`src/syntax.mjs`). It gives an
   abstract syntax tree in which every node carries its source span.
2. **Load libraries.** `use` reads and parses each library once; a cycle is a mistake.
3. **Resolve names.** Scopes: the program, each library, each function, each block. Every name points to
   its declaration; a name used before its declaration, a name declared twice in one scope, an unknown name
   or field are mistakes.
4. **Check types.** Every expression gets a type from its parts; a function's parameters and result are
   declared, so calls check without looking inside. Definite assignment: an answer or variable read on a path
   where it may not have been asked or set is a mistake (Docassemble's `NameError`, at compile time). An
   answer assigned to is a mistake. A function that may call itself is a mistake.
5. **Lower to an intermediate form.** Each function becomes a graph of basic blocks of simple instructions
   (load, store, call, ask, write, branch), with explicit temporaries. `collect`, `for each`, `match`,
   string interpolation and `default` become plain blocks and branches here.
6. **Optimise.** Constant folding and propagation; branches whose condition is known are removed with their
   blocks; small functions with constant arguments inlined; unreachable blocks and unused temporaries
   removed.
7. **Check against the PDF.** With the form's header (`<form>.boxes.json`: every box, its kind, export
   value, most length and the words printed beside it): every box exists and is of the right kind; on every
   path through the program no box is written twice; every box is written or skipped on some path; every
   question's printed words are printed beside a box it writes; every option's words beside its box. Paths
   are walked over the optimised graph, with lists unrolled to `most`.
8. **Generate bytecode.** Blocks are laid out, jumps resolved, constants pooled, and a line table maps every
   instruction back to its source line.

## 5. The bytecode and the machine

The machine (`runtime/vm.mjs`) is a stack machine with call frames. A file is: magic `STRD`,
version 2; the constant pool (texts, numbers); the header; the box table (name, kind, export value, most
length); the record and option-set tables; the question table (key path, type, printed words, options,
default and check present, line); the function table (name, parameter count, local count, code start); the code;
the line table.

Instructions: constants (`CONST`, `EMPTY`, `TRUE`, `FALSE`); locals and globals (`LOAD`, `STORE`, `GLOAD`,
`GSTORE`); records and lists (`NEW_RECORD`, `GET_FIELD`, `SET_FIELD`, `NEW_LIST`, `GET_ITEM`, `APPEND`,
`LENGTH`); arithmetic and comparison; `JUMP`, `JUMP_IF_FALSE` (forward only), `LOOP` (backward, to a counted
loop's head, with the count on the frame); `CALL function`, `RETURN`, `NATIVE function`; `ASK question` (the
key is built from the frame's path, so a call or a list item gives each its own answer), `DEFAULT`, `CHECK`;
`FILL`, `TICK`, `PICK`; `HALT`.

Every loop is counted and every call goes to a function that cannot reach itself, so every run ends; the
machine also stops at a fixed number of instructions and reports the line, so a fault in the machine itself
cannot hang a page.

`run(program, answers)` returns `steps` (each question reached: its key, its default, whether its check
failed) and `writes` (each box and its value). A runtime fault (a native given a value it
cannot take) gives the source line from the line table.

## 6. The tools

`stride` (one executable): `compile`, `check` (every phase but generation), `run file answers.json`
(questions asked and boxes written), `test` (every `<form>.tests/*.json`: answers in, the boxes expected
out, compared), `asm` (instructions with source lines), `fmt` (one layout for every program), `version`.
`stride header` writes the header a program is checked against.

The pseudocode for each part is in `pseudocode.md`.
