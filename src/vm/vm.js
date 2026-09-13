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
  }

  trap(kind, span, detail = null) {
    throw new TrapSignal(new Trap(kind, span, detail));
  }

  run() {
    const main = this.program.funcs[this.program.mainIndex];
    let frame = new Frame(main, null, 0, 0);
    let depth = 1;

    for (;;) {
      if (++this.steps > this.maxSteps) throw new BudgetSignal();

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
          if (depth >= MAX_CALL_DEPTH) {
            this.trap(TRAP.STACK_OVERFLOW, frame.func.spans[at], `call depth ${MAX_CALL_DEPTH}`);
          }
          const callee = this.program.funcs[b];
          const next = new Frame(callee, frame, frame.pc, a);
          // Arguments were left in r0 upward by the caller.
          for (let i = 0; i < c; i++) next.regs[i] = regs[i];
          frame = next;
          depth++;
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
          frame = caller;
          depth--;
          break;
        }

        case OP.JMP: frame.pc = a; break;
        case OP.BRZ: if (regs[a] === 0) frame.pc = b; break;

        default:
          throw new Error(`vm: unknown opcode ${op} at ${at} in ${frame.func.name}`);
      }
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
