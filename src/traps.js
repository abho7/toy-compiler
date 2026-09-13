// The trap kinds, which are part of observable behaviour.
//
// A trap aborts the program and names why. Every kind here is defined in
// docs/semantics.md, and test/docs.test.js fails if the two ever disagree --
// the document is what the optimizer's correctness arguments refer to, so a
// kind that exists only in code would be a claim nothing checks.
//
// Optimization passes may not introduce, remove, reorder or re-kind a trap.

export const TRAP = Object.freeze({
  DIV_BY_ZERO: 'div_by_zero',
  DIV_OVERFLOW: 'div_overflow',
  OUT_OF_BOUNDS: 'out_of_bounds',
  STACK_OVERFLOW: 'stack_overflow',
});

/** Every trap kind, in declaration order. */
export const TRAP_KINDS = Object.freeze(Object.values(TRAP));

/**
 * Call depth at which a further call raises STACK_OVERFLOW.
 *
 * Deliberately small. Every implementation of the semantics has to reach this
 * limit and trap at exactly it -- including the tree-walking reference
 * interpreter, which spends several host stack frames per minic call and runs
 * inside a browser tab in the playground. A larger limit is unreachable there,
 * and an interpreter that died of host stack exhaustion before the language's
 * own limit would disagree with the VM about a program's observable behaviour,
 * which is precisely what the oracle exists to rule out.
 */
export const MAX_CALL_DEPTH = 1000;

/**
 * A trap, as produced by any of the three interpreters.
 *
 * `span` is the source range responsible, kept because the kind alone is not
 * the whole of the observable behaviour: moving a trap to a different
 * expression changes what the program reports.
 */
export class Trap {
  constructor(kind, span, detail = null) {
    if (!TRAP_KINDS.includes(kind)) throw new Error(`unknown trap kind: ${kind}`);
    this.kind = kind;
    this.span = span;
    this.detail = detail;
  }

  /** The one-line form used by the CLI, the harness and the golden files. */
  toString() {
    const where = this.span ? ` at ${this.span.line}:${this.span.col}` : '';
    return `trap: ${this.kind}${where}${this.detail ? ` (${this.detail})` : ''}`;
  }
}
