// The reference interpreter: docs/semantics.md, executed.
//
// This is the oracle. Everything the compiler produces later -- IR, optimized
// IR, bytecode -- is judged correct by agreeing with this, so it is written for
// obviousness rather than speed: one function per construct, in the order the
// document describes, with no cleverness that could quietly diverge from it.
//
// The three parts of observable behaviour, as the document defines them:
//
//   output   the bytes print() and putchar() produced
//   outcome  a clean exit, or a trap with a kind and a source span
//   status   main's return value, reduced into 0-255, when it exited cleanly
//
// A fourth outcome, 'budget', is not program behaviour: it means the harness
// stopped a program that ran too long. docs/semantics.md is explicit that this
// is a tooling limit, never reported as a trap or as a clean exit, so that a
// non-terminating program can never be mistaken for one that agreed.

import { TRAP, Trap, MAX_CALL_DEPTH } from '../traps.js';
import { evalBinop, evalUnop, isTrap } from '../values.js';
import { parse } from '../parser.js';
import { analyze } from '../sema.js';

/** Unwinds to the top: a trap abandons the whole program. */
class TrapSignal extends Error {
  constructor(trap) {
    super(String(trap));
    this.trap = trap;
  }
}

/** The harness stopping a runaway program. Not a program behaviour. */
class BudgetSignal extends Error {}

// Statement completions. `break` and `continue` are values rather than
// exceptions so that the control flow in this file mirrors the language's.
const NORMAL = { kind: 'normal' };
const BREAK = { kind: 'break' };
const CONTINUE = { kind: 'continue' };
const returning = (value) => ({ kind: 'return', value });

export const DEFAULT_MAX_STEPS = 20_000_000;

