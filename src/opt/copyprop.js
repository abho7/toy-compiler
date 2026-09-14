// Copy propagation.
//
// In this IR a "copy" is a phi that no longer merges anything: every operand is
// the same value, so the phi says only "whichever way you came, it was that".
// Those do not exist when the builder finishes -- it collapses them as it goes
// -- but they appear afterwards, when folding rewrites both arms of a branch to
// the same constant, or when removing an edge leaves a phi with one operand
// that some other phi still refers to.
//
// Left in place they are harmless to correctness and costly to everything else:
// every later pass walks them, the code generator gives each one a slot and
// emits copies on every incoming edge, and the printed IR gets harder to read.

import { replaceAllUses, removeInstr } from './rewrite.js';

/** The value a phi is equal to, or null when it genuinely merges two things. */
function trivialOperand(phi) {
  let same = null;
  for (const [, value] of phi.incoming) {
    if (value === phi || value === same) continue;   // self-reference: a loop
    if (same !== null) return null;
    same = value;
  }
  return same;
}

export function propagateCopies(func) {
  let removed = 0;
  let changed = true;

  // Collapsing one phi can make another trivial, so this runs to a fixed point
  // rather than once over the list.
  while (changed) {
    changed = false;
    for (const block of func.blocks) {
      for (const phi of [...block.phis]) {
        const value = trivialOperand(phi);
        if (value === null || value === phi) continue;
        replaceAllUses(func, phi, value);
        removeInstr(phi);
        removed++;
        changed = true;
      }
    }
  }

  return removed;
}

export function copyprop(module) {
  let removed = 0;
  for (const func of module.funcs.values()) removed += propagateCopies(func);
  return removed;
}
