// SSA construction and the IR validator.
//
// The differential test says the IR computes the right thing; these say it is
// the right *shape* -- that phis appear where control flow joins and nowhere
// else, that the validator actually catches a broken graph rather than passing
// everything, and that the construction bug found in vm.mc stays fixed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../src/parser.js';
import { analyze } from '../src/sema.js';
import { buildModule } from '../src/ir/build.js';
import { validateModule, dominators, dominates } from '../src/ir/validate.js';
import { printFunc, effects, isPure, Instr } from '../src/ir/ir.js';
import { runModule } from '../src/ir/interp.js';

function build(source) {
  const { program, diags } = parse(source);
  analyze(program, diags);
  assert.deepEqual(diags.items.map((d) => d.message), []);
  const module = buildModule(program);
  assert.deepEqual(validateModule(module), []);
  return module;
}

const mainOf = (source) => build(source).funcs.get('main');
const allPhis = (func) => func.blocks.flatMap((b) => b.phis);
const allInstrs = (func) => func.blocks.flatMap((b) => [...b.phis, ...b.instrs, b.term]);

test('straight-line code needs no phis', () => {
  const func = mainOf('int main() { int x = 1; int y = x + 2; return y; }');
  assert.equal(func.blocks.length, 1);
  assert.equal(allPhis(func).length, 0);
});

test('a value assigned in one arm of an if becomes a phi at the join', () => {
  const func = mainOf('int main() { int x = 1; if (x) x = 2; return x; }');
  const phis = allPhis(func);
  assert.equal(phis.length, 1);
  assert.equal(phis[0].incoming.length, 2);
  assert.equal(phis[0].block.preds.length, 2);
});

test('a value the same on both paths needs no phi', () => {
  // Both arms leave x alone, so the join has nothing to merge: the trivial phi
  // is removed rather than left behind for every later pass to walk over.
  const func = mainOf('int main() { int x = 1; if (x) print(x); else print(0); return x; }');
  assert.equal(allPhis(func).length, 0);
});

test('a loop puts a phi in its header', () => {
  const func = mainOf('int main() { int s = 0; for (int i = 0; i < 3; i = i + 1) s = s + i; return s; }');
  const phis = allPhis(func);
  assert.ok(phis.length >= 2, 'a phi for the counter and one for the sum');
  for (const phi of phis) {
    assert.equal(phi.incoming.length, phi.block.preds.length);
    assert.ok(phi.incoming.every(([, v]) => v), 'no phi operand may be missing');
  }
});

test('no phi is ever left without operands', () => {
  // The bug this is guarding: collapsing a trivial phi ran while an outer phi
  // was still being filled, and rebuilding the operand arrays with map() threw
  // away the pushes the outer fill had already made. Two array variables in
  // vm.mc ended up with phis that had no operands at all, which the validator
  // caught and an interpreter would have run as "a value from nowhere".
  const source = `int main() {
      int code[8] = {1, 2, 3, 4, 5, 6, 7, 8};
      int var[4];
      int sp = 0;
      int pc = 0;
      while (1) {
        int op = code[pc];
        pc = pc + 1;
        if (op == 0) return sp;
        if (op == 1) { sp = sp + var[0]; }
        if (op == 2) { var[0] = sp; }
        if (op == 3) { sp = sp + 1; }
        if (pc >= 8) return sp;
      }
    }`;
  const func = mainOf(source);
  for (const phi of allPhis(func)) {
    assert.notEqual(phi.incoming.length, 0, `${phi.ref} in ${phi.block.label} has no operands`);
    assert.equal(phi.incoming.length, phi.block.preds.length);
  }
});

test('&& and || lower to branches, so the right side is not always evaluated', () => {
  const func = mainOf('int main() { int z = 0; if (z != 0 && 100 / z > 0) return 1; return 0; }');
  // The division lives in its own block, reached only when the left side held.
  const divBlock = func.blocks.find((b) => b.instrs.some((i) => i.op === 'binop' && i.imm === '/'));
  assert.ok(divBlock, 'the division must exist somewhere');
  assert.notEqual(divBlock, func.entry, 'and not in the entry block');
});

