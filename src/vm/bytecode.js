// The bytecode: instruction encoding, and how to read it back.
//
// Documented in docs/bytecode.md. Four int32 per instruction -- opcode and
// three operands -- in one flat Int32Array per function. Fixed width costs
// space and buys the two things that matter here: a jump target is an
// instruction index rather than a byte offset that has to be computed, and the
// disassembler cannot lose sync with the encoder.
//
// Registers are a fixed file of 16 per frame. Slots are the frame's own
// storage, one per SSA value in the naive code generator, and however many the
// register allocator leaves in phase 7. Arrays live on a heap and are referred
// to by an integer handle, so every register holds an int32 and nothing else.

export const REGISTERS = 16;
/** Reserved for breaking cycles when phi copies have to be sequenced. */
export const SCRATCH_REG = 15;

/**
 * The top three registers are never allocated.
 *
 * Generated code needs somewhere to put a spilled operand while it computes:
 * a store whose array, index and value are all in slots needs three registers
 * at once that the allocator has not promised to anything. r15 doubles as the
 * temporary that breaks phi copy cycles, which is safe because copies happen
 * at block boundaries, where no operand is half-loaded.
 */
export const FIRST_SCRATCH = 13;
export const SCRATCH_REGS = Object.freeze([13, 14, 15]);
/** Arguments are passed in r0 upward, so this is the most a call can take. */
export const MAX_ARGS = SCRATCH_REG;

export const OP = Object.freeze({
  CONST: 1, MOVE: 2, LDSLOT: 3, STSLOT: 4,

  ADD: 10, SUB: 11, MUL: 12, DIV: 13, MOD: 14,
  SHL: 15, SHR: 16, AND: 17, OR: 18, XOR: 19,
  EQ: 20, NE: 21, LT: 22, LE: 23, GT: 24, GE: 25,
  NEG: 30, NOT: 31, BNOT: 32,

  ALLOC: 40, LOAD: 41, STORE: 42,
  PRINT: 50, PUTCHAR: 51,
  CALL: 60, RET: 61, RETVOID: 62,
  JMP: 70, BRZ: 71,
});

export const OP_NAME = Object.freeze(
  Object.fromEntries(Object.entries(OP).map(([name, code]) => [code, name])),
);

/** IR binary operators to opcodes. The only place the two vocabularies meet. */
export const BINOP_TO_OP = Object.freeze({
  '+': OP.ADD, '-': OP.SUB, '*': OP.MUL, '/': OP.DIV, '%': OP.MOD,
  '<<': OP.SHL, '>>': OP.SHR, '&': OP.AND, '|': OP.OR, '^': OP.XOR,
  '==': OP.EQ, '!=': OP.NE, '<': OP.LT, '<=': OP.LE, '>': OP.GT, '>=': OP.GE,
});

export const UNOP_TO_OP = Object.freeze({ '-': OP.NEG, '!': OP.NOT, '~': OP.BNOT });

export const WORDS_PER_INSTR = 4;

/**
 * Accumulates instructions for one function, then freezes them.
 *
 * Jump targets are instruction indices, which are not known while the body is
 * still being emitted, so they are patched afterwards: `emitJump` records the
 * hole and `patch` fills it.
 */
export class CodeBuffer {
  constructor() {
    this.words = [];
    this.spans = [];     // one per instruction, for traps
    this.holes = [];     // [instrIndex, operandSlot, label]
  }

  get length() { return this.spans.length; }

  emit(op, a = 0, b = 0, c = 0, span = null) {
    const index = this.spans.length;
    this.words.push(op, a, b, c);
    this.spans.push(span);
    return index;
  }

  /** Emit an instruction whose operand `slot` is a label to be resolved later. */
  emitTo(op, label, { a = 0, b = 0, slot = 1, span = null } = {}) {
    const index = this.emit(op, a, b, 0, span);
    this.holes.push([index, slot, label]);
    return index;
  }

  /** Resolve every recorded label using `labels`, a map from label to index. */
  patch(labels) {
    for (const [index, slot, label] of this.holes) {
      if (!labels.has(label)) throw new Error(`bytecode: no such label ${label}`);
      this.words[index * WORDS_PER_INSTR + slot] = labels.get(label);
    }
    this.holes = [];
  }

  finish() {
    return { code: Int32Array.from(this.words), spans: this.spans };
  }
}

/** One instruction, as text. `at` is its index, used to show jump targets. */
export function disassembleOne(code, at) {
  const base = at * WORDS_PER_INSTR;
  const [op, a, b, c] = [code[base], code[base + 1], code[base + 2], code[base + 3]];
  const name = (OP_NAME[op] ?? `?${op}`).toLowerCase().padEnd(7);
  switch (op) {
    case OP.CONST: return `${name} r${a}, ${b}`;
    case OP.MOVE: return `${name} r${a}, r${b}`;
    case OP.LDSLOT: return `${name} r${a}, s${b}`;
    case OP.STSLOT: return `${name} s${a}, r${b}`;
    case OP.ALLOC: return `${name} r${a}, ${b}`;
    case OP.LOAD: return `${name} r${a}, r${b}[r${c}]`;
    case OP.STORE: return `${name} r${a}[r${b}], r${c}`;
    case OP.PRINT: case OP.PUTCHAR: case OP.RET: return `${name} r${a}`;
    case OP.RETVOID: return name.trim();
    case OP.CALL: return `${name} r${a}, f${b}, ${c} args`;
    case OP.JMP: return `${name} @${a}`;
    case OP.BRZ: return `${name} r${a}, @${b}`;
    case OP.NEG: case OP.NOT: case OP.BNOT: return `${name} r${a}, r${b}`;
    default: return `${name} r${a}, r${b}, r${c}`;
  }
}

export function disassembleFunc(func) {
  const lines = [`func ${func.name}(${func.nparams} params, ${func.nslots} slots)`];
  for (let at = 0; at < func.spans.length; at++) {
    lines.push(`  ${String(at).padStart(4)}  ${disassembleOne(func.code, at)}`);
  }
  return lines.join('\n');
}

export function disassemble(program) {
  return program.funcs.map(disassembleFunc).join('\n\n');
}
