import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse, parseOrThrow } from '../src/parser.js';
import { printAst } from '../src/ast.js';

/** The AST of one expression, as indented text, with the scaffolding stripped. */
function exprTree(source) {
  const program = parseOrThrow(`int main() { ${source}; }`);
  const stmt = program.functions[0].body.stmts[0];
  return printAst(stmt.expr).split('\n').map((l) => l.replace(/^ {0}/, '')).join('\n');
}

test('a whole function parses to the expected shape', () => {
  const program = parseOrThrow('int add(int a, int b) { return a + b; }');
  assert.equal(printAst(program), [
    'Program',
    '  FunctionDecl int add(int a, int b)',
    '    Block',
    '      Return',
    '        Binary +',
    '          Name a',
    '          Name b',
  ].join('\n'));
});

test('precedence follows the grammar: * binds tighter than +, + than <, < than &&', () => {
  assert.equal(exprTree('1 + 2 * 3 < 10 && x'), [
    'Logical &&',
    '  Binary <',
    '    Binary +',
    '      IntLit 1',
    '      Binary *',
    '        IntLit 2',
    '        IntLit 3',
    '    IntLit 10',
    '  Name x',
  ].join('\n'));
});

test('bitwise precedence: | is looser than ^, which is looser than &, and all are looser than ==', () => {
  assert.equal(exprTree('a | b ^ c & d == e'), [
    'Binary |',
    '  Name a',
    '  Binary ^',
    '    Name b',
    '    Binary &',
    '      Name c',
    '      Binary ==',
    '        Name d',
    '        Name e',
  ].join('\n'));
});

test('shifts bind tighter than comparison and looser than addition', () => {
  assert.equal(exprTree('a + b << c < d'), [
    'Binary <',
    '  Binary <<',
    '    Binary +',
    '      Name a',
    '      Name b',
    '    Name c',
    '  Name d',
  ].join('\n'));
});

test('binary operators are left-associative', () => {
  assert.equal(exprTree('1 - 2 - 3'), [
    'Binary -',
    '  Binary -',
    '    IntLit 1',
    '    IntLit 2',
    '  IntLit 3',
  ].join('\n'));
});

test('assignment is right-associative and takes an lvalue', () => {
  assert.equal(exprTree('x = a[i] = 3'), [
    'Assign',
    '  Name x',
    '  Assign',
    '    Index',
    '      Name a',
    '      Name i',
    '    IntLit 3',
  ].join('\n'));
});

test('parentheses override precedence', () => {
  assert.equal(exprTree('(1 + 2) * 3'), [
    'Binary *',
    '  Binary +',
    '    IntLit 1',
    '    IntLit 2',
    '  IntLit 3',
  ].join('\n'));
});

test('unary operators nest and bind tighter than binary ones', () => {
  assert.equal(exprTree('-!~x * 2'), [
    'Binary *',
    '  Unary -',
    '    Unary !',
    '      Unary ~',
    '        Name x',
    '  IntLit 2',
  ].join('\n'));
});

test('&& and || are Logical nodes, because short-circuiting is control flow', () => {
  const tree = exprTree('a && b || c');
  assert.equal(tree, ['Logical ||', '  Logical &&', '    Name a', '    Name b', '  Name c'].join('\n'));
});

test('calls and indexing chain', () => {
  assert.equal(exprTree('f(1, g(2))[3]'), [
    'Index',
    '  Call f',
    '    IntLit 1',
    '    Call g',
    '      IntLit 2',
    '  IntLit 3',
  ].join('\n'));
});

test('a call with no arguments parses', () => {
  assert.equal(exprTree('f()'), 'Call f');
});

test('else binds to the nearest unmatched if', () => {
  const program = parseOrThrow('int main() { if (a) if (b) x = 1; else x = 2; }');
  const outer = program.functions[0].body.stmts[0];
  assert.equal(outer.otherwise, null, 'the outer if must have no else');
  assert.equal(outer.then.kind, 'If');
  assert.ok(outer.then.otherwise, 'the inner if must own the else');
});

