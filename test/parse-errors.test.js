// What the compiler says about programs that are wrong.
//
// Error messages are a feature, so they are pinned: each case below records
// every diagnostic the compiler produces, as `line:col message`. A change in
// wording shows up here as a diff to review rather than as a silent
// regression, and the cases with more than one diagnostic are the ones that
// prove error recovery keeps going instead of stopping at the first mistake.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../src/parser.js';
import { render } from '../src/diagnostics.js';

/** Every diagnostic for `source`, as `line:col message`. */
function errorsOf(source) {
  const { diags } = parse(source);
  return diags.items.map((d) => `${d.span.line}:${d.span.col} ${d.message}`);
}

const CASES = [
  {
    name: 'missing semicolon after a declaration',
    source: 'int main() {\n  int x = 1\n  return x;\n}',
    expect: ["3:3 expected ';' after the declaration of 'x', found keyword 'return'"],
  },
  {
    name: 'missing semicolon after an expression statement',
    source: 'int main() {\n  f(1)\n}',
    expect: ["3:1 expected ';' after the expression, found '}'"],
  },
  {
    name: "missing '(' after if",
    source: 'int main() {\n  if x > 1 { return 1; }\n}',
    expect: ["2:6 expected '(' after 'if', found identifier 'x'"],
  },
  {
    name: "missing ')' after a condition",
    source: 'int main() {\n  if (x > 1 { return 1; }\n}',
    expect: ["2:13 expected ')' after the condition, found '{'"],
  },
  {
    name: 'missing parentheses around a while condition',
    source: 'int main() {\n  while x < 3 { }\n}',
    expect: ["2:9 expected '(' after 'while', found identifier 'x'"],
  },
  {
    name: 'unclosed block runs to end of file',
    source: 'int main() {\n  return 1;\n',
    expect: ["3:1 expected '}' to close this block, found end of file"],
  },
  {
    name: 'missing function body',
    source: 'int main()\n',
    expect: ["2:1 expected '{' to begin the body of 'main', found end of file"],
  },
  {
    name: 'missing return type at the top level',
    source: 'main() { return 0; }',
    expect: ["1:1 expected 'int' or 'void' to begin a function declaration, found identifier 'main'"],
  },
  {
    name: 'stray closing brace at the top level',
    source: '}\nint main() { return 0; }',
    expect: ["1:1 expected 'int' or 'void' to begin a function declaration, found '}'"],
  },
  {
    name: 'parameter without a name',
    source: 'int f(int) { return 0; }',
    expect: ["1:10 expected a parameter name, found ')'"],
  },
  {
    name: 'missing comma between parameters',
    source: 'int f(int a int b) { return 0; }',
    expect: ["1:13 expected ',' or ')' in the parameter list, found keyword 'int'"],
  },
  {
    name: 'parameter with no type',
    source: 'int f(a, b) { return 0; }',
    expect: ['1:7 expected a parameter type, found identifier \'a\''],
  },
  {
    name: 'missing expression after =',
    source: 'int main() {\n  int x = ;\n}',
    expect: ["2:11 expected an expression, found ';'"],
  },
  {
    name: 'missing operand after a binary operator',
    source: 'int main() {\n  return 1 + ;\n}',
    expect: ["2:14 expected an expression, found ';'"],
  },
  {
    name: "missing ']' after an index",
    source: 'int main() {\n  return a[1;\n}',
    expect: ["2:13 expected ']' after the array index, found ';'"],
  },
  {
    name: "missing ')' in a call",
    source: 'int main() {\n  f(1, 2;\n}',
    expect: ["2:9 expected ',' or ')' in the argument list, found ';'"],
  },
  {
    name: 'empty argument in a call',
    source: 'int main() {\n  f(1,,2);\n}',
    expect: ["2:7 expected an expression, found ','"],
  },
  {
    name: 'assignment to a call',
    source: 'int main() {\n  f() = 1;\n}',
    expect: ['2:3 this expression cannot be assigned to'],
  },
  {
    name: 'assignment to a literal',
    source: 'int main() {\n  1 = 2;\n}',
    expect: ['2:3 this expression cannot be assigned to'],
  },
  {
    name: 'string literal used as a value',
    source: 'int main() {\n  int x = "hi";\n}',
    expect: ['2:11 a string literal can only initialize an array'],
  },
  {
    name: 'array initializer without braces',
    source: 'int main() {\n  int a[2] = 1, 2;\n}',
    expect: ['2:14 expected an initializer: `{ ... }` or a string, found integer 1'],
  },
  {
    // Genuinely ambiguous input: `2 = {1}` is parsed as the length expression
    // before the missing `]` is discovered, so it reports what it found on the
    // way. Three messages for one typo is the honest outcome here, and it is
    // pinned rather than hidden.
    name: "missing ']' in an array declaration",
    source: 'int main() {\n  int a[2 = {1};\n}',
    expect: [
      "2:13 expected an expression, found '{'",
      '2:9 this expression cannot be assigned to',
      "2:13 expected ']' after the array length, found '{'",
    ],
  },
  {
    name: 'array with neither a length nor an initializer',
    source: 'int main() {\n  int a[];\n}',
    expect: ["2:3 array 'a' needs either a length or an initializer"],
  },
  {
    name: 'missing semicolons in a for header',
    source: 'int main() {\n  for (int i = 0 i < 3; i = i + 1) { }\n}',
    expect: ["2:18 expected ';' after the initializer of 'for', found identifier 'i'"],
  },
  {
    name: 'a keyword where a name belongs',
    source: 'int main() {\n  int if = 1;\n}',
    expect: ["2:7 expected a name after `int`, found keyword 'if'"],
  },
  {
    name: 'integer literal one past the largest int',
    source: 'int main() {\n  return 2147483648;\n}',
    expect: ['2:10 integer literal 2147483648 does not fit in int'],
  },
  {
    name: 'recovery reports a second error rather than stopping at the first',
    source: 'int main() {\n  int x = 1\n  int y = ;\n  return x;\n}',
    expect: [
      "3:3 expected ';' after the declaration of 'x', found keyword 'int'",
      "3:11 expected an expression, found ';'",
    ],
  },
  {
    name: 'recovery continues into the next function',
    source: 'int a() {\n  return 1 +;\n}\nint b() {\n  return 2 +;\n}',
    expect: [
      "2:13 expected an expression, found ';'",
      "5:13 expected an expression, found ';'",
    ],
  },
];

for (const c of CASES) {
  test(`error: ${c.name}`, () => {
    assert.deepEqual(errorsOf(c.source), c.expect);
  });
}

test('every case above is genuinely rejected', () => {
  for (const c of CASES) {
    assert.ok(errorsOf(c.source).length > 0, `${c.name} produced no diagnostic`);
  }
});

test('a diagnostic is rendered with the source line and a caret under the token', () => {
  const { diags } = parse('int main() {\n  int x = 1\n  return x;\n}');
  assert.equal(render(diags.source, diags.items[0]), [
    "error: expected ';' after the declaration of 'x', found keyword 'return'",
    '  --> <input>:3:3',
    '  |',
    '3 |   return x;',
    "  |   ^^^^^^ expected ';'",
  ].join('\n'));
});

test('a caret under a multi-character token covers the whole token', () => {
  const { diags } = parse('int main() {\n  return 1 + ;\n}');
  const rendered = render(diags.source, diags.items[0]);
  assert.match(rendered, /\n {2}\| {14}\^ expected an expression$/);
});
