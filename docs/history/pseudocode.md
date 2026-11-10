# Stride: pseudocode

> History. This was written before Stride 1.0 and describes the language as it was planned then, not as it is. What
> Stride is now: [the guide](../guide.md) and [the specification](../spec.md).

The design is `design.md`. This is each part in pseudocode, in the order the program is built.

## 1. Values

```
Value = Empty | Text(s) | Number(n) | Date(y, m, d) | YesNo(b) | Option(set, value)
      | OptionSet(set, values) | Record(type, fields: map name -> Value) | List(type, most, items)

empty(v)        = v is Empty or Text("") or OptionSet with no values or List with no items
text_of(v)      = Empty -> "" ; Text -> s ; Number -> shortest decimal ; Date -> "YYYY-MM-DD"
                  YesNo -> "yes"/"no" ; Option -> value ; OptionSet -> values joined by ", "
truthy(v)       = YesNo(true) only; a condition is always yes-no (the type checker sees to it)
```

## 2. Parse

```
parse(source, file):
  tree = generated_parser.parse(source, start = "Program" or "Library")
  on syntax error at (line, col) with expected set E:
    mistake(file, line, col, "expected " + plain(E) + ", found " + found)
  every node: { kind, span: { file, line, col, end } , … }
```

## 3. Load libraries

```
load(program):
  queue = [program]; loaded = { program.file }
  while queue:
    unit = queue.pop()
    for use in unit.uses:
      path = dir/lib/use.file + ".stride"
      if path on the current chain: mistake(use, "libraries use each other in a circle")
      if path not in loaded: loaded.add(path); queue.push(parse(read(path), "Library"))
  units = topological order of loaded (a library before what uses it)
  units = [std] + units                          # the standard library comes first, always
```

## 4. Resolve names

```
Scope = { parent, names: map name -> Declaration }

declare(scope, name, decl):
  if name in scope.names: mistake(decl, name + " is already defined on line " + …)
  scope.names[name] = decl

lookup(scope, name):
  while scope: if name in scope.names return it; scope = scope.parent
  return nothing

resolve(units):
  globals = Scope(parent = nothing)
  for unit in units:
    for d in unit.declarations (records, options, consts, functions):     # declared before bodies, so order
      if unit is a library and d is not exported: declare in unit's own scope   # of functions is free
      else declare(globals, d.name, d)
  for unit in units: resolve_block(unit.body, Scope(globals))
  for f in functions: resolve_block(f.body, Scope(globals) with f's parameters)

resolve_block(stmts, scope):
  for s in stmts:
    resolve every name in s's expressions: d = lookup(scope, name)
      none -> mistake(name, "nothing called " + name + " is defined" + nearest_name_hint)
      d declared later in the same block -> mistake(name, name + " is used before line " + d.line)
    match s:
      ask path      -> declare the path's root in scope (not again if the root is a list item: item)
      let/var/const -> declare(scope, s.name, s)
      if/match      -> resolve each branch in the SAME scope   # an if is not a scope: answers asked in a
                                                               # branch are known after it, possibly empty
      for/each      -> resolve body in Scope(scope) with the counter or item declared
      collect       -> resolve body in Scope(scope) with `item` declared as the list's element
```

## 5. Check types

```
type_of(e, env):
  literal          -> its type
  name             -> declared type of the name
  a.b              -> t = type_of(a); t must be a record with field b -> that field's type
  a[i]             -> list of T and number -> T
  call f(args)     -> f's declared parameters; each arg's type must fit; -> f's declared result
  a + b            -> number+number -> number ; text-like + text-like -> text ; else mistake
  a - b, a * b ... -> numbers -> number
  a == b, a != b   -> same type (an option compared with a literal: the literal must be one of its values)
  a < b ...        -> numbers or dates -> yes-no
  a in b           -> b is a set of options or a list; a is its element -> yes-no
  e is empty       -> any -> yes-no
  not/and/or       -> yes-no
  "…{e}…"          -> any e -> text

fits(value_type, wanted):  same type, or long-text/phone/email where text is wanted, or Empty anywhere

check_statement(s):
  ask        -> default's type fits the question's type; check's condition is yes-no
  fill       -> value is text-like, number or date (a list or record is a mistake)
  tick/pick  -> condition is yes-no
  if         -> condition is yes-no
  assign     -> target is a var, not a let, a const or an answer; value fits its type
  return     -> fits the function's result; it is the last statement
  call as statement -> its result is thrown away (allowed)
```