test('instructions carry the span of the syntax they came from', () => {
  const func = mainOf('int main() {\n  int a[2];\n  return a[5];\n}');
  const load = allInstrs(func).find((i) => i?.op === 'load');
  assert.equal(load.span.line, 3);
  assert.equal(load.span.col, 10);
});

test('effects are what the passes will rely on', () => {
  const div = new Instr('binop', { imm: '/' });
  const add = new Instr('binop', { imm: '+' });
  assert.equal(effects(div).mayTrap, true);
  assert.equal(effects(add).mayTrap, false);
  assert.equal(isPure(add), true);
  assert.equal(isPure(div), false);
  // Two allocations of the same length are different arrays: value numbering
  // must never merge them.
  assert.equal(effects(new Instr('alloc', { imm: 4 })).unique, true);
  assert.equal(isPure(new Instr('alloc', { imm: 4 })), false);
  // A call is assumed to do everything until a purity analysis says otherwise.
  const call = effects(new Instr('call', { imm: 'f' }));
  assert.deepEqual([call.isCall, call.mayTrap, call.readsMem, call.writesMem], [true, true, true, true]);
  assert.equal(effects(new Instr('print')).writesOutput, true);
});

test('dominance is computed correctly for a diamond', () => {
  const func = mainOf('int main() { int x = 1; if (x) x = 2; else x = 3; return x; }');
  const idom = dominators(func);
  const join = func.blocks.find((b) => b.preds.length === 2);
  assert.ok(dominates(idom, func.entry, join), 'the entry dominates everything');
  const then = func.blocks.find((b) => b.label.startsWith('then'));
  assert.equal(dominates(idom, then, join), false, 'one arm does not dominate the join');
});

test('the validator rejects a use that its definition does not reach', () => {
  const module = build('int main() { int x = 1; if (x) x = 2; return x; }');
  const func = module.funcs.get('main');
  // Move a value from one arm into the join, where it no longer dominates.
  const then = func.blocks.find((b) => b.label.startsWith('then'));
  const join = func.blocks.find((b) => b.preds.length === 2);
  const moved = then.instrs.pop();
  join.instrs.unshift(moved);
  moved.block = join;
  const problems = validateModule(module);
  assert.ok(problems.length > 0, 'the validator must notice');
});

test('the validator rejects a block with no terminator', () => {
  const module = build('int main() { return 1; }');
  module.funcs.get('main').entry.term = null;
  assert.match(validateModule(module).join('\n'), /has no terminator/);
});

test('the validator rejects a phi with the wrong number of operands', () => {
  const module = build('int main() { int x = 1; if (x) x = 2; return x; }');
  const func = module.funcs.get('main');
  const phi = func.blocks.flatMap((b) => b.phis)[0];
  phi.incoming.pop();
  assert.match(validateModule(module).join('\n'), /operands but/);
});

test('the printed IR is readable and mentions its blocks', () => {
  const func = mainOf('int main() { int s = 0; for (int i = 0; i < 2; i = i + 1) s = s + i; return s; }');
  const text = printFunc(func);
  assert.match(text, /^func main\(\) -> int \{/);
  assert.match(text, /phi \[/);
  assert.match(text, /branch %\d+ \?/);
  assert.match(text, /ret %\d+/);
});

test('the IR interpreter refuses a value that was never computed', () => {
  // Not a program the builder can produce; it checks that the interpreter
  // fails loudly rather than reading undefined if a pass ever breaks SSA.
  const module = build('int main() { return 1; }');
  const func = module.funcs.get('main');
  const stray = new Instr('binop', { imm: '+', args: [new Instr('const', { imm: 1 }), new Instr('const', { imm: 2 })] });
  stray.block = func.entry;
  func.entry.term.args = [stray];
  assert.throws(() => runModule(module), /used before it was computed/);
});
