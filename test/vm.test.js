// The bytecode VM, and the parts of code generation most likely to be wrong.
//
// The differential harness says the whole pipeline agrees with the oracle on
// the corpus. These tests cover the two things it would not localise: the
// arithmetic the VM inlines rather than taking from the shared kernel, and the
// phi copies on loop edges, which are correct on every program that never
// exchanges two values.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../src/parser.js';
import { analyze } from '../src/sema.js';
import { buildModule } from '../src/ir/build.js';
import { generate } from '../src/backend/codegen.js';
import { runBytecode } from '../src/vm/vm.js';
import { runProgram } from '../src/interp/ast-interp.js';
import { sequenceCopies, splitCriticalEdges } from '../src/backend/linearize.js';
import { OP, BINOP_TO_OP, disassembleFunc, MAX_ARGS } from '../src/vm/bytecode.js';
import { evalBinop, isTrap, BOUNDARY, INT_MIN } from '../src/values.js';
import { TRAP } from '../src/traps.js';

function compile(source) {
  const { program, diags } = parse(source);
  analyze(program, diags);
  assert.deepEqual(diags.items.map((d) => d.message), []);
  return { program, bytecode: generate(buildModule(program)) };
}

function run(source, options = {}) {
  const { bytecode } = compile(source);
  const result = runBytecode(bytecode, { maxSteps: 40_000_000, ...options });
  return { ...result, text: new TextDecoder().decode(result.output) };
}

const main = (body) => `int main() { ${body} }`;

test('the VM runs a program and returns its status', () => {
  const r = run(main('print(1); print(2); return 7;'));
  assert.equal(r.text, '1\n2\n');
  assert.equal(r.status, 7);
});

test('every inlined opcode agrees with the shared arithmetic kernel', () => {
  // The VM inlines everything except div and mod, so this is the check that
  // the duplication is harmless. Exhaustive over the boundary values: these
  // are the pairs where int32 arithmetic goes wrong if it is going to.
  let checked = 0;
  for (const [op, opcode] of Object.entries(BINOP_TO_OP)) {
    if (opcode === OP.DIV || opcode === OP.MOD) continue;   // those call the kernel
    for (const a of BOUNDARY) {
      for (const b of BOUNDARY) {
        const expected = evalBinop(op, a, b);
        assert.ok(!isTrap(expected), `${op} should not trap`);
        const source = main(`int x = ${a}; int y = ${b}; print(x ${op} y); return 0;`);
        const got = run(source).text.trim();
        assert.equal(got, String(expected.value), `${a} ${op} ${b} through the VM`);
        checked++;
      }
    }
  }
  assert.ok(checked > 2000, `only ${checked} combinations checked`);
});

test('division and remainder trap exactly where the kernel says', () => {
  for (const op of ['/', '%']) {
    const byZero = run(main(`int z = 0; return 1 ${op} z;`));
    assert.equal(byZero.trap.kind, TRAP.DIV_BY_ZERO);
    const overflow = run(main(`int lo = ${INT_MIN}; int neg = -1; return lo ${op} neg;`));
    assert.equal(overflow.trap.kind, TRAP.DIV_OVERFLOW);
  }
});

test('a trap reports the same position the reference interpreter reports', () => {
  const source = 'int main() {\n  int a[2];\n  return a[9];\n}';
  const { program, bytecode } = compile(source);
  const fromVm = runBytecode(bytecode);
  const fromAst = runProgram(program);
  assert.equal(fromVm.trap.kind, fromAst.trap.kind);
  assert.equal(fromVm.trap.span.line, fromAst.trap.span.line);
  assert.equal(fromVm.trap.span.col, fromAst.trap.span.col);
});

test('two variables exchanging values across a loop edge', () => {
  // The phi copies on the back edge form a cycle: a gets b, b gets a, at the
  // same moment. Sequencing them without a temporary loses one of the values,
  // and the program still works for every loop that does not do this.
  const r = run(main(`int a = 1; int b = 2;
    for (int i = 0; i < 3; i = i + 1) { int t = a; a = b; b = t; }
    print(a); print(b); return 0;`));
  assert.equal(r.text, '2\n1\n');
});

