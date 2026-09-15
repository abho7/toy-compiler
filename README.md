# toy-compiler

A compiler for **minic**, a small imperative language: lexer, parser, type checker, an SSA
intermediate representation, optimization passes, register allocation, and a bytecode VM. Written
from scratch, no dependencies, no build step.

The point is not that it compiles. The point is that every optimization is *checked* to preserve
what the program does, against a reference interpreter, on a corpus and on randomly generated
programs — and that the places where an optimization would have been wrong are documented rather
than quietly fixed.

> **Status: phase 10 of 10 — the compiler runs in the browser, and the VM can be stepped.**
> [The playground](web/playground.html) imports the modules under `src/` directly — the same ones
> `node --test` runs against, with no build step and no bundler — and shows a program as tokens, a
> syntax tree, SSA, the IR after each pass with a line diff, live intervals with the register each
> value was given, and bytecode. It runs the program three independent ways and says whether they
> agree, and it steps the VM one instruction at a time with registers, frame slots, the call stack
> and output updating as they change.
>
> The stepper is **not a second interpreter**. `run` and `step` in `src/vm/vm.js` are the same
> switch: the loop state moved onto the instance and `run` became a loop over `step`, so the page
> cannot drift from the VM the tests measure. Checked both ways — stepping agrees with
> `runBytecode` on observation bytes *and* step count across all 23 corpus programs, and every
> benchmark count came out identical. The cost is a method call per instruction: about **1.2x**
> wall clock on the programs long enough to time, measured by running the old and new VM
> interleaved in one process rather than against a figure recorded on another day.
>
> Verified in a real browser rather than asserted: all eight panes render, and no console errors.
>
> The previous status, still true:
> **Phase 9 — the optimizer is measured, and most of it does not help.**
> Two benchmarks, kept apart because they answer different questions. Holding the passes fixed and
> varying register allocation: **47.6% fewer instructions executed**, and every frame-slot load and
> store gone. Holding allocation fixed and varying the passes: static code shrinks **15.4%**
> (1216 → 1029 instructions) while executed instructions fall **0.3%**.
>
> The per-program table is the honest one. **16 of the 23 corpus programs get exactly 0%** from the
> optimizer — including the two that dominate the total, `fib.mc` and `nqueens.mc`, which are
> 295k of the 312k instructions executed and are byte-identical before and after. The passes cut
> 48–54% from small straight-line programs and nothing at all from the hot ones, because none of
> the four optimizes across an iteration or a call: no loop-invariant code motion, no strength
> reduction, no unrolling, no inlining. Register allocation is where the dynamic win actually is.
>
> [The report](index.html) renders every one of those numbers out of
> [`golden/measurements.json`](golden/measurements.json) when it loads. None of them is typed into
> the page, and each table names the command that produced it.
>
> The previous status, still true:
> **Phase 8 — 100,000 random programs, and a harness proven able to fail.**
> Programs are generated well-typed by construction, run through the reference interpreter, the IR
> interpreter and the VM, unoptimized and fully optimized, and compared byte for byte: output, trap
> kind and source position, exit status. **100,000 programs, zero disagreements**, none skipped and
> none that failed to compile.
>
> That zero is worth exactly as much as the harness's ability to report a failure, so the optimizer
> was broken on purpose. `x + 1 → x` was caught within 4 programs; deleting constant folding's trap
> guard was caught within 40 and shrunk from 35 statements to
> `int main() { int v1 = (11 % 0); return 0; }`. Both injections were reverted, and
> [a test](test/fuzz.test.js) now does the same thing permanently without touching `src/`.
>
> The campaign found no compiler bug, and it cannot find every kind: recursion is never generated,
> so `stack_overflow` is covered only by the hand-written corpus. [The
> limits](docs/correctness.md#what-the-campaign-found) are written down.
>
> The previous status, still true:
> **Phase 7 — values live in registers, and the improvement is measured.**
> Linear-scan allocation replaced the deliberately naive slot-per-value code generator: across the
> corpus, **47.6% fewer instructions executed** and **every load and store to a frame slot gone**,
> against the same compiler with zero allocatable registers. The weakest case is 0% — `arith.mc`
> never had slot traffic to remove — and [the numbers](golden/measurements.json) say so.
>
> Peak register pressure is 11 against 13 allocatable, so nothing in the corpus spills. The spill
> path is therefore verified by squeezing the register file to 3, 1 and 0 and checking the
> generated programs still agree byte-for-byte with the reference interpreter, because code that
> never runs is code whose passing tests mean nothing.
>
> The previous status, still true:
> Four passes — constant folding, copy propagation, common subexpression elimination, dead code
> elimination — each checked for what it removes *and* what it refuses to remove. Every pass
> alone, and the whole pipeline, on every corpus program, through both the IR interpreter and the
> VM, byte for byte against the reference.
>
> The previous status, still true:
> Source becomes a syntax tree, the tree is checked, a reference interpreter written straight
> from [the semantics](docs/semantics.md) executes it, the tree is lowered to
> [SSA](docs/ir.md) over a control flow graph, and that becomes
> [bytecode](docs/bytecode.md) for a register machine built here. All three run all sixteen
> corpus programs and produce identical output, identical traps at identical source positions,
> and identical exit statuses. No optimization yet: the code generator is deliberately naive, so
> that the passes to come have an honest baseline to beat.

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
| 5 | bytecode ISA, code generation, VM | **done** |
| 6 | optimization passes and the edge cases they get wrong | **done** |
| 7 | linear-scan register allocation | **done** |
| 8 | random program generation, shrinking, long campaigns | **done** |
| 9 | benchmarks and the technical report | **done** |
| 10 | interactive playground | **done** |

## Running it

```bash
node --test                          # the test suite
node tools/mc.js corpus/vm.mc        # compile and run a program
node tools/mc.js --emit=ast prog.mc  # or --emit=tokens, --emit=ir, --emit=bytecode
node tools/mc.js --via-ir prog.mc    # run through the IR instead of the tree
node tools/mc.js --via-vm prog.mc    # run the bytecode on the VM
node tools/goldens.js                # every corpus program against its golden
node tools/fuzz.js                   # 1000 random programs, every way, compared
node tools/fuzz.js --programs=100000 # a long campaign
node tools/fuzz.js --thorough        # every pass alone as well as the pipeline
node tools/bench.js                  # what allocation bought, and what each pass buys
node tools/bench.js --write          # and record it in golden/measurements.json
node tools/pressure.js               # peak register pressure across the corpus
node tools/serve.js                  # the playground and report, at http://127.0.0.1:8099/
```

`tools/fuzz.js` exits non-zero when anything disagrees, so it works as a gate. A disagreement is
shrunk to a minimal reproducer and written to `failures/`, which is gitignored: a real one gets
promoted into `corpus/` or `test/` deliberately rather than committed by accident.

A program that exits cleanly gives its own status; a compile error gives 2, a trap gives 70, and
exhausting the step budget gives 71. The trailer on stderr says which, so a program returning 70
is still distinguishable from one that trapped.

Requires Node 24 or newer.

## Licence

MIT.
