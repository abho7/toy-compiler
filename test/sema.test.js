// What semantic analysis establishes for the phases after it.
//
// These are the guarantees the IR builder and the interpreters are written
// against: names resolved, types known, array lengths known, returns covered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { analyzeSource, constEval, alwaysReturns } from '../src/sema.js';
import { parseOrThrow } from '../src/parser.js';
import { render } from '../src/diagnostics.js';
import { INT_MIN } from '../src/values.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Analyse, and fail loudly with rendered diagnostics if anything complained. */
function clean(source) {
  const result = analyzeSource(source);
  assert.deepEqual(result.diags.items.map((d) => render(source, d)), []);
  return result;
}

const bodyOf = (program, name = 'main') =>
  program.functions.find((f) => f.name === name).body.stmts;

test('expressions are annotated with their types', () => {
  const { program } = clean('int main() { int x = 1; return x + 2; }');
  const ret = bodyOf(program)[1];
  assert.equal(ret.value.type, 'int');
  assert.equal(ret.value.left.type, 'int');
  assert.equal(ret.value.left.symbol.name, 'x');
});

test('an array name has array type, and indexing it has int type', () => {
  const { program } = clean('int main() { int a[3]; return a[0]; }');
  const ret = bodyOf(program)[1];
  assert.equal(ret.value.kind, 'Index');
  assert.equal(ret.value.type, 'int');
  assert.equal(ret.value.array.type, 'int[]');
  assert.equal(ret.value.array.symbol.length, 3);
});

test('a constant expression may give the length', () => {
  const { program } = clean('int main() { int a[2 * 3 + 1]; return a[6]; }');
  assert.equal(bodyOf(program)[0].length, 7);
});

test('an omitted length is inferred from the initializer', () => {
  const { program } = clean('int main() { int a[] = {1, 2, 3}; return a[0]; }');
  const decl = bodyOf(program)[0];
  assert.equal(decl.length, 3);
  assert.equal(decl.symbol.type, 'int[]');
});

test('a string initializer includes its terminating zero in the length', () => {
  const { program } = clean('int main() { int s[] = "hi"; return s[0]; }');
  assert.equal(bodyOf(program)[0].length, 3);
});

test('an initializer shorter than the array is fine; the rest is zero', () => {
  const { program } = clean('int main() { int a[4] = {1, 2}; return a[3]; }');
  assert.equal(bodyOf(program)[0].length, 4);
});

test('a call is resolved to its signature, and builtins are callable', () => {
  const { program } = clean('int f(int x) { return x; } int main() { print(f(1)); putchar(65); return 0; }');
  const [printCall] = bodyOf(program);
  assert.equal(printCall.expr.sig.name, 'print');
  assert.equal(printCall.expr.type, 'void');
  assert.equal(printCall.expr.args[0].sig.name, 'f');
  assert.equal(printCall.expr.args[0].type, 'int');
});

test('an inner block shadows an outer declaration with a distinct symbol', () => {
  const { program } = clean('int main() { int x = 1; { int x = 2; return x; } }');
  const outer = bodyOf(program)[0].symbol;
  const innerBlock = bodyOf(program)[1];
  const inner = innerBlock.stmts[0].symbol;
  assert.notEqual(outer.id, inner.id);
  assert.equal(innerBlock.stmts[1].value.symbol.id, inner.id, 'the inner x must win');
});

test('a declaration in the body may shadow a parameter', () => {
  const { program } = clean('int f(int x) { int x = 2; return x; } int main() { return f(1); }');
  const decl = bodyOf(program, 'f')[0];
  assert.notEqual(decl.symbol.id, program.functions[0].params[0].symbol.id);
});

test('the same name in two sibling blocks is two symbols, not a clash', () => {
  clean('int main() { { int t = 1; } { int t = 2; } return 0; }');
});

test('mutual recursion works, because signatures are collected first', () => {
  clean(`int even(int n) { if (n == 0) return 1; return odd(n - 1); }
         int odd(int n) { if (n == 0) return 0; return even(n - 1); }
         int main() { return even(4); }`);
});

