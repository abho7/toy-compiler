// The catalogue of things semantic analysis rejects, one case per diagnostic.
//
// Messages are pinned so that a change in wording is a diff to review. Source
// positions are pinned for a representative handful rather than all of them:
// the 28 parser cases already hold position formatting, and for a type error
// the message and which node it blames are what matter.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeSource } from '../src/sema.js';
import { render } from '../src/diagnostics.js';

const messagesOf = (source) => analyzeSource(source).diags.items.map((d) => d.message);
const positionedOf = (source) =>
  analyzeSource(source).diags.items.map((d) => `${d.span.line}:${d.span.col} ${d.message}`);

const CASES = [
  // --- names and scopes ---
  {
    name: 'undeclared variable',
    source: 'int main() { return x; }',
    expect: ["undeclared variable 'x'"],
  },
  {
    name: 'undeclared function',
    source: 'int main() { return f(); }',
    expect: ["undeclared function 'f'"],
  },
  {
    name: 'variable declared twice in one scope',
    source: 'int main() { int x = 1; int x = 2; return x; }',
    expect: ["'x' is already declared in this scope"],
  },
  {
    name: 'function declared twice',
    source: 'int f() { return 0; } int f() { return 1; } int main() { return 0; }',
    expect: ["function 'f' is declared twice"],
  },
  {
    name: 'redeclaring a builtin',
    source: 'void print(int x) { } int main() { return 0; }',
    expect: ["'print' is a builtin and cannot be redeclared"],
  },
  {
    name: 'parameter declared twice',
    source: 'int f(int a, int a) { return a; } int main() { return 0; }',
    expect: ["parameter 'a' is declared twice"],
  },
  {
    name: 'calling a variable',
    source: 'int main() { int x = 1; return x(); }',
    expect: ["'x' is not a function"],
  },
  {
    name: 'using a function as a value',
    source: 'int f() { return 0; } int main() { return f; }',
    expect: ["'f' is a function; call it as f(...)"],
  },

  // --- main ---
  {
    name: 'no main',
    source: 'int f() { return 0; }',
    expect: ["every program must declare 'int main()'"],
  },
  {
    name: 'main with parameters',
    source: 'int main(int argc) { return 0; }',
    expect: ["'main' must take no parameters"],
  },
  {
    name: 'main returning void',
    source: 'void main() { }',
    expect: ["'main' must return int"],
  },

  // --- calls ---
  {
    name: 'too few arguments',
    source: 'int f(int a, int b) { return a + b; } int main() { return f(1); }',
    expect: ["'f' takes 2 arguments but 1 was given"],
  },
  {
    name: 'too many arguments',
    source: 'int f(int a) { return a; } int main() { return f(1, 2); }',
    expect: ["'f' takes 1 argument but 2 were given"],
  },
  {
    name: 'int passed where an array is expected',
    source: 'int f(int[] a) { return a[0]; } int main() { return f(1); }',
    expect: ["argument 1 of 'f' must be an array, but this is an int"],
  },
  {
    name: 'array passed where an int is expected',
    source: 'int f(int a) { return a; } int main() { int b[2]; return f(b); }',
    expect: ["argument 1 of 'f' must be an int, but 'b' is an array"],
  },
  {
    name: 'a void call used as a value',
    source: 'int main() { int x = print(1); return x; }',
    expect: ["the initial value of 'x' must be an int, but 'print(...)' returns nothing"],
  },

  // --- types ---
  {
    name: 'indexing an int',
    source: 'int main() { int x = 1; return x[0]; }',
    expect: ["cannot index 'x', which is an int"],
  },
  {
    name: 'indexing with an array',
    source: 'int main() { int a[2]; int b[2]; return a[b]; }',
    expect: ["an array index must be an int, but 'b' is an array"],
  },
  {
    name: 'arithmetic on an array',
    source: 'int main() { int a[2]; return a + 1; }',
    expect: ["the left operand of '+' must be an int, but 'a' is an array"],
  },
  {
    name: 'negating an array',
    source: 'int main() { int a[2]; return -a; }',
    expect: ["the operand of '-' must be an int, but 'a' is an array"],
  },
  {
    name: 'an array as a condition',
    source: 'int main() { int a[2]; if (a) { } return 0; }',
    expect: ["a condition must be an int, but 'a' is an array"],
  },
  {
    name: 'assigning to an array name',
    source: 'int main() { int a[2]; int b[2]; a = b; return 0; }',
    expect: ["cannot assign to array 'a'"],
  },
  {
    name: 'assigning an array to an element',
    source: 'int main() { int a[2]; int b[2]; a[0] = b; return 0; }',
    expect: ["the assigned value must be an int, but 'b' is an array"],
  },

  // --- arrays ---
  {
    name: 'array length from a variable',
    source: 'int main() { int n = 4; int a[n]; return 0; }',
    expect: ['an array length must be a constant expression'],
  },
  {
    name: 'array length of zero',
    source: 'int main() { int a[0]; return 0; }',
    expect: ['an array length must be greater than zero, but is 0'],
  },
  {
    name: 'negative array length',
    source: 'int main() { int a[-1]; return 0; }',
    expect: ['an array length must be greater than zero, but is -1'],
  },
  {
    name: 'array length that would trap',
    source: 'int main() { int a[4 / 0]; return 0; }',
    expect: ['an array length must be a constant expression that does not trap'],
  },
  {
    name: 'initializer longer than the array',
    source: 'int main() { int a[2] = {1, 2, 3}; return 0; }',
    expect: ["the initializer has 3 elements but 'a' holds 2"],
  },
  {
    name: 'empty initializer with no length',
    source: 'int main() { int a[] = {}; return 0; }',
    expect: ["array 'a' needs at least one element"],
  },

  // --- returns and loop context ---
  {
    name: 'returning a value from a void function',
    source: 'void f() { return 1; } int main() { return 0; }',
    expect: ["cannot return a value from 'f', which returns void"],
  },
  {
    name: 'returning nothing from an int function',
    source: 'int f() { return; } int main() { return 0; }',
    expect: ["'f' must return a value"],
  },
  {
    name: 'a path with no return',
    source: 'int f(int x) { if (x) return 1; } int main() { return 0; }',
    expect: ["'f' must return a value on every path"],
  },
  {
    name: 'a loop that can break does not count as returning',
    source: 'int f() { while (1) { break; } } int main() { return 0; }',
    expect: ["'f' must return a value on every path"],
  },
  {
    name: 'break outside a loop',
    source: 'int main() { break; return 0; }',
    expect: ["'break' is only allowed inside a loop"],
  },
  {
    name: 'continue outside a loop',
    source: 'int main() { continue; return 0; }',
    expect: ["'continue' is only allowed inside a loop"],
  },
  {
    name: 'break in a function body, outside its loops',
    source: 'int main() { while (1) { } break; }',
    expect: ["'break' is only allowed inside a loop"],
  },
];

