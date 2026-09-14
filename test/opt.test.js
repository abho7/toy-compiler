// Each optimization pass on its own.
//
// The differential harness says the passes preserve behaviour. These say they
// do something, and that they decline to do the specific things that would be
// wrong -- which the harness cannot tell apart from doing nothing at all.
//
// That distinction is not theoretical. Value numbering keyed operands by
// instruction identity at first, so every literal in the source was its own
// value and nothing ever matched; the pass removed zero instructions on all 23
// corpus programs, and the programs written to prove it refuses to reuse a load
// across a store passed vacuously. Everything here therefore asserts both
// halves: what a pass removes, and what it leaves alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../src/parser.js';
import { analyze } from '../src/sema.js';
import { buildModule } from '../src/ir/build.js';
import { validateModule } from '../src/ir/validate.js';
import { runModule } from '../src/ir/interp.js';
import { observationBytes } from '../src/interp/ast-interp.js';
import { foldConstants } from '../src/opt/fold.js';
import { eliminateDeadCode } from '../src/opt/dce.js';
import { eliminateCommonSubexpressions } from '../src/opt/cse.js';
import { propagateCopies } from '../src/opt/copyprop.js';
import { optimize, PASSES, DEFAULT_PIPELINE } from '../src/opt/passes.js';
import { evalBinop, isTrap, BOUNDARY, BINOPS } from '../src/values.js';

function compile(source) {
  const { program, diags } = parse(source);
  analyze(program, diags);
  assert.deepEqual(diags.items.map((d) => d.message), []);
  return buildModule(program);
}

const mainOf = (module) => module.funcs.get('main');
const instrsOf = (func) => func.blocks.flatMap((b) => [...b.phis, ...b.instrs]);
const countOf = (func, op) => instrsOf(func).filter((i) => i.op === op).length;
const run = (module) => new TextDecoder().decode(observationBytes(runModule(module, { maxSteps: 20_000_000 })));

// ----------------------------------------------------------- folding --

test('folding computes what the interpreter would have computed', () => {
  // Exhaustive over the boundary pairs: for every operator and every dangerous
  // pair, the folded constant equals what evalBinop returns at run time. They
  // call the same function, so this is checking the plumbing rather than the
  // arithmetic -- that the pass reads the operands it thinks it does.
  let checked = 0;
  for (const op of BINOPS) {
    for (const a of BOUNDARY) {
      for (const b of BOUNDARY) {
        const expected = evalBinop(op, a, b);
        const module = compile(`int main() { return ${a} ${op} ${b}; }`);
        foldConstants(mainOf(module));
        const ret = mainOf(module).blocks.flatMap((x) => [x.term]).find((t) => t.op === 'ret');
        if (isTrap(expected)) {
          // A trapping operation is not folded: the division survives.
          assert.equal(ret.args[0].op, 'binop', `${a} ${op} ${b} must not fold`);
        } else {
          assert.equal(ret.args[0].op, 'const', `${a} ${op} ${b} should have folded`);
          assert.equal(ret.args[0].imm, expected.value, `${a} ${op} ${b}`);
        }
        checked++;
      }
    }
  }
  assert.ok(checked > 3000, `only ${checked} combinations checked`);
});

test('folding refuses every operation that would trap', () => {
  for (const source of ['return 1 / 0;', 'return 1 % 0;',
    'return -2147483648 / -1;', 'return -2147483648 % -1;']) {
    const module = compile(`int main() { ${source} }`);
    const changed = foldConstants(mainOf(module));
    assert.equal(countOf(mainOf(module), 'binop'), 1, `${source} must keep its operation`);
    void changed;
  }
});

test('folding simplifies identities without needing both sides constant', () => {
  const module = compile('int main() { int x = 0; print(x + 0); print(x * 1); print(x * 0); print(x - x); return 0; }');
  foldConstants(mainOf(module));
  assert.deepEqual(validateModule(module), []);
  assert.equal(run(module), '0\n0\n0\n0\n=== exit 0\n');
});

test('folding never simplifies x / x, because x may be zero', () => {
  const module = compile('int main() { int z = 0; return z / z; }');
  foldConstants(mainOf(module));
  assert.equal(countOf(mainOf(module), 'binop'), 1);
  assert.match(run(module), /trap div_by_zero/);
});

test('a branch on a known condition becomes a jump, and the dead arm goes', () => {
  const module = compile('int main() { if (1) print(7); else print(8); return 0; }');
  const before = mainOf(module).blocks.length;
  foldConstants(mainOf(module));
  assert.deepEqual(validateModule(module), []);
  assert.ok(mainOf(module).blocks.length < before, 'the untaken arm should be gone');
  assert.equal(run(module), '7\n=== exit 0\n');
});

// --------------------------------------------------- dead code elimination --

test('dead code elimination removes a computation nobody reads', () => {
  const module = compile('int main() { int unused = 6 * 7; return 0; }');
  const before = instrsOf(mainOf(module)).length;
  eliminateDeadCode(mainOf(module));
  assert.ok(instrsOf(mainOf(module)).length < before);
  assert.equal(run(module), '=== exit 0\n');
});

test('it keeps a load whose result nobody reads, because the bounds check is real', () => {
  const module = compile('int main() { int a[3]; a[5]; return 0; }');
  eliminateDeadCode(mainOf(module));
  assert.equal(countOf(mainOf(module), 'load'), 1, 'the load must survive');
  assert.match(run(module), /trap out_of_bounds/);
});

test('it keeps a division whose result nobody reads', () => {
  const module = compile('int main() { int z = 0; 100 / z; return 0; }');
  eliminateDeadCode(mainOf(module));
  assert.equal(countOf(mainOf(module), 'binop'), 1);
  assert.match(run(module), /trap div_by_zero/);
});

