// The intermediate representation: three-address code in SSA form over a
// control flow graph.
//
// Documented in docs/ir.md. The short version:
//
//   A module is functions. A function is basic blocks. A block is a list of
//   instructions ending in exactly one terminator. Every instruction defines at
//   most one value, and that value is the instruction: there are no separate
//   virtual register names to keep in step with anything.
//
//   Every value is assigned exactly once (SSA), so "what is in x here" is
//   answered by looking at one instruction rather than by walking backwards
//   through the block. Where control flow joins, a phi says which value came
//   from which predecessor.
//
// The part that matters for optimization is `effects`. A pass may only move,
// merge or delete an instruction according to what it can do besides producing
// a value: trap, read memory, write memory, call something, or write output.
// Those are properties of the instruction, listed in one place, because an
// optimizer can only be proven correct about effects it can see.

import { MAY_TRAP } from '../values.js';

/** Instruction kinds that end a block. Exactly one per block. */
export const TERMINATORS = new Set(['jump', 'branch', 'ret']);

let nextInstrId = 0;

export class Instr {
  constructor(op, { type = 'int', args = [], imm = null, span = null, incoming = null } = {}) {
    this.id = nextInstrId++;
    this.op = op;
    this.type = type;          // 'int' | 'array' | 'void'
    this.args = args;          // operands, as Instr or Param references
    this.imm = imm;            // a literal, an operator name, a callee name
    this.span = span;          // where it came from; part of a trap's behaviour
    this.incoming = incoming;  // phi only: [[block, value], ...]
    this.block = null;
  }

  /** How it is written in the printed form: %12. */
  get ref() { return `%${this.id}`; }
}

/** A function parameter, which is a value but not an instruction. */
export class Param {
  constructor(name, type, index) {
    this.id = nextInstrId++;
    this.op = 'param';
    this.name = name;
    this.type = type;
    this.index = index;
    this.span = null;
  }

  get ref() { return `%${this.id}`; }
}

export class Block {
  constructor(label) {
    this.label = label;
    this.instrs = [];      // no terminators here
    this.term = null;      // exactly one, once the block is finished
    this.preds = [];
    this.phis = [];
    // SSA construction bookkeeping, meaningless once building is done.
    this.sealed = false;
    this.defs = new Map();
    this.incompletePhis = new Map();
  }

  get successors() {
    if (!this.term) return [];
    if (this.term.op === 'jump') return [this.term.imm];
    if (this.term.op === 'branch') return [this.term.imm.then, this.term.imm.otherwise];
    return [];
  }
}

export class Func {
  constructor(name, returnType) {
    this.name = name;
    this.returnType = returnType;
    this.params = [];
    this.blocks = [];
    this.entry = null;
  }

  addBlock(label) {
    const block = new Block(`${label}${this.blocks.length}`);
    this.blocks.push(block);
    return block;
  }

  /** Blocks in reverse postorder from the entry: the order passes walk in. */
  reversePostorder() {
    const seen = new Set();
    const order = [];
    const visit = (block) => {
      if (seen.has(block)) return;
      seen.add(block);
      for (const next of block.successors) visit(next);
      order.push(block);
    };
    visit(this.entry);
    return order.reverse();
  }
}

export class Module {
  constructor() {
    this.funcs = new Map();
  }
}

const NONE = Object.freeze({
  mayTrap: false, readsMem: false, writesMem: false, isCall: false,
  writesOutput: false, unique: false,
});
const with_ = (extra) => Object.freeze({ ...NONE, ...extra });

/**
 * What an instruction can do besides producing a value.
 *
 * Every pass consults this and nothing else. The cases worth explaining:
 *
 *   binop  only `/` and `%` can trap, so only those carry mayTrap. That is
 *          what lets constant folding fold the others unconditionally.
 *
 *   alloc  is not pure, even though it reads nothing and writes nothing that
 *          already existed: two allocations of the same length are *different
 *          arrays*, and merging them by value number would alias two variables
 *          that the program keeps apart. `unique` says never do that.
 *
 *   load   can trap, because the bounds check is part of it. Keeping the check
 *          inside the access rather than as its own instruction means there is
 *          no pair that has to be kept adjacent by every later pass.
 *
 *   call   is assumed to do everything: a callee may print, write through an
 *          array it was passed, and trap. Phase 6 may refine this with a purity
 *          analysis; until then the conservative answer is the correct one.
 */