test('loops, break and continue parse', () => {
  const program = parseOrThrow(
    'void f() { while (1) { break; } for (int i = 0; i < 3; i = i + 1) continue; }');
  const [loop, forLoop] = program.functions[0].body.stmts;
  assert.equal(loop.kind, 'While');
  assert.equal(loop.body.stmts[0].kind, 'Break');
  assert.equal(forLoop.kind, 'For');
  assert.equal(forLoop.init.kind, 'VarDecl');
  assert.equal(forLoop.step.kind, 'Assign');
  assert.equal(forLoop.body.kind, 'Continue');
});

test('a for loop may omit any of its three clauses', () => {
  const program = parseOrThrow('void f() { for (;;) { break; } }');
  const loop = program.functions[0].body.stmts[0];
  assert.deepEqual([loop.init, loop.cond, loop.step], [null, null, null]);
});

test('array declarations: sized, initialized, inferred, and from a string', () => {
  const program = parseOrThrow(`int main() {
    int a[4];
    int b[4] = {1, 2};
    int c[] = {1, 2, 3};
    int s[] = "hi";
  }`);
  const [a, b, c, s] = program.functions[0].body.stmts;
  assert.equal(a.size.value, 4);
  assert.equal(a.init, null);
  assert.deepEqual(b.init.map((e) => e.value), [1, 2]);
  assert.equal(c.size, null);
  assert.deepEqual(c.init.map((e) => e.value), [1, 2, 3]);
  // A string initializer is its bytes plus a terminating zero.
  assert.equal(s.fromString, true);
  assert.deepEqual(s.init.map((e) => e.value), [104, 105, 0]);
});

test('-2147483648 folds into a single literal, since that is the only way to write INT_MIN', () => {
  const program = parseOrThrow('int main() { return -2147483648; }');
  const value = program.functions[0].body.stmts[0].value;
  assert.equal(value.kind, 'IntLit');
  assert.equal(value.value, -2147483648);
});

test('negating a non-literal stays a Unary node', () => {
  assert.equal(exprTree('-x'), ['Unary -', '  Name x'].join('\n'));
});

test('-(-2147483648) stays a negation, because its value is one past INT_MAX', () => {
  // Folding it would produce a literal the range check rejects, but the
  // expression is legal: negation wraps, so it evaluates to INT_MIN again.
  const program = parseOrThrow('int main() { return -(-2147483648); }');
  const value = program.functions[0].body.stmts[0].value;
  assert.equal(value.kind, 'Unary');
  assert.equal(value.operand.kind, 'IntLit');
  assert.equal(value.operand.value, -2147483648);
});

test('an int[] parameter is recorded as such', () => {
  const program = parseOrThrow('int sum(int[] xs, int n) { return 0; }');
  assert.deepEqual(program.functions[0].params.map((p) => [p.type, p.name]),
    [['int[]', 'xs'], ['int', 'n']]);
});

test('several functions parse into one program', () => {
  const program = parseOrThrow('void a() {} int b() { return 1; } void c() {}');
  assert.deepEqual(program.functions.map((f) => f.name), ['a', 'b', 'c']);
  assert.deepEqual(program.functions.map((f) => f.returnType), ['void', 'int', 'void']);
});

test('nodes carry spans that point back at the source', () => {
  const program = parseOrThrow('int main() {\n  return 42;\n}');
  const ret = program.functions[0].body.stmts[0];
  assert.equal(ret.span.line, 2);
  assert.equal(ret.value.span.line, 2);
  assert.equal(ret.value.span.col, 10);
});

test('parsing a valid program reports nothing', () => {
  const { diags } = parse('int main() { int a[2] = {1, 2}; return a[0]; }');
  assert.deepEqual(diags.items, []);
});
