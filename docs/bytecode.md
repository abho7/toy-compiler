# The bytecode and the virtual machine

The compiler's output, and the machine that runs it. [Why a VM rather than native
assembly](../README.md#why-a-bytecode-vm-rather-than-native-assembly) is in the README; this is
what the machine is.

## Shape

Four `int32` per instruction — opcode and three operands — in one flat `Int32Array` per function.
Fixed width costs space and buys two things: a jump target is an instruction index rather than a
byte offset that has to be computed while emitting, and a disassembler cannot lose sync with the
encoder.

Each function carries a **span per instruction**, so a trap can report the source position it came
from. That is not debugging decoration: `docs/semantics.md` makes a trap's location part of
observable behaviour, so the spans are load-bearing and the differential harness compares them.

## Storage

| | |
|---|---|
| **registers** | 16 per frame, `r0`–`r15`. Scratch: nothing survives an instruction that does not write it. `r15` is reserved for breaking copy cycles. |
| **slots** | the frame's own storage, `s0` upward. As many as the function needs. |
| **heap** | arrays, referred to by an integer handle, so every register holds an `int32` and nothing else. |

Parameters arrive in `r0` upward and are stored into slots `s0` upward on entry. A call leaves its
result in `r0`, which the caller stores wherever it wants it. At most 15 arguments, since `r15` is
the scratch register; the code generator reports that rather than emitting something wrong.

The heap never frees. Arrays accumulate for the life of a run, which is fine at corpus scale and
is written down here rather than discovered later.

## Instructions

| instruction | effect |
|---|---|
| `const rd, n` | `rd = n` |
| `move rd, rs` | `rd = rs` |
| `ldslot rd, s` | `rd = slot s` |
| `stslot s, rs` | `slot s = rs` |
| `add/sub/mul/div/mod rd, ra, rb` | arithmetic; `div` and `mod` can trap |
| `shl/shr/and/or/xor rd, ra, rb` | bitwise; shift counts use the low five bits |
| `eq/ne/lt/le/gt/ge rd, ra, rb` | comparison, yielding 1 or 0 |
| `neg/not/bnot rd, ra` | unary `-`, `!`, `~` |
| `alloc rd, n` | a fresh zeroed array of `n`; `rd` is its handle |
| `load rd, ra[ri]` | element, bounds checked |
| `store ra[ri], rv` | write, bounds checked |
| `print rs`, `putchar rs` | the only output |
| `call rd, f, n` | call function `f` with `n` arguments from `r0`; result to `rd` |
| `ret rs`, `retvoid` | leave the function |
| `jmp @t` | go to instruction `t` |
| `brz rs, @t` | go to `t` when `rs` is zero |

## Where the arithmetic comes from

`div` and `mod` call `evalBinop` in `src/values.js` — the same function the two interpreters and
the constant folder use. Truncation toward zero, `INT_MIN / -1`, and the sign of a remainder are
the parts worth having in exactly one place.

The rest is inlined in the VM loop, because JavaScript's operators on `int32` already are the
semantics the document specifies, and routing every addition through a function that returns an
object would make the benchmark numbers measure the wrapper. That is a deliberate duplication, so
it is checked rather than trusted: `test/vm.test.js` runs **every inlined opcode against
`evalBinop` over every pair of boundary values**, which is a finite exhaustive comparison of the
cases where the two could differ.

## Calls, and the depth limit

The VM is a loop over an explicit frame stack, not host recursion. So the call depth the language
specifies is the depth the VM enforces — exactly, on every host.

That matters more than it sounds. The reference interpreter's limit had to be lowered to something
a tree-walker could reach ([why](semantics.md#traps)). If the VM disagreed by even one frame, a
deeply recursive program would behave differently here than under the oracle, and the differential
harness would be comparing two languages rather than two implementations of one.

## How code is generated, and why it is bad on purpose

Phase 5's code generator is the simplest thing that is obviously correct: **every SSA value gets a
slot of its own**, and every instruction loads its operands into registers, computes, and stores
the result straight back. No value is ever in two places, so no allocation decision can be wrong.

It was also slow — a three-operand addition cost a load, a load, an add and a store. That was the
point: a baseline nobody has to take on faith. Phase 7 replaced the slot-per-value assignment with
linear-scan register allocation, and the improvement is measured rather than asserted.

### What it bought

`node tools/bench.js` compares the compiler against itself with zero allocatable registers — every
value in a frame slot, loaded and stored around every instruction. Same IR, same optimizer on both
sides; the only difference is whether values may live in registers. Over the whole corpus:

| | every value in memory | allocated |
|---|---|---|
| static instructions | 1679 | 1033 (**38.5% fewer**) |
| instructions executed | 594,474 | 311,815 (**47.5% fewer**) |
| loads and stores to frame slots | 767 | **0** |

Best case `binary-search.mc` at 55%. **Weakest case `arith.mc` at 0%** — its peak pressure is 1, so
even the in-memory build barely touched a slot and allocation had nothing to take away. A pass that
does nothing for a whole class of programs is worth saying out loud.

Slot traffic reaching zero is the honest headline and also the limit of the result: peak pressure
is 11 against 13 allocatable registers, so every value fits and none has to be spilled.

#### A historical figure, measured differently

Against the *actual phase 5 generator* (commit `5e6d35a`, extracted with
`git show 5e6d35a:src/backend/codegen.js` and run side by side), the same corpus went from 2033 to
1029 static instructions and 671,214 to 311,533 executed — 49.4% and 53.6%.

Those were measured before the void-interval fix described below, which moved the current
generator to 1033 and 311,815. They are left as they were taken rather than half-updated: the
"before" side came from a generator that no longer exists, and re-deriving one end of a comparison
from a different build is how two measurements quietly become one wrong one.

Those numbers are larger than the table above and measure something slightly different, which is
why they are kept apart rather than averaged in. The phase 5 generator emitted a `const` *and* a
store for every constant definition; the current one materialises constants at each use and emits
nothing at the definition site. So the zero-register baseline is leaner than phase 5 actually was,
and the smaller cut is the more conservative claim. It is also the reproducible one.

### What allocation can and cannot show at this size

Three of the sixteen registers are withheld: generated code needs somewhere to hold a spilled
operand while it computes, and a `store` whose array, index and value are all in slots needs three
at once. The registers a function's own parameters arrive in are withheld too, which turns moving
them to their allocated homes from a parallel copy into a plain ordered one. That leaves thirteen
to allocate, fewer in a function that takes parameters or makes calls.

Measured across the corpus with `node tools/pressure.js`: the most values live at any one point in
any function is **11**, in `vm.mc:main`, and the median function needs **3**. Nothing spills.

#### Void instructions were given registers they never used

Something the playground made visible, having been invisible in a table of totals: `liveIntervals`
gave an interval to *every* instruction in a block, including the ones that define no value. A
`store` or a `putchar` got a live interval and was assigned a register it had no result to put in.

That was why `arith.mc` was recorded as 23 values at a peak pressure of **1** and yet **13
registers used**. It was never a correctness problem — the allocation stayed valid, nothing else
was given those registers while they were held, and the differential was unaffected — but it wasted
the register file on exactly the functions where pressure might otherwise have mattered, and a
`registersUsed` figure read without the caveat overstated how close the allocator came to running
out.

`liveIntervals` now skips values whose type is `void`, alongside the constants it already skipped.
Across the corpus that takes **registers used from 254 to 172**. `arith.mc` goes from 13 to **0**
— it reserves nothing at all now — and `opt-foldable.mc` from 7 to 0, `short-circuit.mc` from 9 to
0, `strings.mc` from 35 to 23. Peak pressure is unchanged at 11, because void instructions were
rarely what set the peak; what they consumed was headroom.

**It is not a free win, and the benchmark says so.** Two programs emit *more* code than before:
`sort-quick.mc` goes from 106 static instructions to 108 and `vm.mc` from 250 to 252. Both
differences are entirely `move` instructions at phi edges — corpus-wide moves go 117 to 121, which
is exactly the change in static size — because a shorter interval list hands the linear scan a
different free-register order, and two functions land on assignments needing two extra edge copies
each. Executed instructions rise 311,533 to 311,815, all of it from those two programs. Every other
corpus program compiles to byte-identical code.

So the trade is 82 fewer reserved registers against 4 more `move`s. Worth taking, since the
headroom is what decides whether a larger program spills, but it is a trade rather than a
straight improvement. It also means the 0.2% cut previously attributed to common subexpression
elimination was mostly assignment churn of this same kind: with the fix in, CSE joins copy
propagation and dead code elimination in the benchmark's list of configurations that change the IR
without reducing the work the VM does.

That is worth stating plainly rather than leaving implied. Linear scan's interesting decision —
which value to evict when registers run out — **never happens on this corpus**. The win here is the
load/store traffic that stops, not clever spilling, and a benchmark that implied otherwise would be
overselling. The eviction path is real and verified, but it is verified by squeezing the register
file down to 8, 4, 2 and 1 in `test/regalloc.test.js`, because code that never runs is code whose
green tests mean nothing — a lesson this project has now learned twice.

Before code generation, two things happen to the IR (`src/backend/linearize.js`):

**Critical edges are split.** An edge from a block with several successors into a block with
several predecessors has nowhere to put the copies a phi needs: the predecessor runs them on paths
that do not take the edge, and the successor runs them for the wrong predecessor. A new block on
the edge is the place that does exist.

**Phis become copies.** A phi is a claim about which value arrived from which predecessor, which
on each edge is a set of copies performed *simultaneously*. A cycle among them — `x` from `y` and
`y` from `x` — cannot be sequenced naively without destroying one of the values, so one source is
parked in a temporary first. Getting this wrong produces a program that is correct until two
variables happen to exchange values, which is why `test/vm.test.js` exercises a swap and a
three-way rotation across a loop back edge.
