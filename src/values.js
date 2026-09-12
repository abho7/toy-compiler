// Integer arithmetic, exactly as docs/semantics.md defines it.
//
// This module is the single place where a minic operator is evaluated. The
// reference interpreter, the IR interpreter, the VM and the constant folder all
// call these functions rather than reimplementing them, which is what makes
// constant folding correct by construction: folding is not "computing the same
// thing again at compile time", it is calling the very function the interpreter
// would have called, one phase earlier.
//
// The consequence worth stating: a bug in here is a bug in every one of them at
// once, and no differential test between them could ever find it. That is why
// this module is tested directly, exhaustively over the boundary values and
// randomly over the rest, rather than only through the programs that use it.

import { TRAP } from './traps.js';

export const INT_MIN = -2147483648;
export const INT_MAX = 2147483647;

/** Reduce to the signed 32-bit range, which is what every minic int does. */
export const wrap = (x) => x | 0;

/** A trap, as a result rather than an exception, so callers decide what to do. */
const trap = (kind) => ({ trap: kind });
const value = (v) => ({ value: v });

export const isTrap = (r) => r.trap !== undefined;

/**
 * Evaluate a binary operator.
 *
 * Returns `{ value }` or `{ trap }`. `&&` and `||` are deliberately absent:
 * docs/semantics.md makes them control flow, since the right operand may not be
 * evaluated at all, so they cannot be a function of two values.
 */
export function evalBinop(op, a, b) {
  switch (op) {
    // Wrapping is defined behaviour, so these are total.
    case '+': return value(wrap(a + b));
    case '-': return value(wrap(a - b));
    case '*': return value(Math.imul(a, b));

    // The only operators that can trap. Both trap on the same two conditions,
    // which is why INT_MIN % -1 traps even though its true result is 0.
    case '/':
      if (b === 0) return trap(TRAP.DIV_BY_ZERO);
      if (a === INT_MIN && b === -1) return trap(TRAP.DIV_OVERFLOW);
      return value(wrap(Math.trunc(a / b)));
    case '%':
      if (b === 0) return trap(TRAP.DIV_BY_ZERO);
      if (a === INT_MIN && b === -1) return trap(TRAP.DIV_OVERFLOW);
      return value(wrap(a % b));

    // JavaScript's shift operators already use only the low five bits of the
    // right operand and already sign-propagate on >>, which is the semantics
    // the document specifies.
    case '<<': return value(a << b);
    case '>>': return value(a >> b);

    case '&': return value(a & b);
    case '|': return value(a | b);
    case '^': return value(a ^ b);

    case '==': return value(a === b ? 1 : 0);
    case '!=': return value(a !== b ? 1 : 0);
    case '<': return value(a < b ? 1 : 0);
    case '<=': return value(a <= b ? 1 : 0);
    case '>': return value(a > b ? 1 : 0);
    case '>=': return value(a >= b ? 1 : 0);

    default: throw new Error(`not a binary operator: ${op}`);
  }
}

/** Evaluate a unary operator. None of them can trap. */
export function evalUnop(op, a) {
  switch (op) {
    case '-': return value(wrap(-a));   // -INT_MIN wraps back to INT_MIN
    case '~': return value(~a);
    case '!': return value(a === 0 ? 1 : 0);
    default: throw new Error(`not a unary operator: ${op}`);
  }
}

/** Every binary operator this module evaluates. */
export const BINOPS = Object.freeze([
  '+', '-', '*', '/', '%', '<<', '>>', '&', '|', '^', '==', '!=', '<', '<=', '>', '>=',
]);

export const UNOPS = Object.freeze(['-', '~', '!']);

/** Operators that can trap, and therefore cannot be folded away blindly. */
export const MAY_TRAP = Object.freeze(new Set(['/', '%']));

/**
 * The values where integer arithmetic goes wrong if it is going to.
 *
 * Used by the tests here and by the constant-folding tests: checking every
 * operator against every pair of these is a finite, exhaustive check of the
 * cases that are not merely representative but actually dangerous.
 */
export const BOUNDARY = Object.freeze([
  INT_MIN, INT_MIN + 1, -65536, -256, -2, -1, 0, 1, 2, 255, 256, 65535, 65536,
  INT_MAX - 1, INT_MAX,
]);
