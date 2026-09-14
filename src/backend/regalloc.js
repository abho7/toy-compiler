// Linear-scan register allocation.
//
// Phase 5's code generator gave every SSA value a slot of its own and moved
// every operand through a register on the way to the arithmetic: load, load,
// compute, store. Nothing could be allocated wrongly because nothing was
// allocated. This replaces that with real allocation, and the thing it has to
// show is concrete -- loads and stores that stop happening -- against a
// baseline nobody has to take on faith.
//
// The algorithm is Poletto and Sarkar's linear scan. Values are given live
// intervals over a linear numbering of the function; the intervals are walked
// in order of start; each is given a free register, and when none is free the
// interval that ends furthest away is sent to a slot instead. It is not the
// best allocation -- a graph colouring allocator does better on tight loops --
// but it is the one whose behaviour can be explained in a paragraph, and this
// project values being able to say why the output is what it is.
//
// Two things about this machine shape the result, and both are stated in
// docs/bytecode.md rather than left for a reader to infer:
//
//   Frames own their registers. The VM gives every frame its own register
//   array, so a value in a register survives a call without being saved. On a
//   real machine most of these registers would be caller-saved and every call
//   site would spill. That makes the numbers here better than a real target
//   would give, and the benchmark has to say so.
//
//   Arguments are marshalled through r0 upward. A value sitting in one of
//   those registers would be overwritten while setting up a call, so in any
//   function that calls anything, r0..r(maxArgs-1) are withheld from
//   allocation. Along with the scratch register that leaves ten or more in
//   practice, which is more than any corpus program needs at once.

import { REGISTERS, FIRST_SCRATCH } from '../vm/bytecode.js';

/**
 * Number every instruction in the function, in the order code will be emitted.
 *
 * Phis all share the position of their block's start: they happen on entry,
 * together, before anything else in the block.
 */
export function linearOrder(func) {
  const blocks = func.reversePostorder();
  const positionOf = new Map();
  const blockStart = new Map();
  const blockEnd = new Map();
  let at = 0;

  for (const block of blocks) {
    blockStart.set(block, at);
    for (const phi of block.phis) positionOf.set(phi, at);
    at++;
    for (const instr of block.instrs) positionOf.set(instr, at++);
    if (block.term) positionOf.set(block.term, at);
    blockEnd.set(block, at);
    at++;
  }

  return { blocks, positionOf, blockStart, blockEnd, length: at };
}

/**
 * Which values are live on entry to and exit from each block.
 *
 * Backward dataflow to a fixed point. The subtlety is phis: a phi's operand is
 * not used in the block holding the phi, it is used at the end of the
 * predecessor it arrives from. Treating it as a use in the phi's own block
 * would keep values alive down paths they never travel.
 */
export function liveness(func) {
  const liveIn = new Map();
  const liveOut = new Map();
  for (const block of func.blocks) {
    liveIn.set(block, new Set());
    liveOut.set(block, new Set());
  }

  const defsOf = (block) => {
    const defs = new Set(block.phis);
    for (const instr of block.instrs) defs.add(instr);
    return defs;
  };

  const usesOf = (block) => {
    const defs = new Set();
    const uses = new Set();
    for (const phi of block.phis) defs.add(phi);
    for (const instr of [...block.instrs, block.term].filter(Boolean)) {
      for (const arg of instr.args) {
        if (arg.op !== 'const' && !defs.has(arg)) uses.add(arg);
      }
      defs.add(instr);
    }
    return uses;
  };

  const use = new Map(func.blocks.map((b) => [b, usesOf(b)]));
  const def = new Map(func.blocks.map((b) => [b, defsOf(b)]));

  let changed = true;
  while (changed) {
    changed = false;
    for (const block of [...func.blocks].reverse()) {
      const out = new Set();
      for (const successor of block.successors) {
        // Everything live entering the successor, except its phis...
        for (const value of liveIn.get(successor)) {
          if (!successor.phis.includes(value)) out.add(value);
        }
        // ...plus the operand each of its phis takes from *this* edge.
        for (const phi of successor.phis) {
          const pair = phi.incoming.find(([from]) => from === block);
          if (pair && pair[1].op !== 'const') out.add(pair[1]);
        }
      }

      const inn = new Set(use.get(block));
      for (const value of out) {
        if (!def.get(block).has(value)) inn.add(value);
      }

      if (out.size !== liveOut.get(block).size || inn.size !== liveIn.get(block).size) changed = true;
      liveOut.set(block, out);
      liveIn.set(block, inn);
    }
  }

  return { liveIn, liveOut };
}

/**
 * One [start, end] per value.
 *
 * Holes are ignored: a value live at the top and bottom of a loop but dead in
 * the middle keeps its register for the whole loop. That wastes registers and
 * is the main thing a better allocator would recover, but it can never be
 * wrong, which is the right trade for a first allocator.
 */
