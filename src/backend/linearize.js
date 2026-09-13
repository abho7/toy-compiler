// Getting an SSA control flow graph ready to become a straight line of code.
//
// Two jobs, both of which have to happen before code generation and neither of
// which belongs in it:
//
//   Split critical edges. An edge from a block with several successors into a
//   block with several predecessors has nowhere to put the copies a phi needs:
//   putting them in the predecessor runs them on paths that do not take this
//   edge, and putting them in the successor runs them for the wrong
//   predecessor. Splitting the edge creates the block that does have a place.
//
//   Turn phis into copies. A phi says "this value came from that predecessor",
//   which becomes, on each incoming edge, a copy into one destination. The
//   copies on one edge happen *simultaneously* -- that is what a phi means --
//   so a cycle among them (x from y, y from x) needs a temporary. Sequencing
//   them naively is the classic swap bug, and it produces a program that is
//   right until two loop variables happen to exchange values.

import { Instr } from '../ir/ir.js';

/** Does this edge need a block of its own? */
function isCritical(from, to) {
  return from.successors.length > 1 && to.preds.length > 1;
}

/**
 * Insert a block on every critical edge.
 *
 * Mutates the function. The new blocks are empty and jump straight on, so the
 * program means the same thing; they exist only to give phi copies a home.
 */
export function splitCriticalEdges(func) {
  let added = 0;
  for (const from of [...func.blocks]) {
    if (!from.term || from.term.op !== 'branch') continue;
    for (const side of ['then', 'otherwise']) {
      const to = from.term.imm[side];
      if (!isCritical(from, to)) continue;

      const split = func.addBlock('edge');
      split.sealed = true;
      split.preds = [from];
      split.term = new Instr('jump', { type: 'void', imm: to });
      split.term.block = split;

      from.term.imm[side] = split;
      to.preds = to.preds.map((p) => (p === from ? split : p));
      for (const phi of to.phis) {
        phi.incoming = phi.incoming.map(([b, v]) => [b === from ? split : b, v]);
      }
      added++;
    }
  }
  return added;
}

/**
 * The copies each edge has to perform, as [destination phi, source value].
 *
 * Returned per predecessor rather than per phi, because it is the set on one
 * edge that has to happen at once.
 */
export function edgeCopies(block) {
  const byPred = new Map();
  for (const pred of block.preds) byPred.set(pred, []);
  for (const phi of block.phis) {
    for (const [from, value] of phi.incoming) {
      byPred.get(from).push([phi, value]);
    }
  }
  return byPred;
}

/**
 * Order a set of simultaneous copies so that performing them one at a time has
 * the same effect.
 *
 * A copy can be emitted once nothing still to be done reads its destination.
 * When every remaining copy is blocked, the copies form a cycle: one source is
 * saved to a temporary, which breaks it. Returns a list of steps, each either
 * `{ dst, src }` or `{ dst, fromTemp: true }` / `{ toTemp: true, src }`.
 */
export function sequenceCopies(copies) {
  // Destinations and sources are both slot numbers. That is not incidental:
  // the first version took slot numbers for destinations and IR values for
  // sources, so the cycle test compared a number against a set of objects,
  // never matched, and silently degraded into naive sequencing. Every program
  // that did not exchange two values still worked.
  const pending = copies
    .filter(([dst, src]) => dst !== src)
    .map(([dst, src]) => ({ dst, src }));
  const steps = [];

  while (pending.length) {
    const sources = new Set(pending.map((c) => c.src));
    const free = pending.findIndex((c) => !sources.has(c.dst));

    if (free >= 0) {
      // Nothing left to do reads this destination, so writing it is safe now.
      const [copy] = pending.splice(free, 1);
      steps.push(copy.src === TEMP
        ? { dst: copy.dst, fromTemp: true }
        : { dst: copy.dst, src: copy.src });
      continue;
    }

    // Every destination is still somebody's source: the copies form a cycle.
    // Park one source in the temporary and point its readers at the temporary
    // instead, which frees that slot to be written and unwinds the cycle.
    const victim = pending[0].src;
    steps.push({ toTemp: true, src: victim });
    for (const copy of pending) {
      if (copy.src === victim) copy.src = TEMP;
    }
  }

  return steps;
}

/** Stands in for the scratch slot, and is never a destination. */
const TEMP = Symbol('temp');

/**
 * Block order for emission: reverse postorder.
 *
 * Any order is correct, since every edge is an explicit jump. Reverse postorder
 * puts a block after something that reaches it, which keeps the disassembly
 * readable and puts loop bodies next to their headers.
 */
export function blockOrder(func) {
  return func.reversePostorder();
}
