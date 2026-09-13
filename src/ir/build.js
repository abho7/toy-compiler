// The checked syntax tree, lowered to SSA.
//
// SSA is constructed directly, by the method in Braun et al., "Simple and
// Efficient Construction of Static Single Assignment Form" (2013): each block
// records what it knows about each variable, a read that cannot be answered
// locally asks the predecessors, and a block with several predecessors answers
// with a phi. There is no separate dominance-frontier pass and no "insert phis
// everywhere then prune" step -- the phis that exist are the ones that were
// needed.
//
// Two things this file is careful about, both because the differential test
// compares bytes:
//
//   Evaluation order. Instructions are emitted in exactly the order
//   docs/semantics.md evaluates them, including the rule that `a[i] = e`
//   evaluates the index, then the value, then checks the bounds.
//
//   Spans. A trap reports where it happened, and that is observable, so each
//   instruction carries the span of the syntax it came from. A binop gets the
//   span of the whole binary expression, a load the span of the index
//   expression, a call the span of the call -- matching what the reference
//   interpreter reports, instruction for instruction.

import { Instr, Param, Func, Module } from './ir.js';

class Builder {
  constructor(program, functions) {
    this.program = program;
    this.functions = functions;
    this.module = new Module();
  }

  build() {
    for (const decl of this.program.functions) this.buildFunction(decl);
    return this.module;
  }

  buildFunction(decl) {
    const func = new Func(decl.name, decl.returnType);
    this.func = func;
    this.loops = [];

    decl.params.forEach((p, i) => {
      const param = new Param(p.name, p.type === 'int[]' ? 'array' : 'int', i);
      func.params.push(param);
    });

    func.entry = func.addBlock('entry');
    func.entry.sealed = true;
    this.current = func.entry;
    decl.params.forEach((p, i) => this.write(p.symbol, func.entry, func.params[i]));

    this.stmt(decl.body);

    // A void function may fall off the end; sema has established that a
    // non-void one cannot, so the value here is never observed.
    if (this.current) this.terminate(new Instr('ret', { type: 'void', args: [] }));

    this.module.funcs.set(decl.name, func);
    return func;
  }

  // ------------------------------------------------- blocks and emission --

  emit(instr) {
    if (!this.current) return instr;   // unreachable code: built but not kept
    instr.block = this.current;
    this.current.instrs.push(instr);
    return instr;
  }

  terminate(instr) {
    if (!this.current) return;
    instr.block = this.current;
    this.current.term = instr;
    for (const successor of this.current.successors) successor.preds.push(this.current);
    this.current = null;
  }

  /** Start building in `block`, which becomes the place instructions go. */
  at(block) {
    this.current = block;
  }

  // --------------------------------------------- variables, as SSA values --

  write(symbol, block, value) {
    block.defs.set(symbol.id, value);
  }

  read(symbol, block) {
    if (block.defs.has(symbol.id)) return block.defs.get(symbol.id);
    return this.readRecursive(symbol, block);
  }

  readRecursive(symbol, block) {
    let value;
    if (!block.sealed) {
      // The predecessors are not all known yet -- this is a loop header. Leave
      // a phi to be filled in when the block is sealed.
      value = this.addPhi(block, symbol);
      block.incompletePhis.set(symbol.id, value);
    } else if (block.preds.length === 1) {
      value = this.read(symbol, block.preds[0]);
    } else {
      // Break potential cycles by defining the phi before reading operands.
      const phi = this.addPhi(block, symbol);
      this.write(symbol, block, phi);
      value = this.addPhiOperands(symbol, phi);
    }
    this.write(symbol, block, value);
    return value;
  }

  addPhi(block, symbol) {
    const phi = new Instr('phi', {
      type: symbol.type === 'int[]' ? 'array' : 'int',
      incoming: [],
    });
    phi.block = block;
    phi.symbol = symbol;
    block.phis.push(phi);
    return phi;
  }

