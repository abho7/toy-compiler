// Structural checks on the IR.
//
// Run after construction and after every optimization pass. It does not check
// that a pass preserved behaviour -- that is what the differential harness is
// for -- it checks that the result is still a well-formed program at all, which
// is the cheaper failure to find first.
//
// The important one is dominance. In SSA, a use is only meaningful if the
// definition is guaranteed to have run: the defining instruction must dominate
// the use, and for a phi operand, must dominate the end of the predecessor it
// arrives from. A pass that moves an instruction across a branch usually breaks
// exactly this, and it breaks it silently: the IR still looks like a list of
// instructions, and an interpreter might even run it and get a plausible answer
// on the inputs that happen to be tested.

import { TERMINATORS, effects } from './ir.js';

/** Immediate dominators, by the iterative algorithm over reverse postorder. */
export function dominators(func) {
  const order = func.reversePostorder();
  const index = new Map(order.map((b, i) => [b, i]));
  const idom = new Map([[func.entry, func.entry]]);

  const intersect = (a, b) => {
    while (a !== b) {
      while (index.get(a) > index.get(b)) a = idom.get(a);
      while (index.get(b) > index.get(a)) b = idom.get(b);
    }
    return a;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const block of order) {
      if (block === func.entry) continue;
      const known = block.preds.filter((p) => idom.has(p));
      if (known.length === 0) continue;
      let candidate = known[0];
      for (const pred of known.slice(1)) candidate = intersect(candidate, pred);
      if (idom.get(block) !== candidate) {
        idom.set(block, candidate);
        changed = true;
      }
    }
  }
  return idom;
}

/** Does `a` dominate `b`? */
export function dominates(idom, a, b) {
  let at = b;
  for (;;) {
    if (at === a) return true;
    const next = idom.get(at);
    if (!next || next === at) return false;
    at = next;
  }
}

/**
 * Check a function. Returns a list of problems, empty when it is well formed.
 *
 * Problems are returned rather than thrown so a caller can report all of them,
 * and so tests can assert on a specific one.
 */
export function validateFunc(func) {
  const problems = [];
  const say = (message) => problems.push(`${func.name}: ${message}`);

  const blocks = new Set(func.blocks);
  if (!blocks.has(func.entry)) say('the entry block is not in the function');
  if (func.entry.preds.length > 0) say('the entry block has predecessors');

  // --- shape: one terminator per block, and nothing else terminating ---
  for (const block of func.blocks) {
    if (!block.term) say(`block ${block.label} has no terminator`);
    else if (!TERMINATORS.has(block.term.op)) {
      say(`block ${block.label} ends with ${block.term.op}, which is not a terminator`);
    }
    for (const instr of block.instrs) {
      if (TERMINATORS.has(instr.op)) {
        say(`block ${block.label} has a ${instr.op} in the middle`);
      }
      if (instr.block !== block) say(`${instr.ref} is listed in ${block.label} but claims another block`);
    }
    for (const successor of block.successors) {
      if (!blocks.has(successor)) say(`block ${block.label} jumps outside the function`);
      else if (!successor.preds.includes(block)) {
        say(`block ${successor.label} does not list ${block.label} as a predecessor`);
      }
    }
    for (const pred of block.preds) {
      if (!pred.successors.includes(block)) {
        say(`block ${block.label} lists ${pred.label} as a predecessor, but it does not jump here`);
      }
    }
  }

  // --- every block reachable: an unreachable block is a construction bug ---
  const reachable = new Set(func.reversePostorder());
  for (const block of func.blocks) {
    if (!reachable.has(block)) say(`block ${block.label} is unreachable`);
  }

  // --- single assignment: no value defined twice ---
  const defined = new Set(func.params);
  for (const block of func.blocks) {
    for (const instr of [...block.phis, ...block.instrs]) {
      if (defined.has(instr)) say(`${instr.ref} is defined more than once`);
      defined.add(instr);
    }
  }

  // --- dominance: definitions reach their uses ---
  const idom = dominators(func);
  const positionOf = new Map();
  for (const block of func.blocks) {
    const list = [...block.phis, ...block.instrs, block.term].filter(Boolean);
    list.forEach((instr, i) => positionOf.set(instr, { block, i }));
  }

  const definitionReaches = (value, user, fromBlock) => {
    if (!value) return false;
    if (value.op === 'param') return true;
    const def = positionOf.get(value);
    if (!def) return false;
    if (fromBlock) return dominates(idom, def.block, fromBlock);   // phi operand
    const use = positionOf.get(user);
    if (def.block === use.block) return def.i < use.i || value.op === 'phi';
    return dominates(idom, def.block, use.block);
  };

  for (const block of func.blocks) {
    for (const phi of block.phis) {
      if (phi.incoming.length !== block.preds.length) {
        say(`${phi.ref} has ${phi.incoming.length} operands but ${block.label} has ${block.preds.length} predecessors`);
      }
      for (const [from, value] of phi.incoming) {
        if (!block.preds.includes(from)) say(`${phi.ref} takes a value from ${from.label}, which is not a predecessor`);
        else if (!definitionReaches(value, phi, from)) {
          say(`${phi.ref} uses ${value?.ref ?? '<missing>'} from ${from.label}, where it is not defined`);
        }
      }
    }
    for (const instr of [...block.instrs, block.term].filter(Boolean)) {
      for (const arg of instr.args) {
        if (!definitionReaches(arg, instr, null)) {
          say(`${instr.ref} (${instr.op}) uses ${arg?.ref ?? '<missing>'}, which does not reach it`);
        }
      }
    }
  }

  // --- types: the few that matter ---
  for (const block of func.blocks) {
    for (const instr of block.instrs) {
      const [a, b, c] = instr.args;
      switch (instr.op) {
        case 'binop':
          if (a?.type !== 'int' || b?.type !== 'int') say(`${instr.ref}: ${instr.imm} on a non-int`);
          break;
        case 'unop':
          if (a?.type !== 'int') say(`${instr.ref}: ${instr.imm} on a non-int`);
          break;
        case 'load':
          if (a?.type !== 'array') say(`${instr.ref}: load from a non-array`);
          if (b?.type !== 'int') say(`${instr.ref}: load with a non-int index`);
          break;
        case 'store':
          if (a?.type !== 'array') say(`${instr.ref}: store into a non-array`);
          if (b?.type !== 'int') say(`${instr.ref}: store with a non-int index`);
          if (c?.type !== 'int') say(`${instr.ref}: store of a non-int`);
          break;
        default:
          break;
      }
      // Every instruction must have a span, or a trap could not say where it
      // happened, and a trap's location is part of observable behaviour.
      if (effects(instr).mayTrap && !instr.span) say(`${instr.ref} (${instr.op}) can trap but has no span`);
    }
  }

  return problems;
}

/** Check every function. Returns all problems found. */
export function validateModule(module) {
  return [...module.funcs.values()].flatMap(validateFunc);
}

/** Throw unless the module is well formed. Used after each pass. */
export function assertValid(module, what = 'IR') {
  const problems = validateModule(module);
  if (problems.length) {
    throw new Error(`${what} is not well formed:\n  ${problems.join('\n  ')}`);
  }
}
