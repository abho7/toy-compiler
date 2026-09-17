// IR to bytecode, with values kept in registers.
//
// Phase 5's generator gave every SSA value a slot and moved every operand
// through a register on the way to the arithmetic: load, load, compute, store.
// Nothing could be allocated wrongly because nothing was allocated, which made
// it the right baseline and the wrong shipping code.
//
// This one asks the allocator where each value lives and emits accordingly:
//
//   operand in a register   use it
//   operand in a slot       load it into a scratch register first
//   result in a register    compute straight into it
//   result in a slot        compute into scratch, then store
//
// The traffic that disappears is the point of the phase, and it is measured
// rather than asserted -- tools/bench.js counts instructions executed before
// and after.
//
// Three registers are withheld from allocation for the scratch above (a store
// whose array, index and value are all spilled needs three at once), and the
// registers used to marshal call arguments and receive parameters are withheld
// too. That last reservation is what makes argument setup and parameter entry
// plain ordered moves instead of parallel copies: nothing allocated ever lives
// in a register that argument marshalling is about to overwrite.

import {
  OP, BINOP_TO_OP, UNOP_TO_OP, CodeBuffer, SCRATCH_REG, SCRATCH_REGS, MAX_ARGS,
  WORDS_PER_INSTR,
} from '../vm/bytecode.js';
import { splitCriticalEdges, edgeCopies, sequenceCopies, blockOrder } from './linearize.js';
import { allocate, allocatableRegisters, verifyAllocation } from './regalloc.js';

/** A location as a key sequenceCopies can compare: "r7" or "s3". */
const keyOf = (where) => (where.kind === 'reg' ? `r${where.n}` : `s${where.n}`);
const parseKey = (key) => ({ kind: key[0] === 'r' ? 'reg' : 'slot', n: Number(key.slice(1)) });

class FunctionGen {
  constructor(func, funcIndex, options = {}) {
    this.func = func;
    this.funcIndex = funcIndex;
    this.buf = new CodeBuffer();
    this.callSites = new Map();

    splitCriticalEdges(func);
    // `maxRegisters` exists so the spill paths *in this file* can be put under
    // real pressure. With the natural register file nothing in the corpus
    // spills, which means the code that loads a spilled operand, stores a
    // spilled result, and copies slot-to-slot across a phi edge would never
    // run -- and code that never runs is code whose passing tests mean
    // nothing. test/codegen-spill.test.js compiles and runs the whole corpus
    // with this squeezed down.
    //
    // `voidIntervals` is passed through for tools/bench.js, which compiles the
    // corpus with and without void instructions holding registers to measure
    // what dropping them cost in code; see liveIntervals.
    const natural = allocatableRegisters(func).registers;
    this.alloc = allocate(func, {
      ...(options.maxRegisters !== undefined ? { registers: natural.slice(0, options.maxRegisters) } : {}),
      voidIntervals: options.voidIntervals ?? false,
    });

    const problems = verifyAllocation(func, this.alloc);
    if (problems.length) {
      // The allocation being self-consistent is a precondition for the code
      // below meaning anything at all. Two live values sharing a register
      // produces a program that runs and quietly computes the wrong answer.
      throw new Error(`codegen: allocation for ${func.name} is not valid:\n  ${problems.join('\n  ')}`);
    }
  }

  /** Where a value lives. Constants live nowhere; they are materialised. */
  where(value) {
    const at = this.alloc.location.get(value);
    if (!at) throw new Error(`codegen: ${value.ref} (${value.op}) has no location`);
    return at;
  }

  /**
   * Get `value` into a register and return which one.
   *
   * `scratch` is the index into SCRATCH_REGS to use if one is needed. Callers
   * pass a distinct index per operand so two spilled operands of the same
   * instruction do not land on top of each other.
   */
  operand(value, scratch, span = null) {
    if (value.op === 'const') {
      const reg = SCRATCH_REGS[scratch];
      this.buf.emit(OP.CONST, reg, value.imm | 0, 0, span);
      return reg;
    }
    const at = this.where(value);
    if (at.kind === 'reg') return at.n;
    const reg = SCRATCH_REGS[scratch];
    this.buf.emit(OP.LDSLOT, reg, at.n, 0, span);
    return reg;
  }

