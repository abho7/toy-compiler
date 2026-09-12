# minic semantics

This document defines what a minic program *means*. It is written before the compiler, and every
correctness claim in this project refers back to it: the reference interpreter implements this
document, and an optimization pass is correct exactly when it preserves the observable behaviour
defined in [Observable behaviour](#observable-behaviour) for every program.

There is **no undefined behaviour**. Every operation either produces a value or produces a named
trap. That is a deliberate design choice: an optimizer can only be proven to preserve behaviour
that is defined, and "this program is allowed to do anything" would make the differential testing
harness meaningless.

## Values

| type | values |
|---|---|
| `int` | 32-bit two's-complement integers, -2147483648 to 2147483647 |
| `int[]` | a reference to a fixed-length, contiguous run of `int`, carrying its length |
| `void` | no value; the result type of a function that returns nothing |

`int` arithmetic **wraps** on overflow: the result is the mathematically exact result reduced
modulo 2^32 into the signed range. `2147483647 + 1` is `-2147483648`, and that is defined, not a
trap. Wrapping is chosen over trapping because it makes constant folding total for `+`, `-`, `*`
— the folder can evaluate them at compile time without having to reason about whether the
runtime would have trapped.

Variables declared without an initializer are `0`. Array elements not covered by an initializer
are `0`. Nothing is ever uninitialized.

## Traps

A trap aborts the program immediately. It is observable: it names a kind and the source span
responsible, and it is part of what an optimization must preserve. A pass may not introduce a
trap, remove a trap, change a trap's kind, or change which trap happens first.

| kind | raised when |
|---|---|
| `div_by_zero` | the right operand of `/` or `%` is `0` |
| `div_overflow` | `INT_MIN / -1` or `INT_MIN % -1`, whose true result is not representable |
| `out_of_bounds` | an array index `i` with `i < 0` or `i >= length` |
| `stack_overflow` | a call is made at call depth 10000 |

`INT_MIN % -1` is mathematically `0`, so trapping is a choice rather than a necessity. It is
made so that `/` and `%` have identical trap conditions, which is one fewer special case in every
pass that reasons about them.

## Expressions

Operands are evaluated **strictly left to right**, and every sub-expression is evaluated exactly
once, except where short-circuiting says otherwise. This is fixed so that the order of two traps
in one expression is determined: in `a[i] / b[j]`, if both indices are out of range, the trap
from `a[i]` is the one observed.

### Arithmetic and bitwise

`+ - *` wrap. Unary `-` wraps (`-INT_MIN` is `INT_MIN`). `~x` is `-x - 1`.

`/` truncates toward zero: `7 / 2 == 3`, `-7 / 2 == -3`. `%` takes the sign of the dividend and
satisfies `(a / b) * b + (a % b) == a` whenever neither traps: `-7 % 2 == -1`, `7 % -2 == 1`.
Both trap on a zero divisor and on `INT_MIN` with `-1`.

`<<` and `>>` use only the low five bits of the right operand, so the shift distance is always
0-31 and no shift traps; `x << 32` is `x`. `>>` is arithmetic: it propagates the sign bit.
`& | ^` are bitwise on the two's-complement representation.

### Comparison and logic

`== != < <= > >=` compare two `int`s and yield `1` for true and `0` for false — a value, not a
distinct boolean type.

`!x` is `1` when `x == 0`, otherwise `0`.

`a && b` evaluates `a`; if it is `0` the result is `0` and **`b` is not evaluated at all**,
including any trap or side effect it would have caused. Otherwise the result is `b != 0 ? 1 : 0`.
`a || b` mirrors it: if `a != 0` the result is `1` and `b` is not evaluated.

### Array access

`a[i]` evaluates `i`, checks `0 <= i < length(a)` and traps `out_of_bounds` if it fails, then
loads the element.

The assignment `a[i] = e` evaluates `i`, then evaluates `e`, then performs the bounds check, then
stores. The order matters and is fixed: if `i` is out of range and evaluating `e` also traps, the
trap from `e` is the one observed, because `e` runs first.

### Calls

Arguments are evaluated left to right, then the call is made. `int[]` parameters are passed by
reference: the callee sees the caller's array, and writes through it are visible to the caller.
`int` parameters are passed by value. Recursion, including mutual recursion, is allowed.

## Statements

Blocks introduce a lexical scope. A declaration is visible from its declaration to the end of its
enclosing block, and may shadow an outer declaration. Scoping is entirely static.

`if (c) s` executes `s` when `c != 0`. `while (c) s` and `for (init; c; step) s` loop while
`c != 0`; an omitted `for` condition means `1`. `break` leaves the innermost enclosing loop;
`continue` proceeds to its next iteration, which for `for` means running `step` first.

`return e;` returns from the enclosing function with `e`; `return;` returns from a `void`
function. Every path through a non-`void` function must return — this is checked statically, so
"falling off the end" is a compile error rather than a runtime question.

## Program start and finish

A program is a set of function declarations. It must declare `int main()`, which is where
execution begins. Programs take no input, so a program's behaviour is a function of its source
alone, which is what makes differential testing possible at all.

The exit status is `main`'s return value reduced modulo 256 into 0-255, as on POSIX. A program
that traps has no exit status; it has a trap.

### Output

| builtin | effect |
|---|---|
| `print(x)` | appends the decimal representation of `x`, then a `\n` (0x0A), to the output |
| `putchar(x)` | appends the single byte `((x % 256) + 256) % 256` to the output |

Output is a byte stream, not a character stream: `putchar` is how a program emits text, and no
encoding is imposed on it.

## Observable behaviour

The observable behaviour of a program is exactly this triple:

1. the **output bytes** produced before it finished,
2. the **outcome**: either a clean exit or a trap of a particular kind at a particular source
   span,
3. the **exit status**, when it exited cleanly.

Two programs behave identically when all three match exactly. Every optimization pass in this
project must preserve all three, for every program, and the differential harness checks it by
byte comparison rather than by inspection.

Execution time, instruction counts, memory use and register assignments are deliberately *not*
observable: they are what the optimizer is allowed to change.

### Implementation limits, which are not program behaviour

The tooling imposes a step budget so that a runaway program fails a test rather than hanging a
test run. Exhausting it is a *harness* outcome, reported as such, and never reported as a trap or
as a clean exit — a program whose behaviour is "does not terminate" is outside what this project
claims to optimize correctly, and is excluded from the corpus rather than quietly counted as
agreeing.
