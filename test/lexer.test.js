import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenize, INT_MAX, INT_MIN_MAGNITUDE } from '../src/lexer.js';
import { render } from '../src/diagnostics.js';

/** Token kinds and values, with 'eof' dropped, for compact comparisons. */
function lex(source) {
  const { tokens, diags } = tokenize(source);
  return {
    tokens: tokens.slice(0, -1).map((t) => [t.kind, t.value]),
    errors: diags.items.map((d) => d.message),
    diags,
  };
}

test('keywords are distinguished from identifiers', () => {
  const { tokens } = lex('int x; intx; voidly return');
  assert.deepEqual(tokens, [
    ['keyword', 'int'], ['ident', 'x'], ['op', ';'],
    ['ident', 'intx'], ['op', ';'],
    ['ident', 'voidly'], ['keyword', 'return'],
  ]);
});

test('integer literals in every supported base', () => {
  const { tokens, errors } = lex('0 42 0x2a 0X2A 0b101010 1_000');
  assert.deepEqual(errors, []);
  assert.deepEqual(tokens.map((t) => t[1]), [0, 42, 42, 42, 42, 1000]);
});

test('the largest int and the magnitude of the smallest both lex', () => {
  const { tokens, errors } = lex(`${INT_MAX} ${INT_MIN_MAGNITUDE}`);
  assert.deepEqual(errors, []);
  assert.deepEqual(tokens.map((t) => t[1]), [INT_MAX, INT_MIN_MAGNITUDE]);
});

test('a literal larger than any int is reported where it is written', () => {
  const { errors } = lex('int x = 9999999999;');
  assert.deepEqual(errors, ['integer literal 9999999999 does not fit in int']);
});

test('a number running into an identifier is one mistake, not two tokens', () => {
  const { tokens, errors } = lex('123abc');
  assert.deepEqual(errors, ["invalid number literal '123abc'"]);
  assert.deepEqual(tokens, [['int', 0]]);
});

test('a base prefix with no digits is reported', () => {
  assert.deepEqual(lex('0x').errors, ['hexadecimal literal needs at least one digit after `0x`']);
  assert.deepEqual(lex('0b2').errors, ['binary literal needs at least one digit after `0b`']);
});

test('operators prefer the longest match', () => {
  const { tokens } = lex('<< >> <= >= == != && || < > = ! & | ^ ~');
  assert.deepEqual(tokens.map((t) => t[1]),
    ['<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '<', '>', '=', '!', '&', '|', '^', '~']);
});

test('character literals and their escapes are byte values', () => {
  const { tokens, errors } = lex("'a' '\\n' '\\t' '\\r' '\\0' '\\\\' '\\''");
  assert.deepEqual(errors, []);
  assert.deepEqual(tokens.map((t) => t[1]), [97, 10, 9, 13, 0, 92, 39]);
});

test('a character literal must hold exactly one character', () => {
  assert.deepEqual(lex("'ab'").errors, ['character literal must hold exactly one character']);
  assert.deepEqual(lex("''").errors, ['empty character literal']);
  assert.deepEqual(lex("'a").errors, ['unterminated character literal']);
});

test('an unknown escape is reported, and lexing continues', () => {
  const { tokens, errors } = lex("'\\q' 5");
  assert.deepEqual(errors, ["unknown escape sequence '\\q'"]);
  assert.deepEqual(tokens.map((t) => t[1]), [0, 5]);
});

test('string literals become byte arrays', () => {
  const { tokens, errors } = lex('"hi\\n"');
  assert.deepEqual(errors, []);
  assert.deepEqual(tokens, [['string', [104, 105, 10]]]);
});

test('a string literal holds the UTF-8 bytes of what is written', () => {
  const { tokens } = lex('"é"');
  assert.deepEqual(tokens, [['string', [195, 169]]]);
});

test('a newline ends an unterminated string rather than eating the file', () => {
  const { errors, tokens } = lex('"oops\nint x;');
  assert.deepEqual(errors, ['unterminated string literal']);
  assert.deepEqual(tokens.slice(1).map((t) => t[1]), ['int', 'x', ';']);
});

test('comments are skipped, and an unterminated block comment is reported', () => {
  assert.deepEqual(lex('1 // two\n3 /* four */ 5').tokens.map((t) => t[1]), [1, 3, 5]);
  const bad = lex('1 /* never closed');
  assert.deepEqual(bad.errors, ['unterminated block comment']);
  assert.deepEqual(bad.tokens.map((t) => t[1]), [1]);
});

test('block comments do not nest, which the message says', () => {
  // `/* a /* b */` closes at the first `*/`, leaving `c` and `*/` behind.
  const { tokens, errors } = lex('/* a /* b */ c */');
  assert.deepEqual(errors, []);
  assert.deepEqual(tokens.map((t) => t[1]), ['c', '*', '/']);
});

test('an unexpected character is reported once and skipped', () => {
  const { tokens, errors } = lex('int x = 4 $ 5;');
  assert.deepEqual(errors, ["unexpected character '$'"]);
  assert.deepEqual(tokens.map((t) => t[1]), ['int', 'x', '=', 4, 5, ';']);
});

test('spans carry the line and column of the token', () => {
  const { tokens } = tokenize('int x;\n  return 42;\n');
  const fortyTwo = tokens.find((t) => t.value === 42);
  assert.equal(fortyTwo.span.line, 2);
  assert.equal(fortyTwo.span.col, 10);
  assert.equal(fortyTwo.span.end - fortyTwo.span.start, 2);
});

test('a diagnostic points at the offending text', () => {
  const { diags } = lex('int x = 1;\nint y = 2 $ 3;\n');
  assert.equal(render(diags.source, diags.items[0]),
    [
      "error: unexpected character '$'",
      '  --> <input>:2:11',
      '  |',
      '2 | int y = 2 $ 3;',
      '  |           ^',
    ].join('\n'));
});

test('tokens describe themselves the way messages need', () => {
  const { tokens } = tokenize('int x 42 "s" ;');
  assert.deepEqual(tokens.map((t) => t.describe()), [
    "keyword 'int'", "identifier 'x'", 'integer 42', 'string literal', "';'", 'end of file',
  ]);
});
