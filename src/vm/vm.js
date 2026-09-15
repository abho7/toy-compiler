// The virtual machine.
//
// A loop over an explicit frame stack: no host recursion, so the call depth the
// language specifies is the depth the VM enforces, exactly, on every host. That
// matters because the reference interpreter had to have its limit lowered to
// something a tree-walker could reach -- if the VM disagreed by even one frame,
// deeply recursive programs would behave differently here than under the
// oracle, and the differential harness would be comparing two languages.
//
// Arithmetic: division and remainder go through evalBinop in src/values.js,
// because truncation, INT_MIN/-1 and the sign of a remainder are the parts
// worth having in exactly one place. The rest is inlined, since JavaScript's
// operators on int32 are already the semantics the document specifies -- and
// test/vm.test.js checks every inlined opcode against the kernel over the
// boundary values rather than taking that on trust.
//
// `run` and `step` are the same switch. The playground needs to show the
// machine between instructions, which a monolithic loop cannot do, so the loop
// state lives on the instance and `run` is a loop over `step`. The alternative
// -- a second, steppable interpreter for the UI -- would be a second semantics
// free to drift from this one, which is the thing this project refuses. The
// cost is a method call per instruction, and it was measured rather than
// assumed: the pre-refactor VM and this one, loaded side by side in one process
// and run interleaved on the same bytecode, medians of nine warmed runs. About
// 1.2x slower where the timing means anything -- 1.16x on fib.mc at 219k steps,
// 1.29x on nqueens.mc at 76k. Programs under a few thousand steps sit below the
// noise floor and report ratios on both sides of 1.0, so they are not evidence
// in either direction. Instruction counts are identical, which is the metric
// that encodes the semantics; the 1.2x is tooling time, and it makes a long
// campaign proportionally slower.

import { TRAP, Trap, MAX_CALL_DEPTH } from '../traps.js';
import { evalBinop, isTrap } from '../values.js';
import { OP, WORDS_PER_INSTR, REGISTERS } from './bytecode.js';

class TrapSignal extends Error {
  constructor(trap) {
    super(String(trap));
    this.trap = trap;
  }
}

class BudgetSignal extends Error {}

export const DEFAULT_MAX_STEPS = 20_000_000;

class Frame {
  constructor(func, returnTo, returnPc, returnReg) {
    this.func = func;
    this.slots = new Int32Array(func.nslots);
    this.regs = new Int32Array(REGISTERS);
    this.pc = 0;
    this.returnTo = returnTo;     // the frame to resume, or null for main
    this.returnPc = returnPc;
    this.returnReg = returnReg;   // where the caller wants the result
  }
}

class VM {
  constructor(program, maxSteps) {
    this.program = program;
    this.maxSteps = maxSteps;
    this.out = [];
    this.steps = 0;
    this.heap = [];               // arrays, referred to by integer handle
    this.frame = null;            // the running frame; set by start()
    this.depth = 0;
  }

  trap(kind, span, detail = null) {
    throw new TrapSignal(new Trap(kind, span, detail));
  }

  /** Build main's frame. Must happen before the first step. */
  start() {
    const main = this.program.funcs[this.program.mainIndex];
    this.frame = new Frame(main, null, 0, 0);
    this.depth = 1;
    return this;
  }

