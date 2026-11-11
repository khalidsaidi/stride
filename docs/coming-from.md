# Stride for someone who knows Go, Java, JavaScript or Python

Stride looks like the languages you know, and most of what you would write works as you expect. Where it differs,
it differs on purpose: a Stride program is a form's workflow, run in a stranger's browser. This page shows the familiar
idioms, the differences, and what to write instead. Every example here is run by Stride's test suite. The guide
(`stride guide`) and the specification (`spec.md`) say the rest.

## At a glance

| You know | In Stride |
|---|---|
| `x = 1`, `final x = 1`, `const x = 1` | `var x = 1` changes; `let x = 1` does not; `const X = 1` is worked out by the compiler |
| `null`, `None`, `nil`, `undefined` | `empty`: every type has it; `x is empty`, `either(x, 0)` |
| `true`, `false` | `yes`, `no` |
| `list[0]` | `list[1]`: positions count from 1, as on a form |
| `"Hello " + name`, f-strings | `"Hello {name}"`; `+` joins words too |
| `for i := 0; i < n; i++`, `for i in range(n)` | `for i in 1..n { }` |
| `for x in xs`, `xs.forEach` | `for each x in xs { }`, `for each i, x in xs { }` |
| `while`, recursion | `while c { }`; a function may call itself |
| `dict`, `map[K]V`, `Map` | `map of text to number`: `{"a": 1}`, `m["a"]`, `m["b"] = 2`, `has(m, k)`, `for each k, v in m { }` |
| `lambda`, `func(x) { }`, `x => …` | `function(x: number) -> number { return x * 2 }` |
| `def f(a, b=2):`, `func f(a int) int` | `define f(a: number, b: number = 2) -> number { }` |
| `xs.map(f)`, `filter`, list comprehensions | `[f(x) for each x in xs if x > 0]` |
| `sorted(xs, key=...)` | `sorted(xs)`, `sorted(people, by: "age")` |
| `class`, `struct` | `record person { name: text }`; `new person { name: "Ada" }`; `p.f(x)` calls `f(p, x)` |
| `enum` | `options colour { "red" "Red" … }` |
| `import x`, `require` | `use "x"`, `use "x" as m` (a file in `lib/`); `export define …` |
| `try`/`catch`, exceptions | `try { } catch problem { }`; `fail("why")` raises a fault; one not caught stops the run |
| `print`, `console.log`, `fmt.Println` | `print(x)` |
| `input()`, `args`, `stdin` | `ask name: text "Your name"`; answered at the terminal, as `name=Ada`, or from JSON |
| `# comment`, `// comment` | `# comment` |

## Values are copied, never shared

In Python, Java and JavaScript a list or an object is a reference: two names can change one value. In Stride a list
and a record are values, like numbers: `var b = a` copies, and a function changes only its own copy (§3.4).

```stride
var a: list of number most 5 = [1, 2]
var b = a
b[3] = 3
print(a)
print(b)
define add_one(xs: list of number most 5) -> list of number most 5 {
  var out = xs
  out[1] = out[1] + 1
  return out
}
print(add_one(a))
print(a)
```
```output
[1, 2]
[1, 2, 3]
[2, 2]
[1, 2]
```

`==` compares values, items and fields included, the way Python's `==` does on lists: `[1, 2] == [1, 2]` is `yes`.

## Empty instead of null

There is no null that fails when you touch it. Every type has `empty`: an unanswered question, a field never set, a
position past a list's items. Arithmetic with empty does what a form's empty box needs: `+` gives the other side,
other operations give empty, and empty is `no` in a condition. There is no `NullPointerException`; there is `is empty`.

```stride
let price: number = empty
print(price + 5)
print(price is empty)
print(either(price, 0))
let names: list of text most 3 = ["Ada"]
print(names[2] is empty)
print(either(names[2], "nobody"))
```
```output
5
yes
0
yes
nobody
```

## Positions count from 1

`xs[1]` is the first item, as row 1 is the first row of a form. A position past the items gives empty; a position
below 1, or past what the list can ever hold (its `most`), stops the run (F004).

```stride
let xs: list of text most 3 = ["a", "b"]
print(xs[1])
print(count(xs))
print(xs[3] is empty)
print(xs[1..2])
```
```output
a
2
yes
[a, b]
```

## Numbers are exact decimals

Not binary floating point: `0.1 + 0.2` is `0.3`, and money adds up. A number holds up to 34 significant digits;
a result that needs more, and a `/` that does not come out even, is rounded once to 34 (§3.3). `//` and `%` round
towards minus infinity, as in Python.

