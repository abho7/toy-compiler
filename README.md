# toy-compiler

A compiler for **minic**, a small imperative language: lexer, parser, type checker, an SSA
intermediate representation, optimization passes, register allocation, and a bytecode VM. Written
from scratch, no dependencies, no build step.

The point is not that it compiles. The point is that every optimization is *checked* to preserve
what the program does, against a reference interpreter, on a corpus and on randomly generated
programs — and that the places where an optimization would have been wrong are documented rather
than quietly fixed.

> **Status: phase 4 of 10 — there is an [intermediate representation](docs/ir.md), and two ways
> to run a program agree on every byte.**
> Source becomes a syntax tree, the tree is checked, and a reference interpreter written straight
> from [the semantics](docs/semantics.md) executes it. That tree is also lowered to SSA over a
> control flow graph, which a second interpreter runs. Both are compared on all sixteen corpus
> programs — same output, same trap kind at the same source position, same exit status. The
> optimization passes will join the same comparison.

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

One deliberate exception to "independent": all three evaluate every operator by calling the same
arithmetic kernel, `src/values.js`. That is what will make constant folding correct by
construction rather than by coincidence — folding is the interpreter's own evaluation, run one
phase earlier, not a second implementation that has to agree with it. The cost is that a bug in
that kernel would be a bug in all three at once, and no differential test between them could
ever find it, so it is tested directly instead: every operator over every pair of boundary
values, the division identity, and randomized sampling.

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
| 1 | lexer, parser, AST, diagnostics with source spans | **done** |
| 2 | semantic analysis: scopes, types, returns | **done** |
| 3 | reference AST interpreter, corpus, golden outputs | **done** |
| 4 | SSA IR, IR interpreter, IR validator | **done** |
| 5 | bytecode ISA, code generation, VM | not started |
| 6 | optimization passes and the edge cases they get wrong | not started |
| 7 | linear-scan register allocation | not started |
| 8 | random program generation, shrinking, long campaigns | not started |
| 9 | benchmarks and the technical report | not started |
| 10 | interactive playground | not started |

## Running it

```bash
node --test                          # the test suite
node tools/mc.js corpus/vm.mc        # compile and run a program
node tools/mc.js --emit=ast prog.mc  # or --emit=tokens, --emit=ir, to see a stage
node tools/mc.js --via-ir prog.mc    # run through the IR instead of the tree
node tools/goldens.js                # every corpus program against its golden
node tools/serve.js                  # the playground and report, at http://127.0.0.1:8099/
```

A program that exits cleanly gives its own status; a compile error gives 2, a trap gives 70, and
exhausting the step budget gives 71. The trailer on stderr says which, so a program returning 70
is still distinguishable from one that trapped.

Requires Node 24 or newer.

## Licence

MIT.