  addPhiOperands(symbol, phi) {
    // Filling a phi in a block with no predecessors leaves it with no operands
    // at all, and it then survives tryRemoveTrivialPhi -- there is no single
    // distinct operand to collapse to -- so it strands in the block as a value
    // that came from nowhere. Always a construction bug, so it is loud.
    if (phi.block.preds.length === 0 && phi.block !== this.func.entry) {
      throw new Error(
        `ir: filling phi for '${symbol.name}' in ${phi.block.label}, which has no predecessors yet`);
    }
    for (const pred of phi.block.preds) {
      phi.incoming.push([pred, this.read(symbol, pred)]);
    }
    return this.tryRemoveTrivialPhi(phi);
  }

  /**
   * A phi whose operands are all the same value (ignoring itself) says nothing;
   * it is replaced by that value. Without this the IR fills with phis that
   * merge a value with itself, and every later pass pays for them.
   */
  tryRemoveTrivialPhi(phi) {
    let same = null;
    for (const [, value] of phi.incoming) {
      if (value === phi || value === same) continue;
      if (same !== null) return phi;      // two distinct operands: a real phi
      same = value;
    }
    if (same === null) return phi;        // unreachable, or defined by itself

    const block = phi.block;
    // Spliced rather than filtered into a new array, for the same reason
    // replaceUses edits in place: this can run while an outer fill is walking
    // block.phis, and swapping the array out from under it loses the edit.
    const at = block.phis.indexOf(phi);
    if (at >= 0) block.phis.splice(at, 1);
    // Anything that referred to this phi now refers to its single operand.
    this.replaceUses(phi, same);
    return same;
  }

  /**
   * Rewrite every reference to `oldValue` so it refers to `newValue`.
   *
   * Everything here is edited **in place**. Rebuilding `incoming` or `args`
   * with map() would swap the array out from under any loop currently pushing
   * into it, and one such loop is always possible: collapsing a trivial phi can
   * happen while an outer phi is still being filled, since filling reads the
   * predecessors recursively. That is precisely how two phis in vm.mc ended up
   * with no operands at all -- their fills pushed into arrays that this
   * function had already discarded.
   */
  replaceUses(oldValue, newValue) {
    for (const block of this.func.blocks) {
      for (const [key, value] of block.defs) {
        if (value === oldValue) block.defs.set(key, newValue);
      }
      for (const phi of block.phis) {
        for (const pair of phi.incoming) {
          if (pair[1] === oldValue) pair[1] = newValue;
        }
      }
      for (const instr of [...block.instrs, block.term].filter(Boolean)) {
        for (let i = 0; i < instr.args.length; i++) {
          if (instr.args[i] === oldValue) instr.args[i] = newValue;
        }
      }
    }
  }

  /** All predecessors of `block` are known: fill in any phis left open. */
  seal(block) {
    for (const [symbolId, phi] of block.incompletePhis) {
      this.addPhiOperands(phi.symbol, phi);
      // addPhiOperands may have replaced the phi with a trivial operand.
      void symbolId;
    }
    block.incompletePhis.clear();
    block.sealed = true;
  }

  // ---------------------------------------------------------- statements --

  stmt(node) {
    if (!node || !this.current) return;
    switch (node.kind) {
      case 'Block':
        for (const s of node.stmts) this.stmt(s);
        return;

      case 'Empty':
        return;

      case 'VarDecl': {
        const value = node.init
          ? this.expr(node.init)
          : this.emit(new Instr('const', { imm: 0, span: node.span }));
        this.write(node.symbol, this.current, value);
        return;
      }

      case 'ArrayDecl': {
        const array = this.emit(new Instr('alloc', {
          type: 'array', imm: node.length, span: node.span,
        }));
        this.write(node.symbol, this.current, array);
        if (node.init) {
          node.init.forEach((element, i) => {
            const value = this.expr(element);
            const index = this.emit(new Instr('const', { imm: i, span: element.span }));
            this.emit(new Instr('store', {
              type: 'void', args: [array, index, value], span: element.span,
            }));
          });
        }
        return;
      }

      case 'If': return this.ifStmt(node);
      case 'While': return this.whileStmt(node);
      case 'For': return this.forStmt(node);

      case 'Break': {
        const loop = this.loops[this.loops.length - 1];
        this.terminate(new Instr('jump', { type: 'void', imm: loop.exit, span: node.span }));
        return;
      }

      case 'Continue': {
        const loop = this.loops[this.loops.length - 1];
        this.terminate(new Instr('jump', { type: 'void', imm: loop.continueTo, span: node.span }));
        return;
      }

      case 'Return': {
        const args = node.value ? [this.expr(node.value)] : [];
        this.terminate(new Instr('ret', { type: 'void', args, span: node.span }));
        return;
      }

      case 'ExprStmt':
        this.expr(node.expr);
        return;

      default:
        throw new Error(`ir: unhandled statement ${node.kind}`);
    }
  }