for (const c of CASES) {
  test(`rejects: ${c.name}`, () => {
    assert.deepEqual(messagesOf(c.source), c.expect);
  });
}

test('every case in the catalogue is genuinely rejected', () => {
  for (const c of CASES) {
    assert.ok(messagesOf(c.source).length > 0, `${c.name} produced no diagnostic`);
  }
});

test('one mistake produces one message, not a cascade', () => {
  // The result of an unresolved name has type 'error', which is compatible
  // with everything, so the operators above it stay quiet.
  assert.deepEqual(messagesOf('int main() { return nope + 1 * nope; }'),
    ["undeclared variable 'nope'", "undeclared variable 'nope'"]);
  assert.deepEqual(messagesOf('int main() { return oops(1)[2] + 3; }'),
    ["undeclared function 'oops'"]);
});

test('diagnostics point at the right place', () => {
  assert.deepEqual(positionedOf('int main() {\n  return x;\n}'),
    ["2:10 undeclared variable 'x'"]);
  assert.deepEqual(positionedOf('int main() {\n  int a[2];\n  return a[0] + a;\n}'),
    ["3:17 the right operand of '+' must be an int, but 'a' is an array"]);
  assert.deepEqual(positionedOf('int f(int x) {\n  if (x) return 1;\n}\nint main() { return 0; }'),
    ["1:1 'f' must return a value on every path"]);
});

test('a duplicate declaration says where the first one was', () => {
  const { diags } = analyzeSource('int main() {\n  int x = 1;\n  int x = 2;\n  return x;\n}');
  assert.equal(diags.items.length, 1);
  assert.match(diags.items[0].notes[0], /^first declared at 2:3$/);
});

test('an array length that depends on a variable explains why it cannot', () => {
  const { diags } = analyzeSource('int main() { int n = 4; int a[n]; return 0; }');
  assert.match(diags.items[0].notes[0], /known while compiling/);
});

test('a rejected program renders with a caret, like every other error', () => {
  const source = 'int main() {\n  int a[2];\n  return a + 1;\n}';
  const { diags } = analyzeSource(source);
  assert.equal(render(source, diags.items[0]), [
    "error: the left operand of '+' must be an int, but 'a' is an array",
    '  --> <input>:3:10',
    '  |',
    '3 |   return a + 1;',
    '  |          ^',
  ].join('\n'));
});

test('a parse error stops before semantic analysis, so there is no double reporting', () => {
  const messages = messagesOf('int main() { int x = ; return nope; }');
  assert.deepEqual(messages, ["expected an expression, found ';'"]);
});