### 5.1 Definite assignment (a name read before it can have a value)

```
# Over each function body and the program body, forward, with sets of "known" names.
known_after(stmts, known):
  for s in stmts:
    for name read by s: if name not in known: mistake(s, name + " may not be asked yet here")
    match s:
      ask path      -> known += root(path)
      let/var       -> known += name
      if c A else B -> known = known ∪ asked(A) ∪ asked(B)   # an answer asked in a branch is known after
                                                            # it, as empty when the branch did not run
      collect / for -> known = known ∪ {list name}
  return known
```

### 5.2 No function reaches itself

```
calls = graph f -> functions f's body calls
for each strongly connected component C of calls:
  if |C| > 1 or C's function calls itself: mistake(first call in C, "a function may not call itself")
```

## 6. Lower to the intermediate form

```
Function IR = { name, params, locals, blocks: [Block], entry }
Block       = { label, instrs: [Instr], end: Jump(l) | Branch(cond, l_true, l_false) | Return(v) | Halt }
Instr       = t = const k | t = load x | store x, t | t = op a b | t = call f(args) | t = native g(args)
            | t = record(type, fields) | t = field a.b | t = item a[i] | t = append a, v | t = length a
            | ask q (key built from frame path) -> slot | default q, t | check q, t
            | fill box, t | tick box, t | pick box, button, t

lower(stmt):
  if c A else B:
    t = lower_expr(c); end current with Branch(t, LA, LB)
    LA: lower(A); Jump(LJ)      LB: lower(B); Jump(LJ)      continue at LJ
  for i in a..b:                                   # a, b consts
    i = a; Jump(Lhead)
    Lhead: Branch(i <= b, Lbody, Lexit)
    Lbody: lower(body); i = i + 1; Jump(Lhead)     # the only backward jump: a counted loop's head
  for each x in L:
    n = length L; k = 1; Jump(Lhead)
    Lhead: Branch(k <= n, Lbody, Lexit)
    Lbody: x = item L[k]; x.number = k; lower(body); k = k + 1; Jump(Lhead)
  collect L "Another?" { body }:                   # Docassemble's gather, bounded by L.most
    k = 1; Jump(Lhead)
    Lhead: push_path(L.name + "[" + k + "]")
           item = record(L.element); lower(body); append L, item
           Branch(k < L.most, Lask, Lexit)
    Lask:  ask another (key L.name[k].another, yes-no) -> a
           k = k + 1
           Branch(a == yes, Lhead, Lexit)          # after a no, or no answer yet, the list ends here
    Lexit: pop_path
  match e { v1 => A, v2 => B, else => C }:  a chain of Branch(t == v1, …)
  "…{e}…": text concatenation of the parts, each through text_of
  ask p … default d:  t = lower_expr(d); default q, t; ask q -> p
```

## 7. Optimise

```
repeat until nothing changes:
  constant folding: t = op k1 k2 -> t = const (op k1 k2)
  constant propagation: a temporary assigned once from a const -> its uses take the const
  branch folding: Branch(const yes, A, B) -> Jump(A); the other edge removed
  inline: a call to a function of fewer than 30 instructions, or whose every argument is a const -> its
          blocks copied in, with parameters bound and its path pushed
  unreachable blocks removed (from the entry, following edges)
  dead temporaries removed (assigned, never read, no effect)
loops whose bounds are consts and body has no ask are unrolled if fewer than 8 turns
```

## 8. Check against the PDF