class Interpreter {
  constructor(program, maxSteps) {
    this.functions = new Map(program.functions.map((f) => [f.name, f]));
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

  // ------------------------------------------------------------- calling --

  call(fn, args, span) {
    // Checked before the frame is built, so the depth limit is the number of
    // frames that exist rather than the number that were attempted.
    if (this.depth >= MAX_CALL_DEPTH) {
      this.trap(TRAP.STACK_OVERFLOW, span, `call depth ${MAX_CALL_DEPTH}`);
    }
    // One slot per local and parameter; sema numbered them in declaration
    // order, so a name resolves to a slot with no lookup at run time.
    const frame = new Array(fn.locals.length).fill(0);
    fn.params.forEach((p, i) => { frame[p.symbol.id] = args[i]; });

    this.depth++;
    const completion = this.execBlock(fn.body, frame);
    this.depth--;

    // Falling off the end of a void function returns nothing; sema has already
    // established that a non-void function cannot get here.
    return completion.kind === 'return' ? completion.value ?? 0 : 0;
  }

  builtin(sig, args) {
    if (sig.name === 'print') {
      for (const ch of String(args[0])) this.out.push(ch.charCodeAt(0));
      this.out.push(10);
      return 0;
    }
    // putchar takes one byte: the value modulo 256, made non-negative.
    this.out.push(((args[0] % 256) + 256) % 256);
    return 0;
  }

  // ---------------------------------------------------------- statements --

  execBlock(block, frame) {
    for (const stmt of block.stmts) {
      const completion = this.exec(stmt, frame);
      if (completion.kind !== 'normal') return completion;
    }
    return NORMAL;
  }

  exec(node, frame) {
    this.step();
    switch (node.kind) {
      case 'Block':
        return this.execBlock(node, frame);

      case 'Empty':
        return NORMAL;

      case 'VarDecl':
        frame[node.symbol.id] = node.init ? this.eval(node.init, frame) : 0;
        return NORMAL;

      case 'ArrayDecl': {
        // A fresh array each time the declaration runs, zero-filled, then the
        // initializer elements in order.
        const array = new Int32Array(node.length);
        if (node.init) {
          node.init.forEach((element, i) => { array[i] = this.eval(element, frame); });
        }
        frame[node.symbol.id] = array;
        return NORMAL;
      }

      case 'If':
        if (this.eval(node.cond, frame) !== 0) return this.exec(node.then, frame);
        return node.otherwise ? this.exec(node.otherwise, frame) : NORMAL;

      case 'While':
        for (;;) {
          this.step();
          if (this.eval(node.cond, frame) === 0) return NORMAL;
          const completion = this.exec(node.body, frame);
          if (completion.kind === 'break') return NORMAL;
          if (completion.kind === 'return') return completion;
        }

      case 'For': {
        if (node.init) this.exec(node.init, frame);
        for (;;) {
          this.step();
          if (node.cond && this.eval(node.cond, frame) === 0) return NORMAL;
          const completion = this.exec(node.body, frame);
          if (completion.kind === 'break') return NORMAL;
          if (completion.kind === 'return') return completion;
          // `continue` runs the step expression, which is what separates a for
          // loop from a while loop with the step at the bottom of the body.
          if (node.step) this.eval(node.step, frame);
        }
      }

      case 'Break':
        return BREAK;

      case 'Continue':
        return CONTINUE;

      case 'Return':
        return returning(node.value ? this.eval(node.value, frame) : 0);

      case 'ExprStmt':
        this.eval(node.expr, frame);
        return NORMAL;

      default:
        throw new Error(`interpreter: unhandled statement ${node.kind}`);
    }
  }

  // --------------------------------------------------------- expressions --

  eval(node, frame) {
    this.step();
    switch (node.kind) {
      case 'IntLit':
        return node.value;

      case 'Name':
        return frame[node.symbol.id];

      case 'Index': {
        const array = this.eval(node.array, frame);
        const index = this.eval(node.index, frame);
        this.checkBounds(array, index, node.span);
        return array[index];
      }

      case 'Unary':
        return evalUnop(node.op, this.eval(node.operand, frame)).value;

      case 'Binary': {
        // Left before right, always: it decides which of two traps is seen.
        const a = this.eval(node.left, frame);
        const b = this.eval(node.right, frame);
        const r = evalBinop(node.op, a, b);
        if (isTrap(r)) this.trap(r.trap, node.span, `${a} ${node.op} ${b}`);
        return r.value;
      }

      case 'Logical': {
        // The right operand is not evaluated at all when the left decides the
        // answer, so a trap or a print on the right simply does not happen.
        const a = this.eval(node.left, frame);
        if (node.op === '&&' && a === 0) return 0;
        if (node.op === '||' && a !== 0) return 1;
        return this.eval(node.right, frame) !== 0 ? 1 : 0;
      }

      case 'Assign':
        return this.assign(node, frame);

      case 'Call': {
        const args = node.args.map((arg) => this.eval(arg, frame));   // left to right
        if (node.sig.builtin) return this.builtin(node.sig, args);
        return this.call(this.functions.get(node.sig.name), args, node.span);
      }

      default:
        throw new Error(`interpreter: unhandled expression ${node.kind}`);
    }
  }

  assign(node, frame) {
    const target = node.target;
    if (target.kind === 'Name') {
      const value = this.eval(node.value, frame);
      frame[target.symbol.id] = value;
      return value;
    }

    // docs/semantics.md fixes this order: index, then the value, then the
    // bounds check, then the store. So if the index is out of range *and*
    // evaluating the value traps, the value's trap is the one observed.
    const array = this.eval(target.array, frame);
    const index = this.eval(target.index, frame);
    const value = this.eval(node.value, frame);
    this.checkBounds(array, index, target.span);
    array[index] = value;
    return value;
  }

  checkBounds(array, index, span) {
    if (index < 0 || index >= array.length) {
      this.trap(TRAP.OUT_OF_BOUNDS, span, `index ${index}, length ${array.length}`);
    }
  }
}

/**
 * Run an analysed program.
 *
 * Returns the observable behaviour and the step count. The step count is not
 * observable -- it is how long the interpreter took, which optimization is
 * allowed to change -- but it is reported because the harness uses it.
 */
export function runProgram(program, { maxSteps = DEFAULT_MAX_STEPS } = {}) {
  const interp = new Interpreter(program, maxSteps);
  const main = interp.functions.get('main');
  if (!main) throw new Error('runProgram: the program has no main');

  try {
    const value = interp.call(main, [], main.span);
    return {
      output: Uint8Array.from(interp.out),
      outcome: 'exit',
      // As on POSIX: the low byte of what main returned.
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
    if (error instanceof RangeError) {
      // The host ran out of stack before the language's own limit, so this
      // implementation cannot produce the behaviour the document specifies.
      // Reported loudly rather than folded into a trap: a quiet answer here
      // would be a wrong one, and would disagree with every other
      // implementation of the same semantics.
      throw new Error(
        `host stack exhausted at minic call depth ${interp.depth}, below the language limit `
        + `of ${MAX_CALL_DEPTH}; this implementation cannot honour docs/semantics.md here`,
        { cause: error });
    }
    throw error;
  }
}

/** Parse, analyse and run. Throws CompileError if the program does not compile. */
export function runSource(source, options = {}) {
  const { program, diags } = parse(source);
  if (!diags.failed) analyze(program, diags);
  diags.throwIfFailed();
  return runProgram(program, options);
}

/**
 * The one-line summary of how a run ended, used as the last line of a golden
 * file and printed to stderr by the CLI.
 */
export function trailerOf(result) {
  switch (result.outcome) {
    case 'exit': return `=== exit ${result.status}`;
    case 'trap': {
      const at = result.trap.span ? ` at ${result.trap.span.line}:${result.trap.span.col}` : '';
      return `=== trap ${result.trap.kind}${at}`;
    }
    default: return `=== budget exceeded after ${result.steps} steps`;
  }
}

/**
 * A run as bytes: the output, then the trailer.
 *
 * This is what golden files hold and what the differential harness compares,
 * so that all three parts of observable behaviour are checked by one byte
 * comparison rather than by three separate assertions that could each be
 * forgotten.
 */
export function observationBytes(result) {
  const trailer = new TextEncoder().encode(`${trailerOf(result)}\n`);
  const bytes = new Uint8Array(result.output.length + trailer.length);
  bytes.set(result.output, 0);
  bytes.set(trailer, result.output.length);
  return bytes;
}