test('an array parameter is passed by reference and may be indexed and stored to', () => {
  const { program } = clean(`void fill(int[] a, int n) { for (int i = 0; i < n; i = i + 1) a[i] = i; }
                             int main() { int b[4]; fill(b, 4); return b[0]; }`);
  assert.equal(program.functions[0].params[0].symbol.type, 'int[]');
});

test('locals and parameters are numbered in declaration order', () => {
  const { program } = clean('int f(int p) { int a = 1; int b[2]; return a + p; } int main() { return f(1); }');
  assert.deepEqual(program.functions[0].locals.map((s) => [s.name, s.id, s.kind]),
    [['p', 0, 'param'], ['a', 1, 'var'], ['b', 2, 'var']]);
});

test("a loop that cannot finish normally counts as returning", () => {
  clean('int f() { while (1) { return 1; } } int main() { return f(); }');
  clean('int f() { for (;;) { return 1; } } int main() { return f(); }');
  clean('int f(int x) { while (1) { if (x) return 1; } } int main() { return f(1); }');
});

test('a break in a nested loop does not rescue the outer one', () => {
  // The inner loop's break belongs to the inner loop, so the outer `while (1)`
  // still cannot finish normally and the function still returns on every path.
  clean(`int f(int n) { while (1) { while (n) { break; } return 1; } }
         int main() { return f(1); }`);
});

test('if/else covering both branches returns on every path', () => {
  clean('int f(int x) { if (x) return 1; else return 2; } int main() { return f(1); }');
});

test('a void function needs no return at all', () => {
  clean('void f() { } int main() { f(); return 0; }');
});

test('analysing a valid program reports nothing and leaves every name resolved', () => {
  const source = `int sum(int[] a, int n) {
      int total = 0;
      for (int i = 0; i < n; i = i + 1) total = total + a[i];
      return total;
    }
    int main() {
      int xs[] = {1, 2, 3, 4};
      print(sum(xs, 4));
      return 0;
    }`;
  const { program } = clean(source);
  // Every Name in the tree resolved to something.
  const unresolved = [];
  const walkExpr = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.kind === 'Name' && !n.symbol) unresolved.push(n.name);
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(walkExpr);
      else if (v && typeof v === 'object' && v.kind) walkExpr(v);
    }
  };
  walkExpr(program);
  assert.deepEqual(unresolved, []);
});

test('the quicksort in docs/language.md type-checks, not just parses', () => {
  const markdown = readFileSync(join(ROOT, 'docs/language.md'), 'utf8');
  const source = [...markdown.matchAll(/```c\n([\s\S]*?)```/g)]
    .map((m) => m[1]).find((s) => s.includes('int main('));
  assert.ok(source, 'no complete program found in docs/language.md');
  clean(source);
});

test('constEval uses the same arithmetic as the interpreters', () => {
  const expr = (src) => parseOrThrow(`int main() { return ${src}; }`)
    .functions[0].body.stmts[0].value;
  assert.deepEqual(constEval(expr('2 + 3 * 4')), { ok: true, value: 14 });
  assert.deepEqual(constEval(expr('7 / 2')), { ok: true, value: 3 });
  assert.deepEqual(constEval(expr('-7 % 2')), { ok: true, value: -1 });
  assert.deepEqual(constEval(expr('1 << 32')), { ok: true, value: 1 });
  assert.deepEqual(constEval(expr('2147483647 + 1')), { ok: true, value: INT_MIN });
  assert.deepEqual(constEval(expr('0 && 1')), { ok: true, value: 0 });
  assert.deepEqual(constEval(expr('5 || 0')), { ok: true, value: 1 });
  // A trapping expression is not a constant, and says so distinctly.
  assert.deepEqual(constEval(expr('1 / 0')), { ok: false, trap: 'div_by_zero' });
  assert.equal(constEval(expr('x + 1')).ok, false);
});

test('alwaysReturns is not fooled by a break out of the only loop', () => {
  const fnBody = (src) => parseOrThrow(src).functions[0].body;
  assert.equal(alwaysReturns(fnBody('int f() { while (1) { break; } }')), false);
  assert.equal(alwaysReturns(fnBody('int f() { while (1) { return 1; } }')), true);
  assert.equal(alwaysReturns(fnBody('int f(int x) { if (x) return 1; }')), false);
});
