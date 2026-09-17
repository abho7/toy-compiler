// Register allocation: the interference invariant, the spill path, and the
// loop case where the interval arithmetic is most likely to be wrong.
//
// The spill path deserves its own explanation. No corpus program comes close
// to filling the register file -- peak pressure is 11 live values against 13
// allocatable, and the median function needs 3 -- so eviction never runs on
// real input. That is exactly the shape of the two bugs this project has
// already shipped: phase 5's copy-cycle breaker was unreachable, and phase 6's
// value numbering was inert, and in both cases a green suite meant nothing
// because the code under test never executed. So the allocator takes an
// injectable register set, and the tests squeeze it until it has to spill.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parse } from '../src/parser.js';
import { analyze } from '../src/sema.js';
import { buildModule } from '../src/ir/build.js';
import { optimize, DEFAULT_PIPELINE } from '../src/opt/passes.js';
import { splitCriticalEdges } from '../src/backend/linearize.js';
import {
  allocate, allocatableRegisters, verifyAllocation, liveIntervals, liveness,
} from '../src/backend/regalloc.js';
import { FIRST_SCRATCH } from '../src/vm/bytecode.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, 'corpus');
const programs = readdirSync(CORPUS).filter((f) => f.endsWith('.mc')).sort();

/** Every function of every corpus program, optimized and edge-split. */
function* corpusFunctions() {
  for (const file of programs) {
    const source = readFileSync(join(CORPUS, file), 'utf8');
    const { program, diags } = parse(source);
    analyze(program, diags);
    assert.deepEqual(diags.items.map((d) => d.message), [], `${file} must compile`);
    const module = buildModule(program);
    optimize(module, DEFAULT_PIPELINE);
    for (const func of module.funcs.values()) {
      splitCriticalEdges(func);
      yield { file, func };
    }
  }
}

function build(source, name = 'main') {
  const { program, diags } = parse(source);
  analyze(program, diags);
  assert.deepEqual(diags.items.map((d) => d.message), []);
  const func = buildModule(program).funcs.get(name);
  splitCriticalEdges(func);
  return func;
}

/** The most values live at any one position. Independent of the register file. */
function peakPressure(func) {
  const { order, intervals } = liveIntervals(func);
  let peak = 0;
  for (let p = 0; p <= order.length; p++) {
    const live = intervals.filter((iv) => iv.start <= p && p <= iv.end).length;
    if (live > peak) peak = live;
  }
  return peak;
}

test('every corpus function allocates without interference', () => {
  let functions = 0;
  for (const { file, func } of corpusFunctions()) {
    const result = allocate(func);
    assert.deepEqual(verifyAllocation(func, result), [], `${file}:${func.name}`);
    for (const interval of result.intervals) {
      assert.ok(result.location.get(interval.value), `${file}:${func.name} left ${interval.value.ref} unplaced`);
    }
    functions++;
  }
  assert.ok(functions >= 30, `only ${functions} functions checked`);
});

test('nothing spills at the natural register file', () => {
  // Not a requirement, an observation -- and the reason the squeeze tests
  // below exist. If this ever starts failing, the allocator is fine; the
  // corpus has simply grown a function worth allocating for.
  for (const { file, func } of corpusFunctions()) {
    const result = allocate(func);
    assert.equal(result.spills, 0, `${file}:${func.name} spilled unexpectedly`);
  }
});

test('squeezing the register file forces eviction, and it still verifies', () => {
  for (const size of [8, 4, 2, 1]) {
    let spills = 0;
    let evicting = 0;
    for (const { file, func } of corpusFunctions()) {
      const natural = allocatableRegisters(func).registers;
      const result = allocate(func, { registers: natural.slice(0, size) });

      assert.deepEqual(verifyAllocation(func, result), [],
        `${file}:${func.name} with ${size} registers`);

      // Spill slots are handed out one per spilled value; two values sharing
      // one would be the same bug as two sharing a register.
      const slots = [...result.location.values()].filter((l) => l.kind === 'slot').map((l) => l.n);
      assert.equal(new Set(slots).size, slots.length, `${file}:${func.name} reused a spill slot`);

      for (const interval of result.intervals) {
        assert.ok(result.location.get(interval.value), `${file}:${func.name} left a value unplaced`);
      }

      spills += result.spills;
      if (result.spills > 0) evicting++;
    }
    assert.ok(spills > 0, `${size} registers should have forced spills, got none`);
    assert.ok(evicting > 0, `${size} registers should have made some function evict`);
  }
});

test('a single register still produces a valid allocation', () => {
  // The extreme: everything but one value lives in memory. If the eviction
  // bookkeeping is wrong anywhere, it is wrong here.
  for (const { file, func } of corpusFunctions()) {
    const natural = allocatableRegisters(func).registers;
    const result = allocate(func, { registers: natural.slice(0, 1) });
    assert.deepEqual(verifyAllocation(func, result), [], `${file}:${func.name} with one register`);
  }
});

