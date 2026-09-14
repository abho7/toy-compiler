// Dead code elimination.
//
// An instruction is dead when nothing reads its result *and* running it makes
// no difference to what the program does. The second half is where this pass
// is usually wrong, and the whole design of the IR's effect flags exists to
// make it answerable:
//
//   A load whose result nobody reads still checks its bounds, so `a[5];` on a
//   three-element array must still trap. A division nobody reads still divides
//   by zero. Both carry mayTrap, and mayTrap means "not dead".
//
//   A store nobody reads still changes memory. A call nobody reads may print.
//   print and putchar are the output, which is the whole of what a program is
//   for.
//
// So the rule is not "unused means removable" but `isRemovableWhenUnused`, in
// src/ir/ir.js, which is false for anything that traps, writes, calls or emits.
// An unused `alloc` is removable: it has no effect anyone can observe, since
// nothing can read an array whose handle is gone.

import { isRemovableWhenUnused } from '../ir/ir.js';
import { removeInstr, removeUnreachableBlocks } from './rewrite.js';

/**
 * Mark and sweep over the operand graph.
 *
 * The roots are terminators and every instruction whose execution is itself
 * observable. Everything those reach transitively is live; the rest is not.
 */
export function eliminateDeadCode(func) {
  let removed = removeUnreachableBlocks(func);

  const live = new Set();
  const worklist = [];

  const markValue = (value) => {
    if (!value || value.op === 'param' || live.has(value)) return;
    live.add(value);
    worklist.push(value);
  };

  for (const block of func.blocks) {
    if (block.term) {
      live.add(block.term);
      worklist.push(block.term);
    }
    for (const instr of block.instrs) {
      if (!isRemovableWhenUnused(instr)) markValue(instr);
    }
  }

  while (worklist.length) {
    const instr = worklist.pop();
    for (const arg of instr.args) markValue(arg);
    if (instr.incoming) for (const [, value] of instr.incoming) markValue(value);
  }

  for (const block of func.blocks) {
    for (const instr of [...block.instrs]) {
      if (live.has(instr)) continue;
      removeInstr(instr);
      removed++;
    }
    for (const phi of [...block.phis]) {
      if (live.has(phi)) continue;
      removeInstr(phi);
      removed++;
    }
  }

  return removed;
}

export function dce(module) {
  let removed = 0;
  for (const func of module.funcs.values()) removed += eliminateDeadCode(func);
  return removed;
}