  ifStmt(node) {
    const cond = this.truthy(node.cond);
    const thenBlock = this.func.addBlock('then');
    const elseBlock = node.otherwise ? this.func.addBlock('else') : null;
    const joinBlock = this.func.addBlock('join');

    this.terminate(new Instr('branch', {
      type: 'void', args: [cond], span: node.span,
      imm: { then: thenBlock, otherwise: elseBlock ?? joinBlock },
    }));
    thenBlock.sealed = true;
    if (elseBlock) elseBlock.sealed = true;

    this.at(thenBlock);
    this.stmt(node.then);
    if (this.current) this.terminate(new Instr('jump', { type: 'void', imm: joinBlock }));

    if (elseBlock) {
      this.at(elseBlock);
      this.stmt(node.otherwise);
      if (this.current) this.terminate(new Instr('jump', { type: 'void', imm: joinBlock }));
    }

    // If both arms returned, nothing reaches the join and it is not kept.
    if (joinBlock.preds.length === 0) {
      this.func.blocks = this.func.blocks.filter((b) => b !== joinBlock);
      this.current = null;
      return;
    }
    this.seal(joinBlock);
    this.at(joinBlock);
  }

  whileStmt(node) {
    const header = this.func.addBlock('loop');
    const body = this.func.addBlock('body');
    const exit = this.func.addBlock('exit');

    this.terminate(new Instr('jump', { type: 'void', imm: header, span: node.span }));
    // The header is left unsealed: the back edge from the body is not known
    // yet, and sealing early would answer reads with the wrong value.
    this.at(header);
    const cond = this.truthy(node.cond);
    this.terminate(new Instr('branch', {
      type: 'void', args: [cond], span: node.span, imm: { then: body, otherwise: exit },
    }));
    body.sealed = true;

    this.loops.push({ exit, continueTo: header });
    this.at(body);
    this.stmt(node.body);
    if (this.current) this.terminate(new Instr('jump', { type: 'void', imm: header }));
    this.loops.pop();

    this.seal(header);
    this.seal(exit);
    this.at(exit);
  }

  forStmt(node) {
    if (node.init) this.stmt(node.init);
    const header = this.func.addBlock('loop');
    const body = this.func.addBlock('body');
    const stepBlock = this.func.addBlock('step');
    const exit = this.func.addBlock('exit');

    this.terminate(new Instr('jump', { type: 'void', imm: header, span: node.span }));
    this.at(header);
    if (node.cond) {
      const cond = this.truthy(node.cond);
      this.terminate(new Instr('branch', {
        type: 'void', args: [cond], span: node.span, imm: { then: body, otherwise: exit },
      }));
    } else {
      this.terminate(new Instr('jump', { type: 'void', imm: body, span: node.span }));
    }
    body.sealed = true;

    // `continue` goes to the step, not the header: that is what makes a for
    // loop different from a while loop with the step written at the bottom.
    this.loops.push({ exit, continueTo: stepBlock });
    this.at(body);
    this.stmt(node.body);
    if (this.current) this.terminate(new Instr('jump', { type: 'void', imm: stepBlock }));
    this.loops.pop();

    this.seal(stepBlock);
    this.at(stepBlock);
    if (node.step) this.expr(node.step);
    if (this.current) this.terminate(new Instr('jump', { type: 'void', imm: header }));

    this.seal(header);
    this.seal(exit);
    this.at(exit);
  }

