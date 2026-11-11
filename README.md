# Stride

Stride is a programming language for turning a fillable PDF form into a guided workflow: you write
which questions to ask and which box each answer goes in, and the person filling the form answers them one at a
time. The filled PDF downloads from the page; the original is never changed.

The compiler checks a program as any compiler does — spelling, names, types — and that each box it names is one
the form has. It is no stricter than the form itself.

```stride
form consent
pdf 40b82a8804e4bc4b946750dd7b2aca7bdccc4c14fbeb48ada3d91f8c6a125c76

ask full_name: string "Full name"
ask agrees: bool "I agree to the terms"
if agrees {
  fill "name" = full_name
}
tick "agree" when agrees
```

## Install

Linux x64 (including WSL2), with Node 22 or later:

```
npm install
node scripts/build.mjs
sh scripts/install.sh
stride version
```

`scripts/build.mjs` makes `dist/stride`, one executable with the compiler, the machine, the standard library, the
guides, the workflow page and the VS Code extension inside; `scripts/install.sh` copies it to `~/.local/bin` (or
`/usr/local/bin` as root). From the repository, `node bin/stride.mjs` is the same command.

## From a PDF to a workflow

```
stride new consent --pdf consent.pdf    # the form's header (consent.boxes.json), a program and a test
stride run consent.stride               # the workflow in your browser, beside the PDF; save and reload to see a change
stride test consent.stride              # the program on the sample answers in consent.tests/
stride compile consent.stride           # consent.sbc: everything a run needs but the PDF
stride run consent.sbc                  # the same workflow, with only consent.pdf beside it
```

`stride run consent.stride --terminal` runs it in the terminal instead, with answers as arguments, a file or
typed in turn. A file with no `form` line is a script, which runs in the terminal:

```
echo 'print("hello")' > hello.stride && stride run hello.stride
```

`stride help` lists every command; `stride guide` is the guide; `stride vscode` writes the VS Code extension.

## Using it from another program

`npm install github:khalidsaidi/stride#v1.0.0` gives:

| | |
|---|---|
| `@khalidsaidi/stride/compile` | `compile(source, name, options)`, `compileFile(path)`: mistakes and bytecode |
| `@khalidsaidi/stride/vm` | `load(bytes)`, `run(program, answers)`: the questions reached, the boxes written, the prints, a fault |
| `@khalidsaidi/stride/runner` | the workflow beside its PDF in a page: `workflow(bytes)`, `questions(p, host)` |
| `@khalidsaidi/stride/pdf-boxes` | `pageBoxes(bytes)`: a fillable PDF's boxes, as the PDF gives them |

## The language

- [docs/guide.md](docs/guide.md): how to write Stride; [docs/coming-from.md](docs/coming-from.md) for someone who
  knows Go, Java, JavaScript or Python.
- [docs/spec.md](docs/spec.md): the specification, the authority on what every construct means.
- [docs/grammar.md](docs/grammar.md): the short reference.

## Tests

`node scripts/selftest.mjs` runs the conformance suite in `tests/`: every rule of the specification has a test. `node scripts/journey.mjs` builds, installs into an empty home
and walks the whole path above with the installed command, the browser included.

## License

MIT: see [LICENSE](LICENSE).