  /**
   * Execute one instruction.
   *
   * Returns null while the program is still running, or { value, steps } when
   * main returns. A trap or an exhausted budget leaves by throwing, exactly as
   * before, so every caller sees the same outcomes.
   */
  step() {
    if (++this.steps > this.maxSteps) throw new BudgetSignal();

    const frame = this.frame;
    const code = frame.func.code;
    const at = frame.pc;
    const base = at * WORDS_PER_INSTR;
    const op = code[base];
    const a = code[base + 1];
    const b = code[base + 2];
    const c = code[base + 3];
    const regs = frame.regs;
    frame.pc++;

    switch (op) {
      case OP.CONST: regs[a] = b; break;
      case OP.MOVE: regs[a] = regs[b]; break;
      case OP.LDSLOT: regs[a] = frame.slots[b]; break;
      case OP.STSLOT: frame.slots[a] = regs[b]; break;

      case OP.ADD: regs[a] = (regs[b] + regs[c]) | 0; break;
      case OP.SUB: regs[a] = (regs[b] - regs[c]) | 0; break;
      case OP.MUL: regs[a] = Math.imul(regs[b], regs[c]); break;
      case OP.DIV: case OP.MOD: {
        const r = evalBinop(op === OP.DIV ? '/' : '%', regs[b], regs[c]);
        if (isTrap(r)) {
          this.trap(r.trap, frame.func.spans[at], `${regs[b]} ${op === OP.DIV ? '/' : '%'} ${regs[c]}`);
        }
        regs[a] = r.value;
        break;
      }
      case OP.SHL: regs[a] = regs[b] << regs[c]; break;
      case OP.SHR: regs[a] = regs[b] >> regs[c]; break;
      case OP.AND: regs[a] = regs[b] & regs[c]; break;
      case OP.OR: regs[a] = regs[b] | regs[c]; break;
      case OP.XOR: regs[a] = regs[b] ^ regs[c]; break;
      case OP.EQ: regs[a] = regs[b] === regs[c] ? 1 : 0; break;
      case OP.NE: regs[a] = regs[b] !== regs[c] ? 1 : 0; break;
      case OP.LT: regs[a] = regs[b] < regs[c] ? 1 : 0; break;
      case OP.LE: regs[a] = regs[b] <= regs[c] ? 1 : 0; break;
      case OP.GT: regs[a] = regs[b] > regs[c] ? 1 : 0; break;
      case OP.GE: regs[a] = regs[b] >= regs[c] ? 1 : 0; break;
      case OP.NEG: regs[a] = (-regs[b]) | 0; break;
      case OP.NOT: regs[a] = regs[b] === 0 ? 1 : 0; break;
      case OP.BNOT: regs[a] = ~regs[b]; break;

      case OP.ALLOC:
        this.heap.push(new Int32Array(b));
        regs[a] = this.heap.length - 1;
        break;

      case OP.LOAD: {
        const array = this.heap[regs[b]];
        const index = regs[c];
        if (index < 0 || index >= array.length) {
          this.trap(TRAP.OUT_OF_BOUNDS, frame.func.spans[at], `index ${index}, length ${array.length}`);
        }
        regs[a] = array[index];
        break;
      }

      case OP.STORE: {
        const array = this.heap[regs[a]];
        const index = regs[b];
        if (index < 0 || index >= array.length) {
          this.trap(TRAP.OUT_OF_BOUNDS, frame.func.spans[at], `index ${index}, length ${array.length}`);
        }
        array[index] = regs[c];
        break;
      }

      case OP.PRINT:
        for (const ch of String(regs[a])) this.out.push(ch.charCodeAt(0));
        this.out.push(10);
        break;

      case OP.PUTCHAR:
        this.out.push(((regs[a] % 256) + 256) % 256);
        break;

      case OP.CALL: {
        if (this.depth >= MAX_CALL_DEPTH) {
          this.trap(TRAP.STACK_OVERFLOW, frame.func.spans[at], `call depth ${MAX_CALL_DEPTH}`);
        }
        const callee = this.program.funcs[b];
        const next = new Frame(callee, frame, frame.pc, a);
        // Arguments were left in r0 upward by the caller.
        for (let i = 0; i < c; i++) next.regs[i] = regs[i];
        this.frame = next;
        this.depth++;
        break;
      }

      case OP.RET:
      case OP.RETVOID: {
        const value = op === OP.RET ? regs[a] : 0;
        if (!frame.returnTo) {
          return { value, steps: this.steps };
        }
        const caller = frame.returnTo;
        caller.regs[frame.returnReg] = value;
        caller.pc = frame.returnPc;
        this.frame = caller;
        this.depth--;
        break;
      }

      case OP.JMP: frame.pc = a; break;
      case OP.BRZ: if (regs[a] === 0) frame.pc = b; break;

      default:
        throw new Error(`vm: unknown opcode ${op} at ${at} in ${frame.func.name}`);
    }

    return null;
  }

  run() {
    this.start();
    for (;;) {
      const done = this.step();
      if (done) return done;
    }
  }
}

/** Run a bytecode program, returning the same shape the interpreters do. */
export function runBytecode(program, { maxSteps = DEFAULT_MAX_STEPS } = {}) {
  const vm = new VM(program, maxSteps);
  try {
    const { value, steps } = vm.run();
    return {
      output: Uint8Array.from(vm.out),
      outcome: 'exit',
      status: ((value % 256) + 256) % 256,
      trap: null,
      steps,
    };
  } catch (error) {
    if (error instanceof TrapSignal) {
      return {
        output: Uint8Array.from(vm.out), outcome: 'trap', status: null,
        trap: error.trap, steps: vm.steps,
      };
    }
    if (error instanceof BudgetSignal) {
      return {
        output: Uint8Array.from(vm.out), outcome: 'budget', status: null,
        trap: null, steps: vm.steps,
      };
    }
    throw error;
  }
}

/**
 * A VM that can be driven one instruction at a time.
 *
 * This is the same machine `runBytecode` uses, stepped by hand rather than in a
 * loop: the playground shows registers, slots, the frame stack and the output
 * as they change, which needs the state between two instructions. Nothing here
 * re-implements an opcode.
 *
 * `state().pc` is the index of the instruction *about to* execute, so a UI can
 * highlight what happens next rather than what just happened.
 */
export function createStepper(program, { maxSteps = DEFAULT_MAX_STEPS } = {}) {
  const vm = new VM(program, maxSteps);
  vm.start();
  let finished = null;

  /** The call stack, innermost first, as names and return positions. */
  const stackOf = () => {
    const frames = [];
    for (let f = vm.frame; f; f = f.returnTo) {
      frames.push({ name: f.func.name, pc: f.pc, returnPc: f.returnTo ? f.returnPc : null });
    }
    return frames;
  };

  const state = () => ({
    finished,
    steps: vm.steps,
    depth: vm.depth,
    output: Uint8Array.from(vm.out),
    func: vm.frame ? vm.frame.func : null,
    pc: vm.frame ? vm.frame.pc : null,
    regs: vm.frame ? Array.from(vm.frame.regs) : [],
    slots: vm.frame ? Array.from(vm.frame.slots) : [],
    arrays: vm.heap.map((array) => Array.from(array)),
    stack: stackOf(),
  });

  return {
    state,
    /** Advance one instruction, returning the state after it. */
    step() {
      if (finished) return state();
      try {
        const done = vm.step();
        if (done) {
          finished = {
            outcome: 'exit', status: ((done.value % 256) + 256) % 256, trap: null,
          };
        }
      } catch (error) {
        if (error instanceof TrapSignal) finished = { outcome: 'trap', status: null, trap: error.trap };
        else if (error instanceof BudgetSignal) finished = { outcome: 'budget', status: null, trap: null };
        else throw error;
      }
      return state();
    },
  };
}