  /**
   * The register to compute an instruction's result into, and whether it has
   * to be stored afterwards.
   *
   * A result with a register is computed in place -- no load, no store. The VM
   * reads an instruction's operands before writing its destination, so reusing
   * a scratch register that currently holds an operand is safe.
   */
  destination(instr) {
    const at = this.where(instr);
    if (at.kind === 'reg') return { reg: at.n, slot: null };
    return { reg: SCRATCH_REGS[0], slot: at.n };
  }

  finishDestination(dest, span) {
    if (dest.slot !== null) this.buf.emit(OP.STSLOT, dest.slot, dest.reg, 0, span);
  }

  generate() {
    const func = this.func;

    // Parameters arrive in r0 upward. Their allocated homes are never those
    // registers, so these moves cannot tread on one another.
    func.params.forEach((param, i) => {
      const at = this.where(param);
      if (at.kind === 'reg') {
        if (at.n !== i) this.buf.emit(OP.MOVE, at.n, i, 0, null);
      } else {
        this.buf.emit(OP.STSLOT, at.n, i, 0, null);
      }
    });

    const labels = new Map();
    for (const block of blockOrder(func)) {
      labels.set(block.label, this.buf.length);
      for (const instr of block.instrs) this.instruction(instr);
      this.terminator(block);
    }

    this.buf.patch(labels);
    const { code, spans } = this.buf.finish();
    return {
      name: func.name,
      nparams: func.params.length,
      nslots: Math.max(1, this.alloc.slots),
      code,
      spans,
      callSites: this.callSites,
      // Reported so the benchmark can say what allocation actually did.
      spills: this.alloc.spills,
      registersUsed: this.alloc.registersUsed,
    };
  }

  instruction(instr) {
    const span = instr.span;
    switch (instr.op) {
      case 'const':
        // Nothing to emit. A constant is materialised at each use by
        // operand(), which is one instruction either way and costs no
        // register, so the allocator deliberately gives constants no location
        // and the definition site has no work to do. A constant nobody uses
        // therefore disappears entirely.
        return;

      case 'binop': {
        const a = this.operand(instr.args[0], 0, span);
        const b = this.operand(instr.args[1], 1, span);
        const dest = this.destination(instr);
        this.buf.emit(BINOP_TO_OP[instr.imm], dest.reg, a, b, span);
        this.finishDestination(dest, span);
        return;
      }

      case 'unop': {
        const a = this.operand(instr.args[0], 0, span);
        const dest = this.destination(instr);
        this.buf.emit(UNOP_TO_OP[instr.imm], dest.reg, a, 0, span);
        this.finishDestination(dest, span);
        return;
      }

      case 'alloc': {
        const dest = this.destination(instr);
        this.buf.emit(OP.ALLOC, dest.reg, instr.imm, 0, span);
        this.finishDestination(dest, span);
        return;
      }

      case 'load': {
        const array = this.operand(instr.args[0], 0, span);
        const index = this.operand(instr.args[1], 1, span);
        const dest = this.destination(instr);
        this.buf.emit(OP.LOAD, dest.reg, array, index, span);
        this.finishDestination(dest, span);
        return;
      }

      case 'store': {
        // The case the third scratch register exists for.
        const array = this.operand(instr.args[0], 0, span);
        const index = this.operand(instr.args[1], 1, span);
        const value = this.operand(instr.args[2], 2, span);
        this.buf.emit(OP.STORE, array, index, value, span);
        return;
      }

      case 'print':
      case 'putchar': {
        const value = this.operand(instr.args[0], 0, span);
        this.buf.emit(instr.op === 'print' ? OP.PRINT : OP.PUTCHAR, value, 0, 0, span);
        return;
      }

      case 'call': {
        if (instr.args.length > MAX_ARGS) {
          throw new Error(`codegen: ${instr.imm} takes ${instr.args.length} arguments, more than the ${MAX_ARGS} a call can pass`);
        }
        // Arguments go to r0 upward. Nothing allocated lives there, so loading
        // them in order cannot destroy a value a later argument still needs.
        instr.args.forEach((arg, i) => {
          if (arg.op === 'const') {
            this.buf.emit(OP.CONST, i, arg.imm | 0, 0, span);
            return;
          }
          const at = this.where(arg);
          if (at.kind === 'reg') this.buf.emit(OP.MOVE, i, at.n, 0, span);
          else this.buf.emit(OP.LDSLOT, i, at.n, 0, span);
        });

        const dest = instr.type === 'void' ? { reg: SCRATCH_REGS[0], slot: null } : this.destination(instr);
        const at = this.buf.emit(OP.CALL, dest.reg, 0, instr.args.length, span);
        this.callSites.set(at, instr.imm);
        if (instr.type !== 'void') this.finishDestination(dest, span);
        return;
      }

      default:
        throw new Error(`codegen: unhandled instruction ${instr.op}`);
    }
  }