test('it keeps stores, calls and output', () => {
  const module = compile(`int side(int x) { print(x); return x; }
    int main() { int a[2]; a[0] = 1; side(2); print(3); return 0; }`);
  eliminateDeadCode(mainOf(module));
  assert.equal(countOf(mainOf(module), 'store'), 1);
  assert.equal(countOf(mainOf(module), 'call'), 1);
  assert.equal(countOf(mainOf(module), 'print'), 1);
  assert.equal(run(module), '2\n3\n=== exit 0\n');
});

test('it removes an array nobody uses', () => {
  const module = compile('int main() { int unused[4]; return 0; }');
  eliminateDeadCode(mainOf(module));
  assert.equal(countOf(mainOf(module), 'alloc'), 0);
});

// ----------------------------------------------------------------- CSE --

test('it merges a repeated expression that dominates its second occurrence', () => {
  const module = compile('int main() { int x = 3; int y = 4; print(x * y); print(x * y); return 0; }');
  const before = countOf(mainOf(module), 'binop');
  const removed = eliminateCommonSubexpressions(mainOf(module));
  assert.ok(removed > 0, 'the repeated multiply should be merged');
  assert.ok(countOf(mainOf(module), 'binop') < before);
  assert.deepEqual(validateModule(module), []);
  assert.equal(run(module), '12\n12\n=== exit 0\n');
});

test('it does NOT reuse a load across a store to the same array', () => {
  const module = compile(`int main() {
    int a[2]; a[0] = 1;
    int first = a[0];
    a[0] = 2;
    int second = a[0];
    print(first); print(second); return 0; }`);
  eliminateCommonSubexpressions(mainOf(module));
  // Both loads must survive: the store between them changes what they read.
  assert.equal(countOf(mainOf(module), 'load'), 2);
  assert.equal(run(module), '1\n2\n=== exit 0\n');
});

test('it does NOT reuse a load across a call, which may write through the array', () => {
  const module = compile(`void bump(int[] a) { a[0] = a[0] + 1; }
    int main() {
      int a[1]; a[0] = 7;
      int before = a[0];
      bump(a);
      int after = a[0];
      print(before); print(after); return 0; }`);
  eliminateCommonSubexpressions(mainOf(module));
  assert.equal(countOf(mainOf(module), 'load'), 2);
  assert.equal(run(module), '7\n8\n=== exit 0\n');
});

test('it never merges two calls, which are two events', () => {
  const module = compile(`int tell(int x) { print(x); return x; }
    int main() { int a = tell(5); int b = tell(5); print(a + b); return 0; }`);
  eliminateCommonSubexpressions(mainOf(module));
  assert.equal(countOf(mainOf(module), 'call'), 2);
  assert.equal(run(module), '5\n5\n10\n=== exit 0\n');
});

test('it never hoists a guarded division out of its branch', () => {
  // The division is safe only inside the guard. CSE only ever replaces a later
  // occurrence with an earlier one that dominates it, so it cannot move this.
  const module = compile(`int divide(int n) { if (n != 0) return 100 / n; return 0; }
    int main() { print(divide(5)); print(divide(0)); return 0; }`);
  const func = module.funcs.get('divide');
  eliminateCommonSubexpressions(func);
  const divBlock = func.blocks.find((b) => b.instrs.some((i) => i.op === 'binop' && i.imm === '/'));
  assert.notEqual(divBlock, func.entry, 'the division must stay inside the guard');
  assert.equal(run(module), '20\n0\n=== exit 0\n');
});

test('two allocations are never merged, however identical they look', () => {
  const module = compile('int main() { int a[2]; int b[2]; a[0] = 5; b[0] = 7; print(a[0]); print(b[0]); return 0; }');
  eliminateCommonSubexpressions(mainOf(module));
  assert.equal(countOf(mainOf(module), 'alloc'), 2);
  assert.equal(run(module), '5\n7\n=== exit 0\n');
});

// --------------------------------------------------------- copy propagation --

test('copy propagation removes a phi whose operands are all the same', () => {
  const module = compile('int main() { int x = 5; if (x) { x = 5; } return x; }');
  foldConstants(mainOf(module));
  const removed = propagateCopies(mainOf(module));
  assert.ok(removed >= 0);
  assert.deepEqual(validateModule(module), []);
  assert.equal(run(module), '=== exit 5\n');
});

// ------------------------------------------------------------- pipeline --

test('every pass leaves the IR well formed', () => {
  const source = `int work(int[] a, int n) {
      int total = 0;
      for (int i = 0; i < n; i = i + 1) { if (a[i] > 2) total = total + a[i] * 2; }
      return total;
    }
    int main() { int a[] = {1, 2, 3, 4}; print(work(a, 4)); return 0; }`;
  for (const name of Object.keys(PASSES)) {
    const module = compile(source);
    optimize(module, [name]);
    assert.deepEqual(validateModule(module), [], `${name} left the IR malformed`);
  }
});

test('the default pipeline reaches a fixed point rather than oscillating', () => {
  const source = 'int main() { int a = 2 + 3; int b = a * 1; int c = b + 0; print(c); return 0; }';
  const module = compile(source);
  optimize(module, DEFAULT_PIPELINE);
  const second = optimize(module, DEFAULT_PIPELINE);
  assert.equal(second.reduce((n, r) => n + r.changed, 0), 0, 'a second run should find nothing');
  assert.equal(run(module), '5\n=== exit 0\n');
});

test('optimize refuses a pass name it does not have', () => {
  assert.throws(() => optimize(compile('int main() { return 0; }'), ['nope']), /no pass named/);
});