```
header = read("<form>.boxes.json")    # { pdf, boxes: [{ field, kind, on, options, max, printed, near }] }
if header.pdf != program.pdf: mistake(program, "the header is for another PDF")

# Walk every path. Lists and loops are bounded, so there are finitely many; paths are merged at each join
# point by the set of boxes written so far, so the walk is over states, not every path one by one.
state = { at: block, written: set of boxes, frame path }
walk(state):
  for instr in block:
    if instr writes box B:
      B not in header             -> mistake(instr, "the PDF has no box " + B + nearest_box_hint)
      kind of B wrong for instr   -> mistake(instr, B + " is a " + kind + ", " + instr + " cannot write it")
      pick button not in B.on set -> mistake(instr, B + " has no button " + button)
      B in written                -> mistake(instr, B + " is written twice when the form is filled this way")
      written += B; ever_written += B
  follow each edge, merging with states already seen at that block with the same `written`

for box in header.boxes: if box not in ever_written and not skipped:
  mistake(program, "the box " + box + " is never written or skipped")
for ask q: if q.printed not in near(any box q's answer reaches directly):
  mistake(q, "\"" + q.printed + "\" is not printed beside the boxes it writes")
for ask q: if q's answer is never read: mistake(q, q.key + " is asked but never used")
for fill with box.max and a direct answer: q.max = box.max
```

## 9. Generate bytecode

```
layout: blocks in reverse post-order; a Jump to the next block is dropped
for each instr: emit opcode + operands (varints); jumps emit a 4-byte placeholder, patched when the target's
  address is known
pool every text and number once; tables: boxes, records, option sets, questions, functions
line table: (address, line) pairs, written when the line changes
file = "STRD" + version 2 + tables + code + line table
```

## 10. The machine

```
run(program, answers, limit = 1_000_000):
  frames = [Frame(function = main, locals, pc = main.start, path = "")]
  steps = []; writes = map; count = 0
  loop:
    count += 1; if count > limit: fault("the workflow ran too long")
    f = frames.top; op = read(f.pc)
    match op:
      CONST k        -> push(constant k)
      LOAD x/STORE x -> f.locals[x]
      GLOAD/GSTORE   -> globals[x]
      NEW_RECORD r   -> push(Record(r, every field Empty))
      GET_FIELD n    -> push(pop().fields[n] or Empty)
      SET_FIELD n    -> v = pop(); rec = pop(); rec.fields[n] = v
      NEW_LIST t m   -> push(List(t, m, []))
      GET_ITEM       -> i = pop(); l = pop(); push(l.items[i - 1] or Empty)
      APPEND         -> v = pop(); l = pop(); l.items.push(v)
      LENGTH         -> push(Number(pop().items.length))
      ADD … GE, IN, EMPTY, NOT, AND, OR -> pop operands, push result
      JUMP a         -> f.pc = a (forward)
      LOOP a         -> f.pc = a (backward, only to a loop head; the loop's counter bounds it)
      JUMP_IF_FALSE a-> if not truthy(pop()): f.pc = a
      CALL g n       -> args = pop n; frames.push(Frame(g, args, path = f.path + g.path_part(args)))
      RETURN         -> v = pop(); frames.pop(); push(v)
      NATIVE g n     -> args = pop n; push(g(args)) ; a fault -> fault(g + ": " + message)
      PATH part      -> f.path_stack.push(part evaluated)    # list items: "representatives[2]"
      END_PATH       -> f.path_stack.pop()
      DEFAULT q      -> pending_default = pop()
      ASK q          -> key = f.path + q.key
                        v = answers[key] ; if absent: v = Empty
                        push(convert(v, q.type))            # "2026-11-07" -> Date, "yes" -> YesNo, …
                        steps.push({ q, key, default: pending_default, check: Empty })
                        pending_default = Empty
      CHECK q msg    -> if not truthy(pop()): steps.last.check = msg
      FILL b         -> writes[b] = { kind: fill, value: text_for_box(pop(), box b) }
      TICK b         -> writes[b] = { kind: tick, value: truthy(pop()) ? box b.on : "Off" }
      PICK b btn     -> if truthy(pop()): writes[b] = { kind: pick, value: btn }
      HALT           -> return { steps, writes }
  fault(message): stop; report message with the line from the line table at f.pc
```

## 11. The command line

```
stride compile f.stride [-o f.sbc]   -> phases 2–10; print mistakes; write bytecode if none
stride check f.stride                -> phases 2–9
stride run f answers.json            -> run(); print steps (key, type, answer) and writes
stride test f.stride                 -> for t in f.tests/*.json: { answers, boxes } ;
                                        run(); every expected box equals what was written, else print the
                                        box, expected, got; exit 1 if any failed
stride asm f                         -> instructions with their addresses and source lines
stride fmt f.stride                  -> parse, print the tree in the one layout, write back
stride version
```