export function effects(instr) {
  switch (instr.op) {
    case 'const':
    case 'unop':
    case 'phi':
    case 'param':
      return NONE;
    case 'binop':
      return MAY_TRAP.has(instr.imm) ? with_({ mayTrap: true }) : NONE;
    case 'alloc':
      return with_({ unique: true });
    case 'load':
      return with_({ readsMem: true, mayTrap: true });
    case 'store':
      return with_({ writesMem: true, mayTrap: true });
    case 'call':
      return with_({ isCall: true, mayTrap: true, readsMem: true, writesMem: true });
    case 'print':
    case 'putchar':
      return with_({ writesOutput: true });
    case 'jump':
    case 'branch':
    case 'ret':
      return NONE;
    default:
      throw new Error(`effects: unknown op ${instr.op}`);
  }
}

/** No effects at all: safe to delete when unused, and to move within its dominance. */
export function isPure(instr) {
  const e = effects(instr);
  return !e.mayTrap && !e.readsMem && !e.writesMem && !e.isCall && !e.writesOutput && !e.unique;
}

/** Can be deleted if nothing uses it. Weaker than purity: a unique alloc qualifies. */
export function isRemovableWhenUnused(instr) {
  const e = effects(instr);
  return !e.mayTrap && !e.writesMem && !e.isCall && !e.writesOutput;
}

// --------------------------------------------------------------- printing --

function operand(value) {
  if (!value) return '<missing>';
  return value.ref;
}

export function printInstr(instr) {
  const lhs = instr.type === 'void' ? '' : `${instr.ref} = `;
  switch (instr.op) {
    case 'const': return `${lhs}const ${instr.imm}`;
    case 'binop': return `${lhs}${instr.imm} ${operand(instr.args[0])}, ${operand(instr.args[1])}`;
    case 'unop': return `${lhs}${instr.imm} ${operand(instr.args[0])}`;
    case 'alloc': return `${lhs}alloc ${instr.imm}`;
    case 'load': return `${lhs}load ${operand(instr.args[0])}[${operand(instr.args[1])}]`;
    case 'store': return `store ${operand(instr.args[0])}[${operand(instr.args[1])}], ${operand(instr.args[2])}`;
    case 'call': return `${lhs}call ${instr.imm}(${instr.args.map(operand).join(', ')})`;
    case 'print': return `print ${operand(instr.args[0])}`;
    case 'putchar': return `putchar ${operand(instr.args[0])}`;
    case 'phi':
      return `${lhs}phi ${instr.incoming.map(([b, v]) => `[${b.label} ${operand(v)}]`).join(' ')}`;
    case 'jump': return `jump ${instr.imm.label}`;
    case 'branch':
      return `branch ${operand(instr.args[0])} ? ${instr.imm.then.label} : ${instr.imm.otherwise.label}`;
    case 'ret': return instr.args.length ? `ret ${operand(instr.args[0])}` : 'ret';
    default: throw new Error(`printInstr: unknown op ${instr.op}`);
  }
}

export function printFunc(func) {
  const lines = [
    `func ${func.name}(${func.params.map((p) => `${p.ref}: ${p.type} ${p.name}`).join(', ')}) -> ${func.returnType} {`,
  ];
  for (const block of func.reversePostorder()) {
    const preds = block.preds.length ? `    ; preds: ${block.preds.map((b) => b.label).join(', ')}` : '';
    lines.push(`${block.label}:${preds}`);
    for (const phi of block.phis) lines.push(`  ${printInstr(phi)}`);
    for (const instr of block.instrs) lines.push(`  ${printInstr(instr)}`);
    lines.push(`  ${block.term ? printInstr(block.term) : '<no terminator>'}`);
  }
  lines.push('}');
  return lines.join('\n');
}

export function printModule(module) {
  return [...module.funcs.values()].map(printFunc).join('\n\n');
}
