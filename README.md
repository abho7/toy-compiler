# toy-compiler

A compiler for **minic**, a small imperative language: lexer, parser, type checker, an SSA
intermediate representation, optimization passes, register allocation, and a bytecode VM. Written
from scratch, no dependencies, no build step.

The point is not that it compiles. The point is that every optimization is *checked* to preserve
what the program does, against a reference interpreter, on a corpus and on randomly generated
programs — and that the places where an optimization would have been wrong are documented rather
than quietly fixed.

> **Status: phase 0 of 10 — the language is specified, no compiler yet.**
> [The language](docs/language.md) and [what it means](docs/semantics.md) are written down first,
> because every correctness argument later refers to them.

## Why a bytecode VM rather than native assembly

This machine has no assembler and no linker: `gcc`, `clang`, `cl`, `as`, `ld` and `nasm` are all
absent, and so is any emulator to run their output. Emitted x86-64 could therefore never be
assembled, executed or differentially tested here or in CI — it would be an artifact whose
correctness is asserted rather than checked, which is the one thing this project refuses to do.

So the target is a register-based bytecode VM, built here alongside the compiler. It keeps every
stage executable, keeps register allocation a real pass (a fixed 16-register file with real
spilling), and runs unmodified in the browser for the playground.

What that gives up, stated plainly: no instruction selection against a real ISA, no calling
convention or ABI work, and no hardware effects. The primary performance metric is therefore VM
instructions executed, which is machine-independent; wall-clock time is reported too, with
ranges, but it is the weaker number.

## The correctness standard

Three independent implementations of the semantics — a reference AST interpreter, an IR
interpreter, and the VM — must agree on the **observable behaviour** of every program: the exact
output bytes, the trap (kind and source location) or clean exit, and the exit status. Every
optimization pass must preserve all three, and this is checked by byte comparison across the
corpus, across every pass configuration, and across randomly generated programs, not by
inspection.

## Planned pipeline

```
source → lexer → parser → AST → sema (types, scopes) → typed AST
       → IR builder (SSA over a CFG) → IR → [constant folding, copy propagation,
         dead code elimination, common subexpression elimination] → IR
       → phi elimination → linear-scan register allocation → bytecode → VM
```

| phase | what it adds | state |
|---|---|---|
| 0 | language specification, scaffold, CI | **done** |
| 1 | lexer, parser, AST, diagnostics with source spans | not started |
| 2 | semantic analysis: scopes, types, returns | not started |
| 3 | reference AST interpreter, corpus, golden outputs | not started |
| 4 | SSA IR, IR interpreter, IR validator | not started |
| 5 | bytecode ISA, code generation, VM | not started |
| 6 | optimization passes and the edge cases they get wrong | not started |
| 7 | linear-scan register allocation | not started |
| 8 | random program generation, shrinking, long campaigns | not started |
| 9 | benchmarks and the technical report | not started |
| 10 | interactive playground | not started |

## Running it

```bash
node --test          # the test suite
node tools/serve.js  # the playground and report, at http://127.0.0.1:8099/
```

Requires Node 24 or newer.

## Licence

MIT.
