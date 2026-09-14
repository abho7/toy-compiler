// The edits an optimization pass is allowed to make, in one place.
//
// Passes do not reach into blocks and splice arrays themselves. Every
// structural change goes through here, because the invariants that make SSA
// meaningful -- uses point at definitions, phi operands line up with
// predecessors, preds and successors agree -- are easy to break one at a time
// and expensive to find afterwards.
//
// Everything is edited in place. Rebuilding an array with map() or filter()
// hands back a new object while something else may still hold the old one,
// which is how phase 4's SSA construction lost phi operands.

/** Every (instruction, operand index) that reads `value`, plus phi operands. */
export function usesOf(func, value) {
  const found = [];
  for (const block of func.blocks) {
    for (const phi of block.phis) {
      phi.incoming.forEach((pair, i) => {
        if (pair[1] === value) found.push({ phi, index: i });
      });
    }
    for (const instr of [...block.instrs, block.term].filter(Boolean)) {
      instr.args.forEach((arg, i) => {
        if (arg === value) found.push({ instr, index: i });
      });
    }
  }
  return found;
}

/** Is anything still reading `value`? */
export function isUsed(func, value) {
  return usesOf(func, value).length > 0;
}

/** Point every use of `oldValue` at `newValue`. */
export function replaceAllUses(func, oldValue, newValue) {
  let replaced = 0;
  for (const block of func.blocks) {
    for (const phi of block.phis) {
      for (const pair of phi.incoming) {
        if (pair[1] === oldValue) { pair[1] = newValue; replaced++; }
      }
    }
    for (const instr of [...block.instrs, block.term].filter(Boolean)) {
      for (let i = 0; i < instr.args.length; i++) {
        if (instr.args[i] === oldValue) { instr.args[i] = newValue; replaced++; }
      }
    }
  }
  return replaced;
}

/** Take an instruction out of its block. Its uses must already be gone. */
export function removeInstr(instr) {
  const block = instr.block;
  if (!block) return false;
  const list = instr.op === 'phi' ? block.phis : block.instrs;
  const at = list.indexOf(instr);
  if (at < 0) return false;
  list.splice(at, 1);
  instr.block = null;
  return true;
}

/**
 * Drop the edge from `from` to `to`, keeping phis consistent.
 *
 * The operand a phi took from that predecessor goes with the edge. A phi left
 * with one operand is no longer saying anything, so it is replaced by that
 * operand -- otherwise every later pass walks phis that merge a value with
 * itself, and the validator would rightly complain that the operand count no
 * longer matches the predecessors.
 */
export function removeEdge(func, from, to) {
  const at = to.preds.indexOf(from);
  if (at < 0) return;
  to.preds.splice(at, 1);

  for (const phi of [...to.phis]) {
    const index = phi.incoming.findIndex(([block]) => block === from);
    if (index >= 0) phi.incoming.splice(index, 1);

    if (phi.incoming.length === 1) {
      replaceAllUses(func, phi, phi.incoming[0][1]);
      removeInstr(phi);
    }
  }
}

/**
 * Remove every block the entry cannot reach.
 *
 * Constant folding turns a branch on a known condition into a jump, which is
 * what usually makes a block unreachable; leaving it in place would leave phis
 * elsewhere holding operands from a predecessor that can never run.
 */
export function removeUnreachableBlocks(func) {
  const reachable = new Set(func.reversePostorder());
  const dropped = func.blocks.filter((b) => !reachable.has(b));
  if (dropped.length === 0) return 0;

  for (const block of dropped) {
    for (const successor of block.successors) {
      if (reachable.has(successor)) removeEdge(func, block, successor);
    }
  }
  for (const block of dropped) {
    const at = func.blocks.indexOf(block);
    if (at >= 0) func.blocks.splice(at, 1);
  }
  return dropped.length;
}

/** Replace a branch with a jump to one side, dropping the other edge. */
export function replaceBranchWithJump(func, block, taken) {
  const term = block.term;
  const other = term.imm.then === taken ? term.imm.otherwise : term.imm.then;

  term.op = 'jump';
  term.args = [];
  term.imm = taken;

  // Both sides may lead to the same block, in which case the edge survives.
  if (other !== taken) removeEdge(func, block, other);
}
