// IR to bytecode.
//
// This generator is deliberately the simplest thing that is obviously correct:
// every SSA value gets a slot of its own in the frame, and every instruction
// loads its operands into registers, computes, and stores the result back to
// its slot. Registers are therefore scratch space that never has to be
// allocated, and no value is ever in two places.
//
// It is also slow, and that is the point. Phase 7 replaces the slot-per-value
// assignment with linear-scan register allocation, and the improvement it has
// to show is a real one -- loads and stores that stop happening -- rather than
// a number that needs arguing for. The baseline being naive is what makes the
// measurement honest.

import {
  OP, BINOP_TO_OP, UNOP_TO_OP, CodeBuffer, SCRATCH_REG, MAX_ARGS, WORDS_PER_INSTR,
} from '../vm/bytecode.js';
import { splitCriticalEdges, edgeCopies, sequenceCopies, blockOrder } from './linearize.js';

class FunctionGen {
  constructor(func, funcIndex) {
    this.func = func;
    this.funcIndex = funcIndex;
    this.buf = new CodeBuffer();
    this.slotOf = new Map();
    this.nslots = 0;
    // Call sites, as instruction index -> callee name. A callee's index is a
    // property of the module, not of this function, so it cannot be a label in
    // this function's buffer: it is resolved in generate() once every function
    // has an index.
    this.callSites = new Map();

    // Parameters first, in order: the call sequence puts argument i in r(i),
    // and the callee stores r(i) into slot i on entry.
    for (const param of func.params) this.assign(param);
    for (const block of func.blocks) {
      for (const instr of [...block.phis, ...block.instrs]) this.assign(instr);
    }
    this.tempSlot = this.nslots++;   // for breaking copy cycles
  }

  assign(value) {
    if (!this.slotOf.has(value)) this.slotOf.set(value, this.nslots++);
    return this.slotOf.get(value);
  }

  slot(value) {
    const at = this.slotOf.get(value);
    if (at === undefined) throw new Error(`codegen: ${value.ref} has no slot`);
    return at;
  }

  /** Load a value into register `reg`. */
  loadInto(reg, value, span = null) {
    // A constant is materialised where it is used rather than fetched: it is
    // one instruction either way, and it keeps constant folding's results
    // visible in the disassembly.
    if (value.op === 'const') this.buf.emit(OP.CONST, reg, value.imm | 0, 0, span);
    else this.buf.emit(OP.LDSLOT, reg, this.slot(value), 0, span);
  }

  store(value, reg, span = null) {
    this.buf.emit(OP.STSLOT, this.slot(value), reg, 0, span);
  }

  generate() {
    const func = this.func;
    splitCriticalEdges(func);

    // Parameters arrive in registers; move them into their slots.
    func.params.forEach((param, i) => this.buf.emit(OP.STSLOT, this.slot(param), i, 0, null));

    const order = blockOrder(func);
    const labels = new Map();

    for (const block of order) {
      labels.set(block.label, this.buf.length);

      for (const instr of block.instrs) this.instruction(instr);
      this.terminator(block);
    }

    this.buf.patch(labels);
    const { code, spans } = this.buf.finish();
    return {
      name: func.name,
      nparams: func.params.length,
      nslots: this.nslots,
      code,
      spans,
      callSites: this.callSites,
    };
  }

  instruction(instr) {
    const span = instr.span;
    switch (instr.op) {
      case 'const':
        // Materialised at each use; still stored so a later pass that keeps a
        // reference to it finds a slot holding the value.
        this.buf.emit(OP.CONST, 0, instr.imm | 0, 0, span);
        this.store(instr, 0, span);
        return;

      case 'binop': {
        this.loadInto(0, instr.args[0], span);
        this.loadInto(1, instr.args[1], span);
        this.buf.emit(BINOP_TO_OP[instr.imm], 0, 0, 1, span);
        this.store(instr, 0, span);
        return;
      }

      case 'unop':
        this.loadInto(0, instr.args[0], span);
        this.buf.emit(UNOP_TO_OP[instr.imm], 0, 0, 0, span);
        this.store(instr, 0, span);
        return;

      case 'alloc':
        this.buf.emit(OP.ALLOC, 0, instr.imm, 0, span);
        this.store(instr, 0, span);
        return;

      case 'load':
        this.loadInto(0, instr.args[0], span);
        this.loadInto(1, instr.args[1], span);
        this.buf.emit(OP.LOAD, 0, 0, 1, span);
        this.store(instr, 0, span);
        return;

      case 'store':
        this.loadInto(0, instr.args[0], span);
        this.loadInto(1, instr.args[1], span);
        this.loadInto(2, instr.args[2], span);
        this.buf.emit(OP.STORE, 0, 1, 2, span);
        return;

      case 'print':
      case 'putchar':
        this.loadInto(0, instr.args[0], span);
        this.buf.emit(instr.op === 'print' ? OP.PRINT : OP.PUTCHAR, 0, 0, 0, span);
        return;

      case 'call': {
        if (instr.args.length > MAX_ARGS) {
          throw new Error(`codegen: ${instr.imm} takes ${instr.args.length} arguments, more than the ${MAX_ARGS} a call can pass`);
        }
        instr.args.forEach((arg, i) => this.loadInto(i, arg, span));
        // Operand b is the callee index, filled in by generate(); c is the
        // argument count, which is known here.
        const at = this.buf.emit(OP.CALL, 0, 0, instr.args.length, span);
        this.callSites.set(at, instr.imm);
        if (instr.type !== 'void') this.store(instr, 0, span);
        return;
      }

      default:
        throw new Error(`codegen: unhandled instruction ${instr.op}`);
    }
  }