```stride
print(0.1 + 0.2 == 0.3)
print(1 / 3)
print(1 / 3 * 3)
print(round(1 / 3 * 3, 2))
print(-7 // 2)
print(-7 % 2)
```
```output
yes
0.3333333333333333333333333333333333
0.9999999999999999999999999999999999
1
-4
1
```

## Functions as values, comprehensions and sorting by a field

A function can be passed, kept and returned (§9.10): `define apply(f: function(number) -> number, n: number)`.
A function with no name is written in place, and keeps the names around it as they were (§9.11):
`function(n: number) -> number { return n + k }`.
For the common cases a comprehension or `sorted` is shorter:

```stride
record person {
  name: text
  age: number
}
let people: list of person most 3 = [new person { name: "Bo", age: 40 }, new person { name: "Al", age: 30 }, new person { name: "Cy", age: 17 }]
let adults = [p.name for each p in people if p.age >= 18]
print(adults)
print([upper(n) for each n in adults])
print([p.name for each p in sorted(people, by: "age")])
print(sorted([3, 1, 2], descending: yes))
```
```output
[Bo, Al]
[BO, AL]
[Cy, Al, Bo]
[3, 2, 1]
```

## Errors: guard, or stop

Mistakes the compiler can see (a misspelt name, a wrong type, a box the form
does not have) are found before anything runs. At run time a fault stops the run and says where, unless
a `try { … } catch problem { … }` around it catches it (§7.18); a program avoids faults by checking first, and
stops itself with `fail` when it must:

```stride answers={"n":"0"}
ask n: number "How many people"
if n is empty or n == 0 {
  print("nobody to share with")
} else {
  print(100 / n)
}
```
```output
nobody to share with
```

```stride answers={"born":"2030-01-01"}
define age_on(born: date, day: date) -> number {
  if born > day {
    fail("born after the day")
  }
  return years_between(born, day)
}
print(age_on(date_of(1990, 5, 1), date_of(2026, 5, 1)))
ask born: date "Date of birth"
print(age_on(born, date_of(2026, 5, 1)))
```
```output
36
```
```stderr
fault F013: born after the day
  at age_on, guide.stride:3:5
  called from main, guide.stride:9:7
```

A test can say a fault is what it expects: `expect age_on(...) faults "F013"` (`stride guide tests`).

## Loops and recursion

`for i in a..b`, `for each x in list`, `while c`, and functions that call themselves, as you know them. A `for`
loop's bounds are worked out once, when it starts; `for each` goes through the items the list held then. A run
that never ends is stopped: after 2,000,000 instructions (F014), or calls 200 deep (F015).

```stride
define digits_of(n: number) -> number {
  var left = n
  var count = 0
  while left >= 1 {
    left = left // 10
    count = count + 1
  }
  return count
}
print(digits_of(12345))
```
```output
5
```

A loop with a bound you know is safe to break out of; there is always one, since a number has at most 34 digits and a
list at most 1000 items.

## Input is asked for

A program does not read files, the network, its command line or stdin. It asks questions, and whoever runs it
answers them: a person on the form's page, you at the terminal, or a file of answers in a test. The answers are its
only input, so the same answers always give the same run.

```stride answers={"name":"Ada","likes":["red","blue"]}
options colour {
  "red" "Red"
  "green" "Green"
  "blue" "Blue"
}
ask name: text "Your name"
ask likes: any-of colour "Colours you like"
print("{name} likes {count(likes)} colours: {join(likes)}")
```
```output
Ada likes 2 colours: red, blue
```

`stride run likes.stride name=Ada likes=red,blue` gives the same, as does typing the answers when it asks.

## Records and calls that read like methods

A record is a value with named fields; `p.f(x)` is `f(p, x)`, so a function whose first parameter is a record reads
like a method:

```stride
record person {
  name: text
  born: date
}
define greeting(p: person) -> text {
  return "Hello, {p.name}"
}
let ada = new person { name: "Ada", born: date_of(1815, 12, 10) }
print(ada.greeting())
print(year(ada.born))
```
```output
Hello, Ada
1815
```

## Files, tests and tools

| You know | In Stride |
|---|---|
| `python app.py`, `node app.js`, `go run .` | `stride run app.stride` |
| `python`, `node`, `jshell` | `stride repl` |
| `pytest`, `go test ./...`, `npm test` | `stride test` (every test in the folder and below) |
| `black`, `gofmt`, `prettier` | `stride fmt .` |
| `pdb`, `dlv`, a debugger in the editor | `stride debug app.stride`; F5 in VS Code |
| `pip install`, `go get`, `npm install` | none: copy a library into `lib/`, or name its folder in `stride.json` |
| a `.jar`, a binary | `stride compile app.stride` gives `app.sbc`; `stride run app.sbc` |
| `pydoc`, `go doc` | `stride doc word`; `stride guide topic` |