test('three variables rotating across a loop edge', () => {
  const r = run(main(`int a = 1; int b = 2; int c = 3;
    for (int i = 0; i < 2; i = i + 1) { int t = a; a = b; b = c; c = t; }
    print(a); print(b); print(c); return 0;`));
  // After one rotation: 2 3 1. After two: 3 1 2.
  assert.equal(r.text, '3\n1\n2\n');
});

test('sequenceCopies breaks a cycle rather than losing a value', () => {
  const steps = sequenceCopies([[1, 2], [2, 1]]);
  assert.ok(steps.some((s) => s.toTemp), 'a cycle needs a temporary');
  assert.equal(steps.filter((s) => s.dst !== undefined).length, 2, 'both copies still happen');
});

test('sequenceCopies emits nothing for a copy to itself', () => {
  assert.deepEqual(sequenceCopies([[3, 3]]), []);
});

test('sequenceCopies orders a chain so no source is overwritten first', () => {
  // b <- a and c <- b: c must be written before b, or c gets the new b.
  const steps = sequenceCopies([[2, 1], [3, 2]]);
  assert.deepEqual(steps.map((s) => [s.dst, s.src]), [[3, 2], [2, 1]]);
});

test('critical edges are split before phis become copies', () => {
  const source = 'int main() { int x = 0; if (x) x = 1; while (x) { x = x - 1; } return x; }';
  const { program, diags } = parse(source);
  analyze(program, diags);
  assert.deepEqual(diags.items.map((d) => d.message), []);
  const func = buildModule(program).funcs.get('main');
  const before = func.blocks.length;
  const added = splitCriticalEdges(func);
  assert.ok(added >= 0);
  assert.equal(func.blocks.length, before + added);
  for (const block of func.blocks) {
    if (block.term?.op !== 'branch') continue;
    for (const side of ['then', 'otherwise']) {
      const to = block.term.imm[side];
      assert.ok(to.preds.length === 1 || block.successors.length === 1,
        'no critical edge may remain');
    }
  }
});

test('recursion works, and the depth limit matches the other implementations', () => {
  const recurse = (n) => `int f(int n) { if (n == 0) return 0; return f(n - 1) + 1; }
                          int main() { print(f(${n})); return 0; }`;
  assert.equal(run(recurse(998)).text, '998\n');
  const tooDeep = run(recurse(999));
  assert.equal(tooDeep.outcome, 'trap');
  assert.equal(tooDeep.trap.kind, TRAP.STACK_OVERFLOW);
});

test('arrays are handles, and a callee writes through the caller\'s array', () => {
  const r = run(`void fill(int[] a, int n) { for (int i = 0; i < n; i = i + 1) a[i] = i * i; }
                 int main() { int b[4]; fill(b, 4); print(b[3]); return 0; }`);
  assert.equal(r.text, '9\n');
});

test('two allocations are different arrays', () => {
  const r = run(main(`int a[2]; int b[2]; a[0] = 5; b[0] = 7; print(a[0]); print(b[0]); return 0;`));
  assert.equal(r.text, '5\n7\n');
});

test('a runaway program exhausts its budget rather than hanging', () => {
  const r = run(main('while (1) { } return 0;'), { maxSteps: 5000 });
  assert.equal(r.outcome, 'budget');
});

test('the disassembly names its opcodes and targets', () => {
  const { bytecode } = compile(main('int s = 0; for (int i = 0; i < 2; i = i + 1) s = s + i; return s;'));
  const text = disassembleFunc(bytecode.funcs[bytecode.mainIndex]);
  // Mnemonics are padded into a column, so the separator is one or more spaces.
  assert.match(text, /func main\(0 params, \d+ slots\)/);
  assert.match(text, /ldslot\s+r\d+, s\d+/);
  assert.match(text, /brz\s+r\d+, @\d+/);
  assert.match(text, /ret\s+r\d+/);
});

test('a call with more arguments than registers is refused, not miscompiled', () => {
  const params = Array.from({ length: MAX_ARGS + 1 }, (_, i) => `int a${i}`).join(', ');
  const args = Array.from({ length: MAX_ARGS + 1 }, () => '1').join(', ');
  const source = `int wide(${params}) { return a0; } int main() { return wide(${args}); }`;
  const { program, diags } = parse(source);
  analyze(program, diags);
  assert.deepEqual(diags.items.map((d) => d.message), []);
  assert.throws(() => generate(buildModule(program)), /more than the \d+ a call can pass/);
});
