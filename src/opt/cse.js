// Common subexpression elimination, by value numbering over the dominator tree.
//
// Two instructions compute the same thing when they have the same opcode and
// the same operands -- in SSA, "the same operands" means the same definitions,
// so nothing has to be proved about what is in a variable at the time. The
// later one is replaced by the earlier, provided the earlier one dominates it.
//
// That proviso does all the work, and it is the reason this pass never hoists
// anything. It only ever deletes a computation and points its uses at one that
// already ran on every path reaching it. Three consequences worth stating,
// because each is a way CSE is usually wrong:
//
//   Trapping instructions are safe to merge. If `a / b` appears twice with the
//   same operands and the first dominates the second, then either the first
//   trapped -- and the second never runs -- or it did not, and neither would
//   the second. What would be wrong is *hoisting* a division to somewhere it
//   did not run before, which is what happens if a pass moves `a / n` out of
//   `if (n != 0)`. This pass cannot do that, because it only removes.
//
//   Loads may not be merged across anything that writes memory. Two `load a[i]`
//   with a store between them read different values. The rule here is
//   deliberately blunt: a load is only ever merged with an earlier load in the
//   *same block* with no store, call, or alloc between them. Merging across
//   blocks would need to prove that no store happened on any path, which is an
//   analysis this does not have.
//
//   Calls are never merged. A callee may print, write through an array, or
//   trap; two calls that look identical are two different events.

import { effects } from '../ir/ir.js';
import { dominators, dominates } from '../ir/validate.js';
import { replaceAllUses, removeInstr } from './rewrite.js';

/** Instructions that may be looked up by value. */
function isCandidate(instr) {
  const e = effects(instr);
  if (e.isCall || e.writesMem || e.writesOutput || e.unique) return false;
  return instr.op === 'binop' || instr.op === 'unop' || instr.op === 'load'
    || instr.op === 'const';
}

/**
 * How an operand identifies itself for value numbering.
 *
 * A constant identifies by its value, not by which instruction produced it.
 * Without that this pass cannot fire at all in a real program: every literal in
 * the source becomes its own `const` instruction, so `a[0]` and `a[0]` have
 * operands with different ids and never match. That was not a hypothetical --
 * it reported zero changes on all 23 corpus programs, and the tests written to
 * prove it refuses to reuse a load across a store were passing vacuously,
 * because no load was ever a candidate for reuse.
 */
function operandKey(value) {
  return value.op === 'const' ? `c${value.imm}` : `v${value.id}`;
}

/** A key that is equal exactly when two instructions compute the same value. */
function keyOf(instr) {
  return `${instr.op}:${instr.imm ?? ''}:${instr.args.map(operandKey).join(',')}`;
}

/** Does anything between `from` and `to` in this block disturb memory? */
function memoryClobberedBetween(block, from, to) {
  const start = block.instrs.indexOf(from);
  const end = block.instrs.indexOf(to);
  for (let i = start + 1; i < end; i++) {
    const e = effects(block.instrs[i]);
    if (e.writesMem || e.isCall || e.unique) return true;
  }
  return false;
}

export function eliminateCommonSubexpressions(func) {
  const idom = dominators(func);
  // Every candidate seen so far, by value key. Several instructions can share
  // a key when neither dominates the other, so each key keeps a list.
  const seen = new Map();
  let removed = 0;

  for (const block of func.reversePostorder()) {
    for (const instr of [...block.instrs]) {
      if (!isCandidate(instr)) continue;

      const key = keyOf(instr);
      const earlier = seen.get(key) ?? [];

      const usable = earlier.find((candidate) => {
        if (!candidate.block) return false;                    // already removed
        if (candidate.block === block) {
          // Same block: the earlier one runs first by position.
          if (block.instrs.indexOf(candidate) >= block.instrs.indexOf(instr)) return false;
        } else if (!dominates(idom, candidate.block, block)) {
          return false;
        }
        if (instr.op === 'load') {
          // Only within one block, and only with nothing writing memory in
          // between. Across blocks there is no path information here.
          if (candidate.block !== block) return false;
          if (memoryClobberedBetween(block, candidate, instr)) return false;
        }
        return true;
      });

      if (usable) {
        replaceAllUses(func, instr, usable);
        removeInstr(instr);
        removed++;
        continue;
      }

      earlier.push(instr);
      seen.set(key, earlier);
    }
  }

  return removed;
}

export function cse(module) {
  let removed = 0;
  for (const func of module.funcs.values()) removed += eliminateCommonSubexpressions(func);
  return removed;
}
