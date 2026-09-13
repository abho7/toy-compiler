// The IR interpreter: the second executable semantics.
//
// It exists to separate two questions that would otherwise be answered by one
// test. When the bytecode VM disagrees with the reference interpreter, the
// fault is either in lowering the syntax tree to IR or in generating code from
// it -- and running the IR directly says which. Every optimization pass is also
// checked here first, where a failure points at an instruction rather than at a
// byte of output.
//
// It must produce *identical* observable behaviour to src/interp/ast-interp.js:
// the same output bytes, the same trap kind at the same source span, the same
// exit status. Not "equivalent" -- identical, because the differential harness
// compares bytes. That is why the trap spans are carried on instructions and
// why the call-depth limit counts frames the same way, main included.

import { TRAP, Trap, MAX_CALL_DEPTH } from '../traps.js';
import { evalBinop, evalUnop, isTrap } from '../values.js';

class TrapSignal extends Error {
  constructor(trap) {
    super(String(trap));
    this.trap = trap;
  }
}

class BudgetSignal extends Error {}

export const DEFAULT_MAX_STEPS = 20_000_000;

class IRInterpreter {
  constructor(module, maxSteps) {
    this.module = module;
    this.out = [];
    this.steps = 0;
    this.maxSteps = maxSteps;
    this.depth = 0;
  }

  step() {
    if (++this.steps > this.maxSteps) throw new BudgetSignal();
  }

  trap(kind, span, detail = null) {
    throw new TrapSignal(new Trap(kind, span, detail));
  }

  call(func, args, span) {
    if (this.depth >= MAX_CALL_DEPTH) {
      this.trap(TRAP.STACK_OVERFLOW, span, `call depth ${MAX_CALL_DEPTH}`);
    }
    this.depth++;
    const result = this.runFunc(func, args);
    this.depth--;
    return result;
  }

  runFunc(func, args) {
    // One map per frame, from value to its result. SSA means a value is
    // assigned once per frame, so nothing here is ever overwritten except by
    // re-entering a loop, which re-executes the instructions that define it.
    const values = new Map();
    func.params.forEach((param, i) => values.set(param, args[i]));

    let block = func.entry;
    let previous = null;

    for (;;) {
      // Phis are the values that arrived from the predecessor, and they all
      // read the *incoming* frame, so they are computed together before any of
      // them is stored. Doing them one at a time would let an earlier phi feed
      // a later one in the same block, which is not what a phi means.
      if (block.phis.length) {
        const arriving = block.phis.map((phi) => {
          const pair = phi.incoming.find(([from]) => from === previous);
          if (!pair) {
            throw new Error(`ir interp: ${phi.ref} has no operand for ${previous?.label}`);
          }
          return [phi, this.valueOf(pair[1], values)];
        });
        for (const [phi, value] of arriving) values.set(phi, value);
      }

      for (const instr of block.instrs) {
        this.step();
        this.exec(instr, values);
      }

      this.step();
      const term = block.term;
      if (term.op === 'ret') {
        return term.args.length ? this.valueOf(term.args[0], values) : 0;
      }
      if (term.op === 'jump') {
        previous = block;
        block = term.imm;
        continue;
      }
      // branch
      const cond = this.valueOf(term.args[0], values);
      previous = block;
      block = cond !== 0 ? term.imm.then : term.imm.otherwise;
    }
  }

  valueOf(value, values) {
    if (value.op === 'const') return value.imm;
    if (!values.has(value)) {
      throw new Error(`ir interp: ${value.ref} (${value.op}) was used before it was computed`);
    }
    return values.get(value);
  }

  exec(instr, values) {
    const arg = (i) => this.valueOf(instr.args[i], values);

    switch (instr.op) {
      case 'const':
        values.set(instr, instr.imm);
        return;

      case 'binop': {
        const r = evalBinop(instr.imm, arg(0), arg(1));
        if (isTrap(r)) this.trap(r.trap, instr.span, `${arg(0)} ${instr.imm} ${arg(1)}`);
        values.set(instr, r.value);
        return;
      }

      case 'unop':
        values.set(instr, evalUnop(instr.imm, arg(0)).value);
        return;

      case 'alloc':
        values.set(instr, new Int32Array(instr.imm));
        return;

      case 'load': {
        const array = arg(0);
        const index = arg(1);
        this.checkBounds(array, index, instr.span);
        values.set(instr, array[index]);
        return;
      }

      case 'store': {
        const array = arg(0);
        const index = arg(1);
        const value = arg(2);
        this.checkBounds(array, index, instr.span);
        array[index] = value;
        return;
      }

      case 'print':
        for (const ch of String(arg(0))) this.out.push(ch.charCodeAt(0));
        this.out.push(10);
        return;

      case 'putchar':
        this.out.push(((arg(0) % 256) + 256) % 256);
        return;

      case 'call': {
        const args = instr.args.map((_, i) => arg(i));
        const callee = this.module.funcs.get(instr.imm);
        const result = this.call(callee, args, instr.span);
        if (instr.type !== 'void') values.set(instr, result);
        return;
      }

      default:
        throw new Error(`ir interp: unhandled op ${instr.op}`);
    }
  }

  checkBounds(array, index, span) {
    if (index < 0 || index >= array.length) {
      this.trap(TRAP.OUT_OF_BOUNDS, span, `index ${index}, length ${array.length}`);
    }
  }
}

/** Run an IR module, returning the same shape the reference interpreter does. */
export function runModule(module, { maxSteps = DEFAULT_MAX_STEPS } = {}) {
  const interp = new IRInterpreter(module, maxSteps);
  const main = module.funcs.get('main');
  if (!main) throw new Error('runModule: the module has no main');

  try {
    const value = interp.call(main, [], null);
    return {
      output: Uint8Array.from(interp.out),
      outcome: 'exit',
      status: ((value % 256) + 256) % 256,
      trap: null,
      steps: interp.steps,
    };
  } catch (error) {
    if (error instanceof TrapSignal) {
      return {
        output: Uint8Array.from(interp.out), outcome: 'trap', status: null,
        trap: error.trap, steps: interp.steps,
      };
    }
    if (error instanceof BudgetSignal) {
      return {
        output: Uint8Array.from(interp.out), outcome: 'budget', status: null,
        trap: null, steps: interp.steps,
      };
    }
    throw error;
  }
}