  /**
   * The copies a phi needs, performed on the edge into `to`.
   *
   * They happen simultaneously, so the ones reading slots are ordered by
   * sequenceCopies, which breaks cycles through the scratch slot. Copies whose
   * source is a constant read nothing, so they carry no ordering constraint of
   * their own -- but their destination may be read by the others, so they are
   * emitted last.
   */
  emitEdgeCopies(from, to) {
    const copies = edgeCopies(to).get(from);
    if (!copies || copies.length === 0) return;

    const fromSlots = [];
    const fromConsts = [];
    for (const [phi, value] of copies) {
      const dst = this.slot(phi);
      if (value.op === 'const') fromConsts.push([dst, value.imm | 0]);
      else fromSlots.push([dst, this.slot(value)]);
    }

    for (const step of sequenceCopies(fromSlots)) {
      if (step.toTemp) {
        this.buf.emit(OP.LDSLOT, SCRATCH_REG, step.src);
        this.buf.emit(OP.STSLOT, this.tempSlot, SCRATCH_REG);
        continue;
      }
      if (step.fromTemp) {
        this.buf.emit(OP.LDSLOT, 0, this.tempSlot);
        this.buf.emit(OP.STSLOT, step.dst, 0);
        continue;
      }
      this.buf.emit(OP.LDSLOT, 0, step.src);
      this.buf.emit(OP.STSLOT, step.dst, 0);
    }

    for (const [dst, imm] of fromConsts) {
      this.buf.emit(OP.CONST, 0, imm);
      this.buf.emit(OP.STSLOT, dst, 0);
    }
  }

  terminator(block) {
    const term = block.term;
    switch (term.op) {
      case 'jump':
        this.emitEdgeCopies(block, term.imm);
        this.buf.emitTo(OP.JMP, term.imm.label, { slot: 1, span: term.span });
        return;

      case 'branch': {
        // The condition is read before any copies, and critical edges have been
        // split, so each side's copies live in a block of its own.
        this.loadInto(0, term.args[0], term.span);
        this.buf.emitTo(OP.BRZ, term.imm.otherwise.label, { a: 0, slot: 2, span: term.span });
        this.emitEdgeCopies(block, term.imm.then);
        this.buf.emitTo(OP.JMP, term.imm.then.label, { slot: 1, span: term.span });
        return;
      }

      case 'ret':
        if (term.args.length) {
          this.loadInto(0, term.args[0], term.span);
          this.buf.emit(OP.RET, 0, 0, 0, term.span);
        } else {
          this.buf.emit(OP.RETVOID, 0, 0, 0, term.span);
        }
        return;

      default:
        throw new Error(`codegen: unhandled terminator ${term.op}`);
    }
  }
}

/**
 * Compile an IR module to a bytecode program.
 *
 * Returns { funcs, mainIndex }: functions in declaration order, each with its
 * code, the number of slots its frame needs, and a span per instruction so a
 * trap can say where it happened.
 */
export function generate(module) {
  const funcs = [...module.funcs.values()];
  const indexOf = new Map(funcs.map((f, i) => [f.name, i]));

  const compiled = funcs.map((func, i) => new FunctionGen(func, i).generate());

  // Link: a call names its callee, and only the module knows what index that
  // is. Done here rather than during generation so a function can call one
  // declared after it, which mutual recursion requires.
  for (const out of compiled) {
    for (const [at, name] of out.callSites) {
      const target = indexOf.get(name);
      if (target === undefined) throw new Error(`codegen: ${out.name} calls ${name}, which is not in the module`);
      out.code[at * WORDS_PER_INSTR + 2] = target;
    }
    delete out.callSites;
  }

  return { funcs: compiled, mainIndex: indexOf.get('main'), indexOf };
}
