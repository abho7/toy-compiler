# Why the optimizer does not change what a program does

Every pass here has to preserve *observable behaviour* exactly as
[the semantics](semantics.md) defines it: the output bytes, the trap — kind and source position —
or clean exit, and the exit status. Not "the same answers"; the same bytes.

This document is the argument for each pass, and the record of where each one declines to
optimize. The arguments are worth no more than the checks behind them, so both are here.

## How each pass is checked

| | |
|---|---|
| **Differential, corpus** | 23 programs × every pass alone × the pipeline × the pipeline twice, run through the IR interpreter and the VM, compared byte for byte against the reference interpreter |
| **Differential, three ways** | the reference interpreter, the IR interpreter and the VM must agree at every optimization level, so a pass cannot be "right for the IR but wrong once compiled" |
| **Structural** | the IR validator runs after every pass: dominance, phi operands matching predecessors, reachability, one terminator per block |
| **Unit** | each pass is tested for what it removes *and* what it refuses to remove |
| **Differential, random** | randomly generated programs × unoptimized × the full pipeline, through the IR interpreter and the VM, compared byte for byte against the reference; disagreements are shrunk to a minimal reproducer |
| **Fault injection** | the harness is required to *catch* a deliberately broken optimizer, because a comparison that has never reported a disagreement has not been shown capable of reporting one |

That last column is the one that earns its place, for a reason given below.

## Constant folding

**The argument.** Folding is evaluation, moved earlier. `2 * 3` is folded by calling the same
`evalBinop` in `src/values.js` that all three interpreters call at run time. There is no second
implementation of multiplication to drift from the first, so folding cannot compute a different
answer than running would have — it is the same function on the same operands.

**Where it declines.** `evalBinop` returns a *trap* rather than a value for `x / 0` and
`INT_MIN / -1`. A trap is observable, so an instruction that would trap is left exactly as it is:
`1 / 0` stays a division and traps at run time, at its original source position.

The identity simplifications are stated over every `int`, which is why `x * 0 → 0` is there and
`x / x → 1` is not: the first holds for all x, the second is wrong when x is zero, where the
program must trap instead.

**Checked by** folding every operator over every pair of boundary values — 16 operators × 15 × 15
— and asserting the folded constant equals what `evalBinop` returns, or that the instruction
survived when `evalBinop` returned a trap.

## Dead code elimination

**The argument.** An instruction may be removed when nothing reads its result *and* running it
changes nothing observable. The second half is the whole difficulty, and the IR answers it with
effect flags rather than with intuition: `isRemovableWhenUnused` is false for anything that traps,
writes memory, calls, or emits output.

**Where it declines.** A `load` whose result nobody reads still checks its bounds, so `a[5];` on a
three-element array still traps. A division nobody reads still divides by zero. A store nobody
reads still changes memory; a call may print. All of those stay.

An unused `alloc` *is* removed: nothing can observe an array whose handle no longer exists.

## Common subexpression elimination

**The argument.** Two instructions compute the same value when they have the same opcode and the
same operands — and in SSA, the same operands means the same definitions, so nothing has to be
proven about what a variable holds at the time. The later instruction is replaced by the earlier
one **only when the earlier one dominates it**, which means it already ran on every path that
reaches the later one.

That is also why this pass can merge instructions that trap. If `a / b` appears twice with the
same operands and the first dominates the second, then either the first trapped — and the second
never runs — or it did not, and neither would the second.

**Where it declines.**

- **Never hoists.** It only ever deletes a computation and points its uses at one that already
  ran. Moving `100 / n` out of `if (n != 0)` would introduce a trap in a program that has none;
  this pass cannot, because it never moves anything.
- **No load across a store, a call, or an allocation.** A load is merged only with an earlier load
  in the *same block* with nothing that disturbs memory in between. Merging across blocks would
  require proving no store happened on any path, which is an analysis this does not have. The
  blunt rule is the honest one.
- **Never merges two calls.** A callee may print, write through an array it was handed, or trap.
  Two identical calls are two events.
- **Never merges two allocations.** `alloc` is flagged `unique` in the IR for exactly this: two
  allocations of the same length are different arrays, and merging them would alias two variables
  the program keeps apart.

## Copy propagation

**The argument.** It removes a phi all of whose operands are the same value, replacing uses with
that value. A phi that merges one thing is not a claim about control flow, so removing it cannot
change one.

These do not exist when SSA construction finishes — the builder collapses them as it goes — but
folding creates them, by rewriting both arms of a branch to the same constant.

## Randomized differential testing

The corpus is twenty-three programs a person chose, which means it covers the cases that person
thought of. The campaign covers the ones nobody thought of.

`src/testing/random-program.js` generates programs that are **well typed by construction** —
scopes and types are tracked while building, so the generator never emits a program that fails to
compile, and a campaign never degenerates into a test of the parser's error recovery. Three
properties are structural rather than checked afterwards:

- **Termination.** Loops count to a constant bound *and their counter cannot be assigned to*;
  calls form a DAG, since a function may only call one defined before it. The first version
  guaranteed only the constant bound, and the generator duly emitted `i = (1 >> i)` inside a loop,
  pinning the counter below its bound forever: 16% of programs ran until the step budget stopped
  them, producing no comparable observation at all.
- **Bounded expression depth**, because the reference interpreter walks the tree recursively and a
  deeply nested expression exhausts the host stack before the language's own limits apply. That
  failure looks exactly like a mismatch and is not one.
- **Observable output.** Every function body and every loop body contains at least one `print` or
  `putchar`. Two programs that both produce nothing agree trivially.

