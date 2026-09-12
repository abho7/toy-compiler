// The arithmetic kernel, tested directly.
//
// Every other component calls these functions, so a bug here is a bug in all
// of them simultaneously and no differential test between them could find it.
// Hence: exhaustive over the boundary values, and randomized over the rest.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evalBinop, evalUnop, wrap, isTrap, INT_MIN, INT_MAX, BINOPS, UNOPS, BOUNDARY,
} from '../src/values.js';
import { TRAP } from '../src/traps.js';

const val = (op, a, b) => {
  const r = evalBinop(op, a, b);
  assert.ok(!isTrap(r), `${a} ${op} ${b} unexpectedly trapped: ${r.trap}`);
  return r.value;
};

test('arithmetic wraps instead of overflowing', () => {
  assert.equal(val('+', INT_MAX, 1), INT_MIN);
  assert.equal(val('-', INT_MIN, 1), INT_MAX);
  assert.equal(val('*', 65536, 65536), 0);
  assert.equal(val('*', INT_MAX, 2), -2);
  assert.equal(evalUnop('-', INT_MIN).value, INT_MIN);
});

test('division truncates toward zero', () => {
  assert.deepEqual([val('/', 7, 2), val('/', -7, 2), val('/', 7, -2), val('/', -7, -2)],
    [3, -3, -3, 3]);
});

test('the remainder takes the sign of the dividend', () => {
  assert.deepEqual([val('%', 7, 2), val('%', -7, 2), val('%', 7, -2), val('%', -7, -2)],
    [1, -1, 1, -1]);
});

test('(a / b) * b + (a % b) == a wherever neither traps', () => {
  for (const a of BOUNDARY) {
    for (const b of BOUNDARY) {
      const q = evalBinop('/', a, b);
      const r = evalBinop('%', a, b);
      if (isTrap(q) || isTrap(r)) continue;
      assert.equal(wrap(Math.imul(q.value, b) + r.value), a, `identity failed for ${a} / ${b}`);
    }
  }
});

test('division and remainder trap on the same two conditions', () => {
  for (const op of ['/', '%']) {
    assert.equal(evalBinop(op, 1, 0).trap, TRAP.DIV_BY_ZERO);
    assert.equal(evalBinop(op, 0, 0).trap, TRAP.DIV_BY_ZERO);
    assert.equal(evalBinop(op, INT_MIN, 0).trap, TRAP.DIV_BY_ZERO);
    // INT_MIN % -1 is mathematically 0; it traps by choice, so that / and %
    // share one trap condition. docs/semantics.md says so explicitly.
    assert.equal(evalBinop(op, INT_MIN, -1).trap, TRAP.DIV_OVERFLOW);
  }
  assert.equal(val('/', INT_MIN, 1), INT_MIN);
  assert.equal(val('/', INT_MIN + 1, -1), INT_MAX);
});

test('shifts use only the low five bits of the right operand', () => {
  assert.equal(val('<<', 1, 32), 1);
  assert.equal(val('<<', 1, 33), 2);
  assert.equal(val('>>', -8, 33), -4);
  assert.equal(val('<<', 1, 31), INT_MIN);
});

test('>> propagates the sign bit', () => {
  assert.equal(val('>>', -8, 1), -4);
  assert.equal(val('>>', -1, 31), -1);
  assert.equal(val('>>', INT_MIN, 31), -1);
});

test('comparisons yield 1 or 0, never a boolean', () => {
  for (const [op, a, b, want] of [
    ['==', 1, 1, 1], ['==', 1, 2, 0], ['!=', 1, 2, 1],
    ['<', -1, 0, 1], ['<', 0, -1, 0], ['<=', 2, 2, 1],
    ['>', 3, 2, 1], ['>=', 2, 3, 0],
  ]) {
    const got = val(op, a, b);
    assert.equal(got, want);
    assert.equal(typeof got, 'number');
  }
});

test('comparison is signed, so INT_MIN is below everything', () => {
  assert.equal(val('<', INT_MIN, 0), 1);
  assert.equal(val('>', INT_MIN, INT_MAX), 0);
});

test('unary operators', () => {
  assert.equal(evalUnop('-', 5).value, -5);
  assert.equal(evalUnop('~', 0).value, -1);
  assert.equal(evalUnop('~', -1).value, 0);
  assert.equal(evalUnop('!', 0).value, 1);
  assert.equal(evalUnop('!', 7).value, 0);
  assert.equal(evalUnop('!', INT_MIN).value, 0);
});

test('every operator on every pair of boundary values stays a 32-bit int', () => {
  let checked = 0;
  for (const op of BINOPS) {
    for (const a of BOUNDARY) {
      for (const b of BOUNDARY) {
        const r = evalBinop(op, a, b);
        if (isTrap(r)) { assert.ok(op === '/' || op === '%'); continue; }
        assert.equal(typeof r.value, 'number');
        assert.ok(Number.isInteger(r.value), `${a} ${op} ${b} = ${r.value} is not an integer`);
        assert.equal(r.value, r.value | 0, `${a} ${op} ${b} = ${r.value} is outside int32`);
        checked++;
      }
    }
  }
  // 16 operators over 15x15 pairs, less the ones that trap.
  assert.ok(checked > 3000, `only ${checked} combinations checked`);
});

test('randomized: results always stay inside int32', () => {
  // A fixed seed, so a failure is reproducible rather than a story about a
  // build that once went red.
  let seed = 0x2545f491;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return seed;
  };
  for (let i = 0; i < 20000; i++) {
    const a = rnd();
    const b = rnd();
    const op = BINOPS[(rnd() >>> 0) % BINOPS.length];
    const r = evalBinop(op, a, b);
    if (isTrap(r)) continue;
    assert.equal(r.value, r.value | 0, `${a} ${op} ${b} left int32`);
  }
  for (let i = 0; i < 2000; i++) {
    const a = rnd();
    const op = UNOPS[(rnd() >>> 0) % UNOPS.length];
    assert.equal(evalUnop(op, a).value, evalUnop(op, a).value | 0);
  }
});

test('an unknown operator is a programming error, not a silent zero', () => {
  assert.throws(() => evalBinop('&&', 1, 1), /not a binary operator/);
  assert.throws(() => evalUnop('+', 1), /not a unary operator/);
});
