// The reference interpreter against docs/semantics.md, clause by clause.
//
// This is the oracle every later phase is judged against, so the cases here are
// the ones the document is explicit about: evaluation order, short-circuiting,
// which of two traps is observed, wrapping, and what counts as observable.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runSource, runProgram, trailerOf, observationBytes } from '../src/interp/ast-interp.js';
import { TRAP } from '../src/traps.js';
import { INT_MIN, INT_MAX } from '../src/values.js';
import { parse } from '../src/parser.js';
import { analyze } from '../src/sema.js';

/** Parse and analyse, failing the test if the program does not compile. */
function analyzeOk(source) {
  const { program, diags } = parse(source);
  analyze(program, diags);
  assert.deepEqual(diags.items.map((d) => d.message), []);
  return { program };
}

/** Run, with the output decoded as text for readable assertions. */
function run(source, options) {
  const result = runSource(source, options);
  return {
    ...result,
    text: new TextDecoder().decode(result.output),
    trailer: trailerOf(result),
  };
}

const main = (body) => `int main() { ${body} }`;

test('a program that prints and returns', () => {
  const r = run(main('print(1); print(2); return 0;'));
  assert.equal(r.text, '1\n2\n');
  assert.equal(r.outcome, 'exit');
  assert.equal(r.status, 0);
});

test('putchar writes one byte, print writes decimal and a newline', () => {
  const r = run(main("putchar(72); putchar(105); putchar(10); print(-5); return 0;"));
  assert.equal(r.text, 'Hi\n-5\n');
});

test('putchar takes the value modulo 256, made non-negative', () => {
  const r = run(main('putchar(321); putchar(-191); return 0;'));
  assert.deepEqual([...r.output], [65, 65]);
});

test('the exit status is the low byte of what main returns', () => {
  assert.equal(run(main('return 0;')).status, 0);
  assert.equal(run(main('return 7;')).status, 7);
  assert.equal(run(main('return 256;')).status, 0);
  assert.equal(run(main('return 300;')).status, 44);
  assert.equal(run(main('return -1;')).status, 255);
});

test('arithmetic wraps, as the document says', () => {
  const r = run(main(`print(2147483647 + 1); print(-2147483648 - 1); print(-(-2147483648));
                      print(65536 * 65536); return 0;`));
  assert.equal(r.text, `${INT_MIN}\n${INT_MAX}\n${INT_MIN}\n0\n`);
});

test('division truncates toward zero and the remainder follows the dividend', () => {
  const r = run(main('print(7 / 2); print(-7 / 2); print(7 % -2); print(-7 % 2); return 0;'));
  assert.equal(r.text, '3\n-3\n1\n-1\n');
});

test('division by zero traps, and the output before it is kept', () => {
  const r = run(main('print(1); return 4 / 0;'));
  assert.equal(r.text, '1\n');
  assert.equal(r.outcome, 'trap');
  assert.equal(r.trap.kind, TRAP.DIV_BY_ZERO);
  assert.equal(r.status, null);
});

test('INT_MIN / -1 and INT_MIN % -1 both trap', () => {
  for (const op of ['/', '%']) {
    const r = run(main(`int a = -2147483648; int b = -1; return a ${op} b;`));
    assert.equal(r.outcome, 'trap');
    assert.equal(r.trap.kind, TRAP.DIV_OVERFLOW);
  }
});

test('reading and writing out of bounds traps, at either end', () => {
  for (const body of ['int a[3]; return a[3];', 'int a[3]; return a[-1];',
    'int a[3]; a[3] = 1; return 0;']) {
    const r = run(main(body));
    assert.equal(r.outcome, 'trap', body);
    assert.equal(r.trap.kind, TRAP.OUT_OF_BOUNDS);
  }
});

test('a trap reports where it happened', () => {
  const r = run('int main() {\n  int a[2];\n  return a[5];\n}');
  assert.equal(r.trap.span.line, 3);
  assert.equal(r.trailer, '=== trap out_of_bounds at 3:10');
});

test('unbounded recursion traps with stack_overflow rather than crashing', () => {
  const r = run('int f(int n) { return f(n + 1); } int main() { return f(0); }');
  assert.equal(r.outcome, 'trap');
  assert.equal(r.trap.kind, TRAP.STACK_OVERFLOW);
});

test('the depth limit counts main, so 999 nested calls fit and 1000 do not', () => {
  const recurse = (n) => `int f(int n) { if (n == 0) return 0; return f(n - 1) + 1; }
                          int main() { print(f(${n})); return 0; }`;
  // main occupies the first frame, so f(998) is the deepest that fits.
  assert.equal(run(recurse(998)).text, '998\n');
  assert.equal(run(recurse(999)).outcome, 'trap');
  assert.equal(run(recurse(999)).trap.kind, TRAP.STACK_OVERFLOW);
});

test('running out of host stack is reported loudly, never as a trap or an exit', () => {
  // An expression nested far deeper than anything the parser would produce, so
  // the interpreter's own recursion gives out. The point is that this does not
  // quietly become a wrong answer: a trap here would disagree with every other
  // implementation of the semantics. It is also why the random program
  // generator in phase 8 has to bound expression depth.
  const { program } = analyzeOk('int main() { return 1; }');
  const ret = program.functions[0].body.stmts[0];
  let expr = { kind: 'IntLit', value: 1, span: ret.span };
  for (let i = 0; i < 200000; i++) {
    expr = { kind: 'Binary', op: '+', left: expr, right: { kind: 'IntLit', value: 0, span: ret.span }, span: ret.span };
  }
  ret.value = expr;
  assert.throws(() => runProgram(program), /host stack exhausted at minic call depth \d+/);
});