**What the campaign compares.** `src/testing/differential.js` runs each program through the
reference interpreter and then through the IR interpreter and the VM at each optimization
configuration, comparing `observationBytes` — output, trap kind and position, exit status — as a
byte string. Three things are handled differently than in the corpus harness, and the reasons are
the interesting part:

- A generated program that **does not compile** is a bug in the generator, not the compiler, and is
  reported as such rather than counted as a disagreement.
- A program the reference cannot finish inside its budget is **skipped**. `docs/semantics.md` is
  explicit that the budget is a tooling limit and never a behaviour, so such a program has produced
  no observation and proves nothing either way.
- A program the reference *did* finish but an optimized build did not is a **disagreement**, not a
  skip. That is what a miscompilation into an infinite loop looks like, and it would otherwise be
  silently discarded.

### Shrinking

A failing generated program is typically sixty lines of noise around two that matter.
`src/testing/shrink.js` reduces it by proposing smaller programs — drop a function, drop a
statement, shrink a loop bound, replace an expression with one of its operands or with a constant,
empty an array initializer — keeping each only if it still fails. Two rules make it trustworthy:

- **A candidate that does not compile is rejected, not counted as a failure.** Most reductions
  produce one: removing a function that is still called, or the `return` a non-void function needs.
  A shrinker that accepted them would "minimise" every bug to a syntax error.
- **The predicate insists on the same disagreement, not any disagreement** — same configuration,
  same engine. Otherwise shrinking wanders onto whatever bug the reduced program happens to hit and
  reports a minimal reproducer for something else entirely.

### Proving the harness can fail

Zero disagreements is the result this whole apparatus is built to produce, and it is also exactly
what a harness that cannot see anything would produce. This project has twice shipped a green suite
that meant nothing, so the harness was checked by breaking the compiler on purpose:

| injected bug | caught within | shrunk to |
|---|---|---|
| `x + 1 → x` in the folder's identity simplifications | 4 programs | 19 statements → 3, 3 functions → 1 |
| the folder's trap guard removed, so `11 % 0` folds to `0` | 40 programs | 35 statements → 4, 21 statements → 2 |

The second is the hazard this document names as constant folding's central one, and the reproducer
the shrinker produced for it is the whole bug:

```c
int main() {
  int v1 = (11 % 0);
  return 0;
}
```

The first injection also produced a disagreement of the other kind — *"the ir exceeded its budget
on a program the reference finished in 336 steps"* — which is the infinite-loop case being caught
rather than skipped.

Both injections were reverted. What survives is `test/fuzz.test.js`, which does the same thing
permanently and without touching `src/`: it finds a generated program that divides by zero, rewrites
every division in the optimized IR to the constant `0`, and requires the harness to report a
mismatch — paired, in this project's habit, with the assertion that the same program agrees when
the compiler is left alone.

### What the campaign found

`node tools/fuzz.js --programs=100000 --seed=1`, two configurations per program — unoptimized and
the full pipeline — through both the IR interpreter and the VM:

| | |
|---|---|
| programs | 100,000 (seeds 1–100,000), 248.9s, ~400/s |
| **disagreements** | **0** |
| skipped (reference out of budget) | 0 |
| failed to compile | 0 |
| clean exit | 74,168 (74.2%) |
| `div_by_zero` | 14,636 (14.6%) |
| `out_of_bounds` | 11,036 (11.0%) |
| `div_overflow` | 160 (0.2%) |
| mean output | 99 bytes per program |

**It found no bug.** That is the result, and it is worth stating what it does and does not mean.
It does not mean the optimizer is correct; it means that across 100,000 programs the generator can
express, no pass changed observable behaviour. The fault injection above is what makes the zero
meaningful rather than vacuous — the same harness, on the same programs, reports a disagreement
within 4 programs when the folder is wrong.

The limits are the generator's, and they are real:

- **No recursion is generated**, because the call-DAG rule is half of what makes termination
  structural. `stack_overflow` is therefore exercised only by the hand-written corpus, and the
  campaign says nothing about it.
- **An array parameter is only ever indexed at `0`**, since the callee cannot know what length the
  caller passed. Interesting indices are exercised on local arrays only.
- Trapping is deliberately a minority outcome. A trap ends the program, so a generator that trapped
  eagerly would test the trap and nothing after it — at these rates a quarter of all programs still
  stop early, which is the cost paid for testing trap agreement at all.

## The failure this document exists to record

Value numbering originally identified an operand by which *instruction* produced it. Every literal
in the source becomes its own `const` instruction, so `a[0]` and `a[0]` had operands with
different ids, no two expressions ever matched, and **the pass removed zero instructions on all 23
corpus programs**.

Everything was green. The differential harness agreed at every optimization level, because a pass
that does nothing preserves behaviour perfectly. Worse, the programs written specifically to
constrain this pass — a load across a store, a load across a call — passed while proving nothing,
since no load was ever a candidate for reuse in the first place.

Fixing the keying so a constant identifies by value took CSE from 0 to 308 instructions removed
across the corpus. The lesson is in the test suite now: every pass must be shown to *fire*
somewhere in the corpus, and every "it refuses to do X" test is paired with an "it does do Y"
test. An optimizer that does nothing is indistinguishable from a correct one under a harness that
only checks output.

This is the second time in this project that a green suite meant nothing. The first was the
parallel-copy cycle breaker in phase 5, which was unreachable code: the whole corpus passed
because no corpus program exchanged two variables. Both were found by asking what a pass should be
*doing* rather than whether the output still matched.
