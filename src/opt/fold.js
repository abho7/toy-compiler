// Constant folding, and the algebraic simplifications that come with it.
//
// This is the pass the project's correctness argument leans on hardest, so it
// is built to be correct by construction rather than by inspection:
//
//   Folding is evaluation, run early. The value of `2 * 3` at compile time is
//   computed by calling the same evalBinop that all three interpreters call at
//   run time. There is no second implementation of multiplication here to drift
//   from the first, and no table of "what these operators do" to get wrong.
//
//   Nothing that traps is ever folded away. evalBinop returns a trap instead of
//   a value for `x / 0` and `INT_MIN / -1`, and a trap is observable behaviour:
//   a program that divides by zero must still divide by zero. Those
//   instructions are left exactly as they are.
//
// A folded instruction is rewritten in place into a `const`, so every use keeps
// pointing at the same instruction and no use has to be updated. The
// simplifications that replace an instruction with one of its operands -- x + 0
// is x -- do have to rewrite uses, and go through src/opt/rewrite.js.

import { evalBinop, evalUnop, isTrap } from '../values.js';
import { replaceAllUses, removeInstr, replaceBranchWithJump, removeUnreachableBlocks } from './rewrite.js';

const isConst = (value) => value?.op === 'const';

/** Turn an instruction into the constant `n`, keeping its identity and span. */
function becomeConst(instr, n) {
  instr.op = 'const';
  instr.imm = n | 0;
  instr.args = [];
  instr.incoming = null;
}

/**
 * Simplifications that need no constant on both sides.
 *
 * Each returns the value the instruction is equal to, or null. They are stated
 * as identities over every int, which is why `x * 0` is here and `x / x` is
 * not: the first is zero for all x, the second traps when x is zero.
 */
function simplify(instr) {
  const [a, b] = instr.args;
  const op = instr.imm;
  const zero = (v) => isConst(v) && v.imm === 0;
  const one = (v) => isConst(v) && v.imm === 1;

  switch (op) {
    case '+': return zero(b) ? a : (zero(a) ? b : null);
    case '-':
      if (zero(b)) return a;
      if (a === b) return { constant: 0 };
      return null;
    case '*':
      if (one(b)) return a;
      if (one(a)) return b;
      if (zero(a) || zero(b)) return { constant: 0 };
      return null;
    case '/': return one(b) ? a : null;          // never x / x: x may be zero
    case '%': return one(b) ? { constant: 0 } : null;
    case '&':
      if (zero(a) || zero(b)) return { constant: 0 };
      return a === b ? a : null;
    case '|':
      if (zero(b)) return a;
      if (zero(a)) return b;
      return a === b ? a : null;
    case '^': return a === b ? { constant: 0 } : (zero(b) ? a : (zero(a) ? b : null));
    case '<<': case '>>': return zero(b) ? a : null;
    case '==': case '<=': case '>=': return a === b ? { constant: 1 } : null;
    case '!=': case '<': case '>': return a === b ? { constant: 0 } : null;
    default: return null;
  }
}

/** Fold one function. Returns how many instructions it changed. */
export function foldConstants(func) {
  let changed = 0;

  for (const block of func.blocks) {
    for (const instr of [...block.instrs]) {
      if (instr.op === 'binop') {
        const [a, b] = instr.args;

        if (isConst(a) && isConst(b)) {
          const result = evalBinop(instr.imm, a.imm, b.imm);
          // A trapping operation is left alone: folding it would delete a trap
          // the program is required to produce.
          if (isTrap(result)) continue;
          becomeConst(instr, result.value);
          changed++;
          continue;
        }

        const simpler = simplify(instr);
        if (!simpler) continue;
        if (simpler.constant !== undefined) {
          becomeConst(instr, simpler.constant);
        } else {
          replaceAllUses(func, instr, simpler);
          removeInstr(instr);
        }
        changed++;
        continue;
      }

      if (instr.op === 'unop' && isConst(instr.args[0])) {
        becomeConst(instr, evalUnop(instr.imm, instr.args[0].imm).value);
        changed++;
      }
    }
  }

  // A branch on a known condition is a jump, which is what makes blocks
  // unreachable and lets dead code elimination take whole regions away.
  for (const block of [...func.blocks]) {
    const term = block.term;
    if (term?.op !== 'branch' || !isConst(term.args[0])) continue;
    const taken = term.args[0].imm !== 0 ? term.imm.then : term.imm.otherwise;
    replaceBranchWithJump(func, block, taken);
    changed++;
  }
  if (changed) removeUnreachableBlocks(func);

  return changed;
}

export function fold(module) {
  let changed = 0;
  for (const func of module.funcs.values()) changed += foldConstants(func);
  return changed;
}