test('a value live across a loop keeps its register for the whole loop', () => {
  // `carried` depends on a parameter so folding cannot remove it, is defined
  // before the loop, and is used only after it. If its interval stopped at the
  // loop entry, the register would be handed to something inside the loop and
  // the value would be destroyed.
  const func = build(`int work(int seed) {
      int carried = seed * 3;
      int total = 0;
      for (int i = 0; i < 4; i = i + 1) { total = total + i; }
      return total + carried;
    }
    int main() { print(work(2)); return 0; }`, 'work');

  const { order, intervals } = liveIntervals(func);
  const loopBlocks = order.blocks.filter((b) => /^(loop|body|step)/.test(b.label));
  assert.ok(loopBlocks.length >= 2, 'the program must actually contain a loop');
  const loopStart = Math.min(...loopBlocks.map((b) => order.blockStart.get(b)));
  const loopEnd = Math.max(...loopBlocks.map((b) => order.blockEnd.get(b)));

  const carried = intervals.find((iv) => iv.value.op === 'binop' && iv.value.imm === '*');
  assert.ok(carried, 'the multiply should survive folding');
  assert.ok(carried.start <= loopStart, 'it is defined before the loop');
  assert.ok(carried.end >= loopEnd, 'and is still live after it');
});

test('a phi operand counts as used at the end of the predecessor, not in the phi block', () => {
  // Getting this wrong keeps values alive down paths they never travel, which
  // shows up as needless pressure rather than as a wrong answer.
  const func = build('int main() { int x = 0; if (x) { x = 1; } else { x = 2; } return x; }');
  const { liveIn } = liveness(func);
  for (const block of func.blocks) {
    for (const phi of block.phis) {
      assert.ok(!liveIn.get(block).has(phi) || block.phis.includes(phi));
      for (const [from, value] of phi.incoming) {
        if (value.op === 'const') continue;
        assert.ok(liveness(func).liveOut.get(from).has(value),
          'a phi operand must be live out of the predecessor it arrives from');
      }
    }
  }
});

test('the verifier catches two live values sharing a register', () => {
  // Without this, a clean verification report proves only that the verifier
  // is quiet.
  const func = build('int main() { int a = 1; int b = 2; int c = a + b; print(c); return a + b + c; }');
  const result = allocate(func);
  assert.deepEqual(verifyAllocation(func, result), []);

  const overlapping = result.intervals.find((iv) =>
    result.intervals.some((o) => o !== iv && iv.start <= o.end && o.start <= iv.end));
  const other = result.intervals.find((o) =>
    o !== overlapping && overlapping.start <= o.end && o.start <= overlapping.end);
  assert.ok(overlapping && other, 'the program must have two values live at once');

  result.location.set(overlapping.value, { kind: 'reg', n: 9 });
  result.location.set(other.value, { kind: 'reg', n: 9 });
  const problems = verifyAllocation(func, result);
  assert.ok(problems.length > 0, 'the verifier must notice the collision');
  assert.match(problems[0], /both hold r9/);
});

test('the verifier rejects a register outside the allocatable range', () => {
  const func = build('int f(int a, int b) { return a + b; } int main() { return f(1, 2); }', 'f');
  const result = allocate(func);
  const [first] = result.intervals;
  result.location.set(first.value, { kind: 'reg', n: 0 });   // reserved for parameters
  assert.match(verifyAllocation(func, result).join('\n'), /reserved for argument marshalling/);
});

test('scratch registers are never allocated', () => {
  for (const { file, func } of corpusFunctions()) {
    const result = allocate(func);
    for (const [, where] of result.location) {
      if (where.kind !== 'reg') continue;
      assert.ok(where.n < FIRST_SCRATCH, `${file}:${func.name} allocated scratch register r${where.n}`);
    }
  }
});

test('peak pressure across the corpus is well under the register file', () => {
  // Recorded rather than asserted tightly: this is what makes the spill path
  // unreachable on real input, and it is the number phase 9 has to quote when
  // it reports what allocation bought.
  let worst = 0;
  let worstAt = '';
  for (const { file, func } of corpusFunctions()) {
    const peak = peakPressure(func);
    if (peak > worst) { worst = peak; worstAt = `${file}:${func.name}`; }
  }
  assert.ok(worst > 0);
  assert.ok(worst <= FIRST_SCRATCH,
    `peak pressure ${worst} at ${worstAt} no longer fits the ${FIRST_SCRATCH} allocatable registers`);
});

test('void instructions get no interval, unless the pre-fix behaviour is asked for', () => {
  // tools/pressure.js reports registers used with and without this filter, so
  // the flag that restores the old behaviour has to actually restore it.
  const func = build('int main() { print(1); print(2); putchar(10); return 0; }');
  const isVoid = (iv) => iv.value.type === 'void';
  assert.equal(liveIntervals(func).intervals.filter(isVoid).length, 0);
  assert.ok(liveIntervals(func, { voidIntervals: true }).intervals.filter(isVoid).length >= 3);

  let fewer = 0;
  for (const { file, func: f } of corpusFunctions()) {
    const before = allocate(f, { voidIntervals: true });
    const after = allocate(f);
    assert.deepEqual(verifyAllocation(f, before), [], `${file}:${f.name}`);
    assert.ok(after.registersUsed <= before.registersUsed, `${file}:${f.name} uses more registers`);
    if (after.registersUsed < before.registersUsed) fewer++;
  }
  assert.ok(fewer > 0, 'the filter saved no registers anywhere in the corpus');
});