export function liveIntervals(func) {
  const order = linearOrder(func);
  const { liveIn, liveOut } = liveness(func);
  const intervals = new Map();

  const touch = (value, position) => {
    if (!value || value.op === 'const') return;
    const existing = intervals.get(value);
    if (!existing) intervals.set(value, { value, start: position, end: position });
    else {
      existing.start = Math.min(existing.start, position);
      existing.end = Math.max(existing.end, position);
    }
  };

  // Parameters are live from the moment the function starts.
  for (const param of func.params) touch(param, 0);

  for (const block of order.blocks) {
    const start = order.blockStart.get(block);
    const end = order.blockEnd.get(block);

    for (const value of liveIn.get(block)) touch(value, start);
    for (const value of liveOut.get(block)) touch(value, end);

    for (const phi of block.phis) touch(phi, start);

    for (const instr of block.instrs) {
      const position = order.positionOf.get(instr);
      touch(instr, position);
      for (const arg of instr.args) touch(arg, position);
    }

    if (block.term) {
      const position = order.positionOf.get(block.term);
      for (const arg of block.term.args) touch(arg, position);
      // A phi operand is used on this edge, at the end of this block.
      for (const successor of block.successors) {
        for (const phi of successor.phis) {
          const pair = phi.incoming.find(([from]) => from === block);
          if (pair) touch(pair[1], position);
        }
      }
    }
  }

  return { order, intervals: [...intervals.values()].sort((a, b) => a.start - b.start) };
}

/** Registers this function may allocate, given how it calls. */
export function allocatableRegisters(func) {
  let maxArgs = 0;
  for (const block of func.blocks) {
    for (const instr of block.instrs) {
      if (instr.op === 'call') maxArgs = Math.max(maxArgs, instr.args.length);
    }
  }
  // Also withhold the registers this function's own parameters arrive in.
  // Without that, moving parameters to their allocated homes is a parallel
  // copy -- param 0 arrives in r0 and may be destined for r1 while param 1,
  // in r1, is destined for r0 -- and sequencing it naively destroys one of
  // them. Reserving the incoming registers makes the moves plain and ordered.
  const reserved = Math.max(maxArgs, func.params.length);
  const registers = [];
  for (let r = reserved; r < FIRST_SCRATCH; r++) registers.push(r);
  return { registers, reservedForArgs: reserved };
}

/**
 * Assign every value a register or a spill slot.
 *
 * Returns a location per value -- { kind: 'reg', n } or { kind: 'slot', n } --
 * along with the counts the benchmark reports.
 */
export function allocate(func, { registers: override = null } = {}) {
  const { order, intervals } = liveIntervals(func);
  const natural = allocatableRegisters(func);
  // The register set is injectable so the spill path can be put under real
  // pressure in a test. Every corpus program fits in the register file with
  // room to spare, which means eviction would otherwise be code that has never
  // once executed -- and this project has already shipped two passes whose
  // green tests were running around unreachable code.
  const registers = override ?? natural.registers;
  const reservedForArgs = natural.reservedForArgs;

  const location = new Map();
  const active = [];          // intervals holding a register, sorted by end
  const free = [...registers];
  let nextSlot = 0;
  let spills = 0;

  const spillTo = (interval) => {
    location.set(interval.value, { kind: 'slot', n: nextSlot++ });
    spills++;
  };

  for (const interval of intervals) {
    // Anything that ended before this one starts gives its register back.
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].end < interval.start) {
        free.push(location.get(active[i].value).n);
        active.splice(i, 1);
      }
    }

    if (free.length === 0) {
      // Every register is taken. The interval that runs furthest is the one
      // worth evicting: it is the one that would otherwise hold a register
      // longest without necessarily being used more often.
      const furthest = active.reduce((worst, c) => (c.end > worst.end ? c : worst), active[0]);
      if (furthest && furthest.end > interval.end) {
        const register = location.get(furthest.value).n;
        location.set(interval.value, { kind: 'reg', n: register });
        spillTo(furthest);
        active.splice(active.indexOf(furthest), 1);
        active.push(interval);
        active.sort((a, b) => a.end - b.end);
      } else {
        spillTo(interval);
      }
      continue;
    }

    location.set(interval.value, { kind: 'reg', n: free.shift() });
    active.push(interval);
    active.sort((a, b) => a.end - b.end);
  }

  const registersUsed = new Set(
    [...location.values()].filter((l) => l.kind === 'reg').map((l) => l.n),
  );

  return {
    location,
    order,
    intervals,
    slots: nextSlot,
    spills,
    registersUsed: registersUsed.size,
    reservedForArgs,
    allocatable: registers.length,
  };
}

/**
 * Check that no two values sharing a register are ever live at the same time.
 *
 * This is the invariant the whole pass rests on, and the one whose violation is
 * least visible: the program still runs, and produces a wrong answer only when
 * the two values happen to hold different things at the moment they collide.
 */
export function verifyAllocation(func, result) {
  const problems = [];
  const byRegister = new Map();

  for (const interval of result.intervals) {
    const where = result.location.get(interval.value);
    if (!where) {
      problems.push(`${func.name}: ${interval.value.ref} has no location`);
      continue;
    }
    if (where.kind !== 'reg') continue;
    const sharing = byRegister.get(where.n) ?? [];
    for (const other of sharing) {
      // Intervals are closed, so touching endpoints overlap.
      if (interval.start <= other.end && other.start <= interval.end) {
        problems.push(
          `${func.name}: ${interval.value.ref} [${interval.start},${interval.end}] and `
          + `${other.value.ref} [${other.start},${other.end}] both hold r${where.n}`);
      }
    }
    sharing.push(interval);
    byRegister.set(where.n, sharing);
  }

  for (const [, where] of result.location) {
    if (where.kind === 'reg' && where.n >= REGISTERS) {
      problems.push(`${func.name}: r${where.n} is beyond the register file`);
    }
    if (where.kind === 'reg' && where.n < result.reservedForArgs) {
      problems.push(`${func.name}: r${where.n} is reserved for argument marshalling`);
    }
  }

  return problems;
}
