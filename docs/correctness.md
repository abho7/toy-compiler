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