test('&& and || do not evaluate the right operand when the left decides', () => {
  // `noisy` prints, so whether it ran is visible in the output.
  const source = `int noisy() { print(99); return 1; }
                  int main() { if (0 && noisy()) { } if (1 || noisy()) { } return 0; }`;
  assert.equal(run(source).text, '');
});

test('a short-circuited operand does not trap either', () => {
  const r = run(main('int z = 0; if (z != 0 && 1 / z) { } return 0;'));
  assert.equal(r.outcome, 'exit');
});

test('&& and || yield 1 or 0', () => {
  assert.equal(run(main('print(2 && 3); print(0 || 0); print(5 || 0); return 0;')).text, '1\n0\n1\n');
});

test('operands are evaluated left to right, which decides which trap is seen', () => {
  // Both sides would trap; the left one is the one that happens.
  const r = run(main('int a[1]; return a[5] + a[9];'));
  assert.equal(r.trap.detail, 'index 5, length 1');
});

test('in a[i] = e the value is evaluated before the bounds check', () => {
  // The index is out of range *and* the right-hand side traps. The document
  // fixes the order -- index, value, bounds check, store -- so the division
  // trap is the one observed, not the out-of-bounds one.
  const r = run(main('int a[1]; int z = 0; a[7] = 1 / z; return 0;'));
  assert.equal(r.outcome, 'trap');
  assert.equal(r.trap.kind, TRAP.DIV_BY_ZERO);
});

test('arguments are evaluated left to right', () => {
  const source = `int tell(int x) { print(x); return x; }
                  int add(int a, int b) { return a + b; }
                  int main() { return add(tell(1), tell(2)); }`;
  assert.equal(run(source).text, '1\n2\n');
});

test('arrays are passed by reference, so a callee can write through them', () => {
  const source = `void fill(int[] a, int n) { for (int i = 0; i < n; i = i + 1) a[i] = i * i; }
                  int main() { int b[4]; fill(b, 4); print(b[3]); return 0; }`;
  assert.equal(run(source).text, '9\n');
});

test('ints are passed by value', () => {
  const source = `void bump(int x) { x = x + 1; }
                  int main() { int v = 1; bump(v); print(v); return 0; }`;
  assert.equal(run(source).text, '1\n');
});

test('array elements start at zero, and an initializer fills only its prefix', () => {
  const r = run(main('int a[4] = {7, 8}; print(a[0]); print(a[2]); return 0;'));
  assert.equal(r.text, '7\n0\n');
});

test('a string initializer is its bytes and a terminating zero', () => {
  const r = run(main('int s[] = "hi"; print(s[0]); print(s[1]); print(s[2]); return 0;'));
  assert.equal(r.text, '104\n105\n0\n');
});

test('each execution of a declaration makes a fresh array', () => {
  const source = main(`int total = 0;
    for (int i = 0; i < 3; i = i + 1) { int a[2]; a[0] = a[0] + 1; total = total + a[0]; }
    print(total); return 0;`);
  assert.equal(run(source).text, '3\n');
});

test('shadowing resolves to the innermost declaration', () => {
  const r = run(main('int x = 1; { int x = 2; print(x); } print(x); return 0;'));
  assert.equal(r.text, '2\n1\n');
});

test('continue in a for loop still runs the step expression', () => {
  const r = run(main(`int n = 0;
    for (int i = 0; i < 5; i = i + 1) { if (i == 2) continue; n = n + 1; }
    print(n); return 0;`));
  assert.equal(r.text, '4\n');
});

test('break leaves only the innermost loop', () => {
  const r = run(main(`int n = 0;
    for (int i = 0; i < 3; i = i + 1) { while (1) { break; } n = n + 1; }
    print(n); return 0;`));
  assert.equal(r.text, '3\n');
});

test('recursion works, and mutual recursion too', () => {
  const source = `int fib(int n) { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }
    int even(int n) { if (n == 0) return 1; return odd(n - 1); }
    int odd(int n) { if (n == 0) return 0; return even(n - 1); }
    int main() { print(fib(15)); print(even(10)); return 0; }`;
  assert.equal(run(source).text, '610\n1\n');
});

test('a runaway program is stopped, and that is not a trap or a clean exit', () => {
  const r = run(main('while (1) { } return 0;'), { maxSteps: 5000 });
  assert.equal(r.outcome, 'budget');
  assert.equal(r.trap, null);
  assert.equal(r.status, null);
  assert.match(r.trailer, /^=== budget exceeded after \d+ steps$/);
});

test('the observation is output bytes followed by the trailer', () => {
  const result = runSource(main('print(42); return 3;'));
  assert.equal(new TextDecoder().decode(observationBytes(result)), '42\n=== exit 3\n');
});

test('a program that does not compile throws rather than running', () => {
  assert.throws(() => runSource(main('return nope;')), /undeclared variable/);
});
