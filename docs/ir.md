# The intermediate representation

Three-address code in static single assignment form, over a control flow graph. It is what the
optimization passes rewrite and what the code generator reads, and it exists so that the compiler
never goes straight from a syntax tree to output — a pass that has to re-derive control flow from
nested statements is a pass that gets it wrong.

## Shape

A **module** is functions. A **function** is basic blocks, one of them the entry. A **block** is a
list of instructions ending in exactly one **terminator**. An instruction defines at most one
value, and *is* that value: there are no separate register names to keep in step with anything.
Values print as `%12`.

```
func main() -> int {
entry0:
  %2 = const 0
  %3 = alloc 4
  jump loop1
loop1:                    ; preds: entry0, step3
  %7 = phi [entry0 %2] [step3 %14]
  %8 = const 4
  %9 = < %7, %8
  branch %9 ? body2 : exit4
```

Every value is assigned exactly once. Where control flow joins and two definitions could arrive,
a **phi** names which value came from which predecessor. Phis are at the top of a block and all
read the incoming frame, so they take effect together: one phi in a block can never feed another
in the same block.

## Instructions

| instruction | meaning |
|---|---|
| `const n` | the integer `n` |
| `op a, b` | arithmetic, bitwise or comparison, where `op` is `+ - * / % << >> & \| ^ == != < <= > >=` |
| `op a` | unary `-`, `~` or `!` |
| `alloc n` | a fresh array of `n` zeroed elements |
| `load a[i]` | element `i` of array `a`, bounds checked |
| `store a[i], v` | write `v` into element `i`, bounds checked |
| `call f(...)` | call a function |
| `print v`, `putchar v` | the two builtins, the only output |
| `phi [b v] ...` | the value that arrived from each predecessor |
| `jump b` | terminator: go to `b` |
| `branch c ? b1 : b2` | terminator: go to `b1` when `c` is non-zero |
| `ret`, `ret v` | terminator: leave the function |

There is no instruction for `&&` or `||`. They are control flow — docs/semantics.md says the right
operand may not be evaluated at all — so they lower to a branch and a phi. Keeping them out of the
instruction set means no pass can treat them as ordinary operators by accident.

## Effects

Every pass asks one question about an instruction before moving, merging or deleting it: what
does it do besides producing a value? The answer is in `effects()` in `src/ir/ir.js`, and nowhere
else.

| flag | instructions | why a pass must care |
|---|---|---|
| `mayTrap` | `/` and `%`, `load`, `store`, `call` | removing it can remove a trap; hoisting it can add one |
| `readsMem` | `load`, `call` | cannot be moved across a write |
| `writesMem` | `store`, `call` | cannot be removed, reordered against reads, or duplicated |
| `writesOutput` | `print`, `putchar` | output is observable; these are never dead |
| `isCall` | `call` | a callee may do all of the above |
| `unique` | `alloc` | two allocations are different arrays even when identical |

Two of those deserve their reasons written down.

**`alloc` is unique, not pure.** It reads nothing and overwrites nothing, which is what "pure"
usually means, and value numbering would happily merge two `alloc 4`s into one. That would alias
two arrays the program keeps apart. `unique` says: never merge, even though nothing else about it
looks dangerous.

**`call` is assumed to do everything.** A callee may print, write through an array it was handed,
and trap. Phase 6 may add a purity analysis to sharpen this; until it exists, the conservative
answer is the correct one, and being conservative here is what makes CSE across calls safe by
default rather than by luck.

**Only `/` and `%` trap among the arithmetic.** That is what lets constant folding fold every
other operator unconditionally, and it is why folding a division needs the trap check that the
others do not.

## Bounds checks live inside `load` and `store`

An earlier design had a separate `bounds` instruction, so the check would be visible to passes in
its own right. It was dropped: a separate check has to stay adjacent to the access it guards, and
every pass that moves anything would have to maintain that invariant. Keeping the check inside the
access means the pair cannot be separated because it is not a pair. The cost is that eliminating a
redundant bounds check needs an analysis rather than falling out of common subexpression
elimination, and that trade is recorded here so the next person does not rediscover it.

## Construction

SSA is built directly, by the method in Braun et al., *Simple and Efficient Construction of Static
Single Assignment Form* (2013). Each block records what it knows about each variable; a read that
cannot be answered locally asks the predecessors; a block with several predecessors answers with a
phi. Blocks whose predecessors are not all known yet — loop headers — are left *unsealed*, and
their phis are completed when the back edge arrives. A phi whose operands are all the same value
is replaced by that value, so the phis that survive are the ones that were needed.

There is no dominance-frontier computation and no insert-then-prune pass. The dominator tree is
computed separately, in `src/ir/validate.js`, because the validator needs it.

### One bug worth remembering

Collapsing a trivial phi can happen *while an outer phi is still being filled*, since filling
operands reads the predecessors recursively. The first version of `replaceUses` rebuilt each
`incoming` and `args` array with `map()`, which swapped the array out from under the in-progress
fill and silently discarded the operands it had already pushed. Two array variables in
`corpus/vm.mc` ended up with phis that had **no operands at all** — values that came from nowhere.

The validator caught it, which is the argument for having one. Everything in `replaceUses` is now
edited in place, and `test/ir.test.js` keeps a program shaped like the one that failed.

## Checking

`validateFunc` runs after construction and after every pass. It checks block shape (exactly one
terminator, no terminator in the middle), that predecessor and successor lists agree, that every
block is reachable, that no value is defined twice, that types line up, that anything which can
trap carries a source span — and, the one that matters most, **dominance**: a definition must
dominate every use, and a phi operand must dominate the end of the predecessor it arrives from.

A pass that moves an instruction across a branch usually breaks exactly that, and breaks it
quietly: the IR still looks like a list of instructions, and an interpreter may even run it and
produce a plausible answer on the inputs that happen to be tested.