  // --------------------------------------------------------- expressions --

  /** A condition: the value itself, which the branch tests against zero. */
  truthy(node) {
    return this.expr(node);
  }

  expr(node) {
    switch (node.kind) {
      case 'IntLit':
        return this.emit(new Instr('const', { imm: node.value, span: node.span }));

      case 'Name':
        return this.read(node.symbol, this.current);

      case 'Index': {
        const array = this.expr(node.array);
        const index = this.expr(node.index);
        return this.emit(new Instr('load', { args: [array, index], span: node.span }));
      }

      case 'Unary':
        return this.emit(new Instr('unop', {
          imm: node.op, args: [this.expr(node.operand)], span: node.span,
        }));

      case 'Binary': {
        const left = this.expr(node.left);
        const right = this.expr(node.right);
        return this.emit(new Instr('binop', {
          imm: node.op, args: [left, right], span: node.span,
        }));
      }

      case 'Logical': return this.logical(node);
      case 'Assign': return this.assign(node);

      case 'Call': {
        const args = node.args.map((arg) => this.expr(arg));
        if (node.sig.builtin) {
          this.emit(new Instr(node.sig.name, { type: 'void', args, span: node.span }));
          // A builtin call is a statement; nothing reads its value, and sema
          // has already rejected any program that tries.
          return this.emit(new Instr('const', { imm: 0, span: node.span }));
        }
        return this.emit(new Instr('call', {
          type: node.sig.returnType === 'void' ? 'void' : 'int',
          imm: node.sig.name, args, span: node.span,
        }));
      }

      default:
        throw new Error(`ir: unhandled expression ${node.kind}`);
    }
  }

  /**
   * && and || are control flow, not operators: the right operand is evaluated
   * only when the left does not decide the answer. So they lower to a branch
   * and a phi, which is also why they are a separate AST node from Binary.
   */
  logical(node) {
    const rightBlock = this.func.addBlock('rhs');
    const joinBlock = this.func.addBlock('join');

    const left = this.expr(node.left);
    const leftBlock = this.current;
    const shortCircuit = this.emit(new Instr('const', {
      imm: node.op === '&&' ? 0 : 1, span: node.span,
    }));
    const zero = this.emit(new Instr('const', { imm: 0, span: node.span }));
    const leftIsTrue = this.emit(new Instr('binop', {
      imm: '!=', args: [left, zero], span: node.span,
    }));
    this.terminate(new Instr('branch', {
      type: 'void', args: [leftIsTrue], span: node.span,
      imm: node.op === '&&'
        ? { then: rightBlock, otherwise: joinBlock }
        : { then: joinBlock, otherwise: rightBlock },
    }));
    rightBlock.sealed = true;

    this.at(rightBlock);
    const right = this.expr(node.right);
    const rightZero = this.emit(new Instr('const', { imm: 0, span: node.span }));
    const rightIsTrue = this.emit(new Instr('binop', {
      imm: '!=', args: [right, rightZero], span: node.span,
    }));
    const endOfRight = this.current;
    this.terminate(new Instr('jump', { type: 'void', imm: joinBlock }));

    this.seal(joinBlock);
    this.at(joinBlock);
    const phi = new Instr('phi', {
      incoming: [[leftBlock, shortCircuit], [endOfRight, rightIsTrue]],
    });
    phi.block = joinBlock;
    joinBlock.phis.push(phi);
    return phi;
  }

  assign(node) {
    const target = node.target;
    if (target.kind === 'Name') {
      const value = this.expr(node.value);
      this.write(target.symbol, this.current, value);
      return value;
    }

    // The order docs/semantics.md fixes: array, index, value, then the store,
    // which is where the bounds check happens.
    const array = this.expr(target.array);
    const index = this.expr(target.index);
    const value = this.expr(node.value);
    this.emit(new Instr('store', {
      type: 'void', args: [array, index, value], span: target.span,
    }));
    return value;
  }
}

/** Lower an analysed program to IR. */
export function buildModule(program, functions) {
  return new Builder(program, functions).build();
}
