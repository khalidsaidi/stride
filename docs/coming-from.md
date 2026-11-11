# Stride for someone who knows Go, Java, JavaScript or Python

Stride looks like the languages you know, and most of what you would write works as you expect. Where it differs,
it differs on purpose: a Stride program is a form's workflow, run in a stranger's browser. This page shows the familiar
idioms, the differences, and what to write instead. Every example here is run by Stride's test suite. The guide
(`stride guide`) and the specification (`spec.md`) say the rest.

## At a glance

| You know | In Stride |
|---|---|
| `x = 1`, `final x = 1`, `const x = 1` | `var x = 1` is given other values; `let x = 1` keeps its value (a list's items may still change); `const X = 1` is worked out by the compiler |
| `xs.append(x)`, `xs.push(x)`, `xs.insert(i, x)`, `xs.pop(i)`, `xs.clear()` | `append(xs, x)`, `insert(xs, i, x)`, `remove_at(xs, i)`, `clear(xs)`: each changes xs itself |
| `copy.deepcopy(xs)`, `structuredClone(xs)` | `copy(xs)` |
| `None`, `nil`, `undefined`, a `NullPointerException` | `null`: every type has it; `x == null` tests it; computing with it is a fault, as a `TypeError` or a `NullPointerException` is |
| `x ?? 0`, `x ?: 0`, `x or 0`, `x if x is not None else 0` | `x ?? 0`: x, or 0 when x is null; `""`, `0` and `[]` are not null |
| `if x:`, `if (x)` on a value that may be null | `if x { }` for a bool: null counts as false; `if x != null { }` for anything else |
| `list[0]`, `len(list)` | `list[0]`: positions count from 0; `count(list)` |
| `list[1:3]`, `list.slice(1, 3)` | `list[1..<3]`; `list[1..2]` includes both ends; `list[1..]`, `list[..<3]` |
| `"Hello " + name`, f-strings | `"Hello {name}"`; `+` joins words too |
| `for i := 0; i < n; i++`, `for i in range(n)` | `for i in 0..<n { }`; `for i in 1..n { }` includes n |
| `xs.forEach`, `for i, x := range xs`, `enumerate(xs)` | `for x in xs { }`, `for i, x in xs { }` (i from 0) |
| `xs.indexOf(x)`, `s.find(part)` | `index_of(xs, x)`, `find(s, part)`: the position, or -1 |
| `while`, recursion | `while c { }`; a function may call itself |
| `dict`, `map[K]V`, `Map` | `map<string, number>`: `{"a": 1}`, `m["a"]`, `m["b"] = 2`, `has(m, k)`, `for k, v in m { }` |
| tuples, `(a, b) = (b, a)`, `for k, v in pairs` | `(1, "a")` of type `(number, string)`: `t.0`, `let (a, b) = f()`, `(a, b) = (b, a)`, `for (k, v) in pairs { }` |
| `set()`, `Set`, `HashSet` | `set<number>`: `set([1, 2])`, `add(s, 3)`, `remove(s, 1)`, `2 in s`, `union(a, b)`, `for x in s { }` |
| `switch`/`match`/`when` as a value | `let s = match n { 1 => "one", 2, 3 => "few", else => "many" }` |
| nested and dict comprehensions | `[x * y for x in a for y in b]`, `{k: v for k, v in m if v > 0}` |
| `lambda`, `func(x) { }`, `x => …` | `function(x: number) -> number { return x * 2 }` |
| `def f(a, b=2):`, `func f(a int) int` | `function f(a: number, b: number = 2) -> number { }` |
| `xs.map(f)`, `filter`, list comprehensions | `[f(x) for x in xs if x > 0]` |
| `sorted(xs, key=...)` | `sorted(xs)`, `sorted(people, by: "age")` |
| `class`, `struct` | `record person { name: string }`; `new person { name: "Ada" }`; `p.f(x)` calls `f(p, x)` |
| `enum` | `enum colour { "red" "Red" … }`: each option its value and the words a person reads |
| `import x`, `require` | `import "x"`, `import "x" as m` (a file in `lib/`); `export function …` |
| `try`/`catch`/`finally`, exceptions | `try { } catch problem { } finally { }`; `problem.code`, `problem.message`; one not caught stops the run |
| `throw`, `raise`, `throw new Error("why")` | `throw "why"`; `throw error("why", code: "CODE")`; `throw problem` raises a caught error again; `fail("why")` is `throw "why"` |
| `finally`, `defer`, `using`, `with` | `try { } finally { }`: the block runs however the try ends |
| `print`, `console.log`, `fmt.Println` | `print(x)`; `print(a, b, c)` gives one line, a space between the values |
| `1e5`, `0xFF`, `0b1010`, `1_000_000`, `.5` | the same; every number is an exact decimal |
| `"\r"`, `"\0"`, `"\x41"` | the same, beside `\n`, `\t` and `\u{41}` |
| `2 ** 10`, `Math.pow(2, 10)`, `x **= 2` | `2 ** 10`, `power(2, 10)`, `x **= 2`; `-2 ** 2` is -4, as in Python |
| `range(0, 10, 2)`, `1..5`, `1...5`, `1 until 5`, `x in range(1, 6)` | `range(0, 10, 2)` is a list; `1..5` and `1..<5` are ranges, values: `let r = 1..5`, `for i in r { }`, `x in 1..5`, `count(r)` |
| `d + timedelta(days=7)`, `d.AddDays(7)`, `(d2 - d1).days` | `d + 7`, `d - 7`; `d2 - d1` is the number of days |
| code after `return` (an error in Go's vet, Swift, Kotlin, C#: a warning) | a warning (W008); the program still runs |
| `input()`, `args`, `stdin` | `ask name: string "Your name"`; answered at the terminal, as `name=Ada`, or from JSON |
| `# comment`, `// comment` | `# comment` |

## Lists, records and maps are shared

As in Python, Java and JavaScript, a list, a record or a map is one object that several names may hold: `var b = a`
makes `b` the same list as `a`, and a function changes the list it is given. `copy(a)` makes another list with the
same items, copied all the way down. A `let`, like JavaScript's `const` and Kotlin's `val`, keeps its list, whose
items may still change (§3.4).

```stride
var a: list<number> = [1, 2]
let b = a
b[2] = 3
print(a)
let c = copy(a)
function add_one(xs: list<number>) {
  xs[0] = xs[0] + 1
  append(xs, 0)
}
add_one(a)
print(a)
print(b)
print(c)
```
```output
[1, 2, 3]
[2, 2, 3, 0]
[2, 2, 3, 0]
[1, 2, 3]
```

`==` compares values, items and fields included, the way Python's `==` does on lists: `[1, 2] == [1, 2]` is `true`.

## Null

`null` is no value, what `None`, `nil` and `undefined` are elsewhere. Every type has it: an unanswered question, a
field never set, a key a map does not have. It is apart from the values that hold nothing: `""` is words, `[]` a
list, and neither is null. As in Python, Java and Swift, computing with it stops the run (fault F023, the
`TypeError` or `NullPointerException` of Stride): arithmetic, `<`, a field, an item, `for`, a library function
all need a value. What takes it: `==` and `!=`, a condition (null counts as `false`, as `None` is falsy), words
with values (`"{x}"` puts in nothing, as C# does) and `fill`. `x ?? y` gives a value in its place, as in JavaScript,
C# and Swift; there is no `?.`: write `if r != null`.

```stride
let price: number = null
print(price == null)
print(price ?? 0)
print((price ?? 0) + 5)
print("" == null)
print(count([]))
let ages: map<string, number> = {"Ada": 36}
print(ages["Bo"] == null)
print(ages["Bo"] ?? 0)
try {
  print(price + 5)
} catch why {
  print(why)
}
```
```output
true
0
5
false
0
true
0
null where a number is needed: the left side of +
```

## Positions count from 0

`xs[0]` is the first item and `xs[count(xs) - 1]` the last, as in Go, Java, JavaScript and Python. A position
outside the list stops the run (F004), as an `IndexError` or a panic does; there are no negative positions from
the end. A range `a..b` includes both ends, and `a..<b` stops before b, in a slice and in a `for`. Assigning at
`count(xs)` adds an item.

```stride
var xs: list<string> = ["a", "b", "c"]
print(xs[0])
print(count(xs))
print(xs[0..1])
print(xs[1..<3])
for i in 0..<count(xs) {
  print("{i}: {xs[i]}")
}
xs[count(xs)] = "d"
print(index_of(xs, "d"))
print(index_of(xs, "z"))
print(xs[4])
```
```output
a
3
[a, b]
[b, c]
0: a
1: b
2: c
3
-1
```
```stderr
fault F004: position 4 is outside the list: it holds 4
  at main, guide.stride:12:9
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
true
0.3333333333333333333333333333333333
0.9999999999999999999999999999999999
1
-4
1
```

## Functions as values, comprehensions and sorting by a field

A function can be passed, kept and returned (§9.10): `function apply(f: function(number) -> number, n: number)`.
A function with no name is written in place; it reads the names around it and shares their vars (§9.11):
`function(n: number) -> number { return n + k }`.
For the common cases a comprehension or `sorted` is shorter:

```stride
record person {
  name: string
  age: number
}
let people: list<person> = [new person { name: "Bo", age: 40 }, new person { name: "Al", age: 30 }, new person { name: "Cy", age: 17 }]
let adults = [p.name for p in people if p.age >= 18]
print(adults)
print([upper(n) for n in adults])
print([p.name for p in sorted(people, by: "age")])
print(sorted([3, 1, 2], descending: true))
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
a `try { … } catch problem { … }` around it catches it (§7.18), with the error's `code` and `message` in
`problem`, and a `finally { … }` block after it runs either way; a program avoids faults by checking first, and
stops itself with `throw` when it must (§7.19):

```stride answers={"n":"0"}
ask n: number "How many people"
if n == null or n == 0 {
  print("nobody to share with")
} else {
  print(100 / n)
}
```
```output
nobody to share with
```

```stride answers={"born":"2030-01-01"}
function age_on(born: date, day: date) -> number {
  if born > day {
    throw "born after the day"
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

`for i in a..b`, `for x in list`, `while c`, and functions that call themselves, as you know them. A `for`
loop's bounds are worked out once, when it starts; `for x in list` goes through the items the list held then. A run
that never ends runs until its host stops it; calls deeper than 10,000 stop the run (F015).

```stride
function digits_of(n: number) -> number {
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


## Input is asked for

A program does not read files, the network, its command line or stdin. It asks questions, and whoever runs it
answers them: a person on the form's page, you at the terminal, or a file of answers in a test. The answers are its
only input, so the same answers always give the same run.

```stride answers={"name":"Ada","likes":["red","blue"]}
enum colour {
  "red" "Red"
  "green" "Green"
  "blue" "Blue"
}
ask name: string "Your name"
ask likes: any_of colour "Colours you like"
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
  name: string
  born: date
}
function greeting(p: person) -> string {
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