  /** Move one location to another, through a register when both are slots. */
  moveLocation(dstKey, srcKey, span = null) {
    const dst = parseKey(dstKey);
    const src = parseKey(srcKey);
    if (dst.kind === 'reg' && src.kind === 'reg') {
      if (dst.n !== src.n) this.buf.emit(OP.MOVE, dst.n, src.n, 0, span);
      return;
    }
    if (dst.kind === 'reg') {
      this.buf.emit(OP.LDSLOT, dst.n, src.n, 0, span);
      return;
    }
    if (src.kind === 'reg') {
      this.buf.emit(OP.STSLOT, dst.n, src.n, 0, span);
      return;
    }
    this.buf.emit(OP.LDSLOT, SCRATCH_REGS[0], src.n, 0, span);
    this.buf.emit(OP.STSLOT, dst.n, SCRATCH_REGS[0], 0, span);
  }

  /**
   * The copies a phi needs, performed on the edge into `to`.
   *
   * They happen simultaneously, so they are ordered by sequenceCopies, which
   * breaks cycles through r15. Sources and destinations are location keys now
   * rather than slot numbers, which is the same comparison by identity the
   * sequencer already did -- a swap between two registers is the same problem
   * as a swap between two slots and gets the same treatment.
   */
  emitEdgeCopies(from, to) {
    const copies = edgeCopies(to).get(from);
    if (!copies || copies.length === 0) return;

    const moves = [];
    const constants = [];
    for (const [phi, value] of copies) {
      const dst = keyOf(this.where(phi));
      if (value.op === 'const') constants.push([dst, value.imm | 0]);
      else moves.push([dst, keyOf(this.where(value))]);
    }

    for (const step of sequenceCopies(moves)) {
      if (step.toTemp) {
        const src = parseKey(step.src);
        if (src.kind === 'reg') this.buf.emit(OP.MOVE, SCRATCH_REG, src.n);
        else this.buf.emit(OP.LDSLOT, SCRATCH_REG, src.n);
        continue;
      }
      if (step.fromTemp) {
        const dst = parseKey(step.dst);
        if (dst.kind === 'reg') this.buf.emit(OP.MOVE, dst.n, SCRATCH_REG);
        else this.buf.emit(OP.STSLOT, dst.n, SCRATCH_REG);
        continue;
      }
      this.moveLocation(step.dst, step.src);
    }

    // Constants read nothing, so they carry no ordering constraint of their
    // own -- but their destination may be read by the moves above, so they go
    // last.
    for (const [dstKey, imm] of constants) {
      const dst = parseKey(dstKey);
      if (dst.kind === 'reg') this.buf.emit(OP.CONST, dst.n, imm);
      else {
        this.buf.emit(OP.CONST, SCRATCH_REGS[0], imm);
        this.buf.emit(OP.STSLOT, dst.n, SCRATCH_REGS[0]);
      }
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
        // The condition is read before any copies run, and critical edges have
        // been split, so each side's copies live in a block of their own.
        const cond = this.operand(term.args[0], 0, term.span);
        this.buf.emitTo(OP.BRZ, term.imm.otherwise.label, { a: cond, slot: 2, span: term.span });
        this.emitEdgeCopies(block, term.imm.then);
        this.buf.emitTo(OP.JMP, term.imm.then.label, { slot: 1, span: term.span });
        return;
      }

      case 'ret':
        if (term.args.length) {
          const value = this.operand(term.args[0], 0, term.span);
          this.buf.emit(OP.RET, value, 0, 0, term.span);
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
 * Returns { funcs, mainIndex, indexOf }: functions in declaration order, each
 * with its code, the slots its frame needs, a span per instruction so a trap
 * can say where it happened, and what allocation did to it.
 */
export function generate(module, options = {}) {
  const funcs = [...module.funcs.values()];
  const indexOf = new Map(funcs.map((f, i) => [f.name, i]));

  const compiled = funcs.map((func, i) => new FunctionGen(func, i, options).generate());

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
