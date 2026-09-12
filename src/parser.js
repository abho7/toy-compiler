// Tokens to an abstract syntax tree.
//
// Recursive descent, one function per grammar production in docs/language.md,
// with a table-driven loop for the binary precedence levels so that the
// precedence in the code is the precedence in the document rather than a
// separate thing that can drift from it.
//
// The parser reports as many errors as it can. After a failed expectation it
// synchronizes to the next statement boundary and carries on, so a missing
// semicolon on line 3 does not hide a genuine mistake on line 30. Every
// recovery path is required to consume at least one token: a parser that can
// report an error without consuming input is a parser that hangs, and the
// guard for that is explicit in `statement()` rather than left to reasoning
// about each error site.

import { tokenize, INT_MAX, INT_MIN_MAGNITUDE } from './lexer.js';
import { Span, Diagnostics, CompileError } from './diagnostics.js';
import { walk } from './ast.js';

/** Binary precedence, loosest first. Mirrors the grammar in docs/language.md. */
const LEVELS = [
  ['||'], ['&&'], ['|'], ['^'], ['&'],
  ['==', '!='], ['<', '<=', '>', '>='], ['<<', '>>'],
  ['+', '-'], ['*', '/', '%'],
];

/** Tokens that can begin a statement, used to resynchronize after an error. */
const STATEMENT_STARTS = new Set(['int', 'if', 'while', 'for', 'break', 'continue', 'return']);

class Parser {
  constructor(tokens, diags) {
    this.tokens = tokens;
    this.diags = diags;
    this.i = 0;
  }

  peek(k = 0) { return this.tokens[Math.min(this.i + k, this.tokens.length - 1)]; }
  previous() { return this.tokens[Math.max(0, this.i - 1)]; }
  get atEnd() { return this.peek().kind === 'eof'; }

  advance() { return this.tokens[this.i++] ?? this.tokens[this.tokens.length - 1]; }

  /** Is the current token exactly this operator or keyword? */
  at(kind, value) {
    const t = this.peek();
    return t.kind === kind && (value === undefined || t.value === value);
  }

  match(kind, value) {
    if (!this.at(kind, value)) return null;
    return this.advance();
  }

  /**
   * Require a token. On failure the diagnostic names what was wanted and what
   * was there, and nothing is consumed -- the caller decides whether to
   * synchronize, so recovery stays a decision of the production rather than of
   * this helper.
   */
  expect(kind, value, what) {
    if (this.at(kind, value)) return this.advance();
    const t = this.peek();
    const wanted = value === undefined ? kind : `'${value}'`;
    this.diags.error(`${what}, found ${t.describe()}`, t.span, { label: `expected ${wanted}` });
    return null;
  }

  spanFrom(startToken) { return Span.join(startToken.span, this.previous().span); }

  /**
   * Skip to just past the next `;`, stopping at a closing brace.
   *
   * Used where a declaration has already gone wrong: without it the tokens
   * left behind get re-parsed as a statement and produce a second, misleading
   * message -- `int if = 1;` reported both the bad name and a missing `(`
   * after `if`.
   */
  skipPastSemicolon() {
    while (!this.atEnd && !this.at('op', '}')) {
      if (this.advance().value === ';') return;
    }
  }

  /** Skip to somewhere a new statement could plausibly start. */
  synchronize() {
    while (!this.atEnd) {
      if (this.previous().kind === 'op' && this.previous().value === ';') return;
      const t = this.peek();
      if (t.kind === 'keyword' && STATEMENT_STARTS.has(t.value)) return;
      if (t.kind === 'op' && (t.value === '}' || t.value === '{')) return;
      this.advance();
    }
  }

  // ------------------------------------------------------------- program --

  program() {
    const functions = [];
    while (!this.atEnd) {
      const fn = this.functionDecl();
      if (fn) functions.push(fn);
      else if (!this.atEnd) this.skipToNextFunction();
    }
    const span = functions.length
      ? Span.join(functions[0].span, functions[functions.length - 1].span)
      : new Span(0, 0, 1, 1);
    return { kind: 'Program', functions, span };
  }

  skipToNextFunction() {
    const before = this.i;
    while (!this.atEnd) {
      const t = this.peek();
      if (t.kind === 'keyword' && (t.value === 'int' || t.value === 'void')
          && this.peek(1).kind === 'ident' && this.peek(2).kind === 'op' && this.peek(2).value === '(') {
        break;
      }
      this.advance();
    }
    if (this.i === before && !this.atEnd) this.advance(); // always progress
  }

  functionDecl() {
    const start = this.peek();
    let returnType = null;
    if (this.at('keyword', 'int')) { this.advance(); returnType = 'int'; }
    else if (this.at('keyword', 'void')) { this.advance(); returnType = 'void'; }
    else {
      this.diags.error(
        `expected 'int' or 'void' to begin a function declaration, found ${start.describe()}`,
        start.span, { label: "expected 'int' or 'void'" });
      return null;
    }

    const name = this.expect('ident', undefined, 'expected a function name');
    if (!name) return null;
    if (!this.expect('op', '(', `expected '(' after the function name '${name.value}'`)) return null;

    const params = this.params();
    const body = this.at('op', '{')
      ? this.block()
      : (this.expect('op', '{', `expected '{' to begin the body of '${name.value}'`), null);
    if (!body) return null;

    return {
      kind: 'FunctionDecl', name: name.value, returnType, params, body,
      span: this.spanFrom(start),
    };
  }

  params() {
    const params = [];
    if (this.match('op', ')')) return params;
    for (;;) {
      const start = this.peek();
      if (!this.expect('keyword', 'int', 'expected a parameter type')) break;
      let type = 'int';
      if (this.match('op', '[')) {
        if (!this.expect('op', ']', "expected ']' in an array parameter type")) break;
        type = 'int[]';
      }
      const name = this.expect('ident', undefined, 'expected a parameter name');
      if (!name) break;
      params.push({ name: name.value, type, span: this.spanFrom(start) });
      if (this.match('op', ',')) continue;
      if (this.expect('op', ')', "expected ',' or ')' in the parameter list")) return params;
      break;   // fall into the recovery below, so one mistake is one message
    }
    // Recovery: run to the closing parenthesis so the body can still parse.
    while (!this.atEnd && !this.at('op', ')') && !this.at('op', '{')) this.advance();
    this.match('op', ')');
    return params;
  }

  // ---------------------------------------------------------- statements --

  block() {
    const start = this.expect('op', '{', "expected '{'");
    const stmts = [];
    while (!this.atEnd && !this.at('op', '}')) {
      const stmt = this.statement();
      if (stmt) stmts.push(stmt);
    }
    this.expect('op', '}', "expected '}' to close this block");
    return { kind: 'Block', stmts, span: this.spanFrom(start ?? this.previous()) };
  }

  statement() {
    const before = this.i;
    const stmt = this.statementInner();
    // The guarantee that makes recovery safe: a statement that reports an
    // error without consuming anything would leave the enclosing loop exactly
    // where it started.
    if (this.i === before && !this.atEnd) this.advance();
    return stmt;
  }

  statementInner() {
    const start = this.peek();

    if (this.at('op', '{')) return this.block();
    if (this.at('op', ';')) { this.advance(); return { kind: 'Empty', span: start.span }; }
    if (this.at('keyword', 'int')) return this.declaration(true);

    if (this.match('keyword', 'if')) {
      if (!this.expect('op', '(', "expected '(' after 'if'")) { this.synchronize(); return null; }
      const cond = this.expression();
      this.expect('op', ')', "expected ')' after the condition");
      const then = this.statement();
      // `else` binds to the nearest unmatched `if`, which falls out of parsing
      // it here rather than returning to an outer level first.
      const otherwise = this.match('keyword', 'else') ? this.statement() : null;
      return { kind: 'If', cond, then, otherwise, span: this.spanFrom(start) };
    }

    if (this.match('keyword', 'while')) {
      if (!this.expect('op', '(', "expected '(' after 'while'")) { this.synchronize(); return null; }
      const cond = this.expression();
      this.expect('op', ')', "expected ')' after the condition");
      const body = this.statement();
      return { kind: 'While', cond, body, span: this.spanFrom(start) };
    }

    if (this.match('keyword', 'for')) {
      if (!this.expect('op', '(', "expected '(' after 'for'")) { this.synchronize(); return null; }
      let init = null;
      if (this.at('keyword', 'int')) init = this.declaration(false);
      else if (!this.at('op', ';')) init = { kind: 'ExprStmt', expr: this.expression(), span: this.peek().span };
      this.expect('op', ';', "expected ';' after the initializer of 'for'");
      const cond = this.at('op', ';') ? null : this.expression();
      this.expect('op', ';', "expected ';' after the condition of 'for'");
      const step = this.at('op', ')') ? null : this.expression();
      this.expect('op', ')', "expected ')' after the clauses of 'for'");
      const body = this.statement();
      return { kind: 'For', init, cond, step, body, span: this.spanFrom(start) };
    }

    if (this.match('keyword', 'break')) {
      this.expect('op', ';', "expected ';' after 'break'");
      return { kind: 'Break', span: this.spanFrom(start) };
    }
    if (this.match('keyword', 'continue')) {
      this.expect('op', ';', "expected ';' after 'continue'");
      return { kind: 'Continue', span: this.spanFrom(start) };
    }
    if (this.match('keyword', 'return')) {
      const value = this.at('op', ';') ? null : this.expression();
      if (!this.expect('op', ';', "expected ';' after 'return'")) this.synchronize();
      return { kind: 'Return', value, span: this.spanFrom(start) };
    }

    const expr = this.expression();
    if (!this.expect('op', ';', "expected ';' after the expression")) this.synchronize();
    return { kind: 'ExprStmt', expr, span: this.spanFrom(start) };
  }

  /** `int x;`, `int x = e;`, `int a[n];`, `int a[n] = {...};`, `int s[] = "..";` */
  declaration(consumeSemi) {
    const start = this.advance(); // 'int'
    const name = this.expect('ident', undefined, 'expected a name after `int`');
    if (!name) { this.skipPastSemicolon(); return null; }

    let node;
    if (this.match('op', '[')) {
      let size = null;
      if (!this.at('op', ']')) size = this.expression();
      if (!this.expect('op', ']', "expected ']' after the array length")) {
        // Get back to the `]` or the end of the declaration, rather than
        // letting what follows be re-parsed as statements.
        while (!this.atEnd && !this.at('op', ']') && !this.at('op', ';')) this.advance();
        this.match('op', ']');
      }
      let init = null;
      let fromString = false;
      if (this.match('op', '=')) ({ init, fromString } = this.arrayInitializer());
      if (!size && !init) {
        this.diags.error(`array '${name.value}' needs either a length or an initializer`,
          this.spanFrom(start), { label: 'no length' });
      }
      node = { kind: 'ArrayDecl', name: name.value, size, init, fromString, span: null };
    } else {
      const init = this.match('op', '=') ? this.expression() : null;
      node = { kind: 'VarDecl', name: name.value, init, span: null };
    }

    if (consumeSemi && !this.expect('op', ';', `expected ';' after the declaration of '${name.value}'`)) {
      this.synchronize();
    }
    node.span = this.spanFrom(start);
    return node;
  }

  arrayInitializer() {
    const str = this.match('string');
    if (str) {
      // A string initializer is its bytes followed by a terminating zero, so
      // the array a program sees is exactly what docs/language.md describes.
      const init = [...str.value, 0].map((b) => ({ kind: 'IntLit', value: b, span: str.span }));
      return { init, fromString: true };
    }
    if (!this.expect('op', '{', 'expected an initializer: `{ ... }` or a string')) {
      // Skip the malformed initializer so the declaration's `;` still lands:
      // `int a[2] = 1, 2;` is one mistake and should read as one.
      while (!this.atEnd && !this.at('op', ';') && !this.at('op', '}')) this.advance();
      return { init: [], fromString: false };
    }
    const init = [];
    if (!this.at('op', '}')) {
      do {
        if (this.at('op', '}')) break;   // tolerate a trailing comma
        init.push(this.expression());
      } while (this.match('op', ','));
    }
    this.expect('op', '}', "expected '}' after the initializer");
    return { init, fromString: false };
  }

  // --------------------------------------------------------- expressions --

  expression() { return this.assignment(); }

  assignment() {
    const left = this.binary(0);
    const eq = this.match('op', '=');
    if (!eq) return left;

    const value = this.assignment();   // right-associative
    if (left && (left.kind === 'Name' || left.kind === 'Index')) {
      return { kind: 'Assign', target: left, value, span: Span.join(left.span, value?.span) };
    }
    this.diags.error('this expression cannot be assigned to', left?.span ?? eq.span,
      { label: 'not a variable or array element',
        notes: ['only a variable `x = e` or an array element `a[i] = e` can be assigned to'] });
    return left;
  }

  binary(level) {
    if (level >= LEVELS.length) return this.unary();
    const ops = LEVELS[level];
    let left = this.binary(level + 1);
    for (;;) {
      const t = this.peek();
      if (t.kind !== 'op' || !ops.includes(t.value)) return left;
      this.advance();
      const right = this.binary(level + 1);
      const kind = (t.value === '&&' || t.value === '||') ? 'Logical' : 'Binary';
      left = { kind, op: t.value, left, right, span: Span.join(left?.span ?? t.span, right?.span ?? t.span) };
    }
  }

  unary() {
    const t = this.peek();
    if (t.kind === 'op' && (t.value === '-' || t.value === '!' || t.value === '~')) {
      this.advance();
      const operand = this.unary();
      // `-2147483648` is the only way to write INT_MIN: the literal alone is
      // one past INT_MAX, so the minus is folded here rather than leaving a
      // literal that the range check below would reject.
      if (t.value === '-' && operand?.kind === 'IntLit') {
        return { kind: 'IntLit', value: -operand.value, span: Span.join(t.span, operand.span) };
      }
      return { kind: 'Unary', op: t.value, operand, span: Span.join(t.span, operand?.span ?? t.span) };
    }
    return this.postfix();
  }

  postfix() {
    let node = this.primary();
    for (;;) {
      if (!this.match('op', '[')) return node;
      const index = this.expression();
      const close = this.expect('op', ']', "expected ']' after the array index");
      node = {
        kind: 'Index', array: node, index,
        span: Span.join(node?.span ?? index?.span, (close ?? this.previous()).span),
      };
    }
  }

  primary() {
    const t = this.peek();

    if (t.kind === 'int') { this.advance(); return { kind: 'IntLit', value: t.value, span: t.span }; }

    if (t.kind === 'ident') {
      this.advance();
      if (!this.match('op', '(')) return { kind: 'Name', name: t.value, span: t.span };
      const args = [];
      if (!this.at('op', ')')) {
        do { args.push(this.expression()); } while (this.match('op', ','));
      }
      this.expect('op', ')', "expected ',' or ')' in the argument list");
      return { kind: 'Call', callee: t.value, args, span: this.spanFrom(t) };
    }

    if (t.kind === 'op' && t.value === '(') {
      this.advance();
      const inner = this.expression();
      this.expect('op', ')', "expected ')' after the expression");
      return inner;
    }

    if (t.kind === 'string') {
      this.advance();
      this.diags.error('a string literal can only initialize an array', t.span,
        { label: 'not allowed here', notes: ['write `int s[] = "..."` and index into it'] });
      return { kind: 'IntLit', value: 0, span: t.span };
    }

    this.diags.error(`expected an expression, found ${t.describe()}`, t.span,
      { label: 'expected an expression' });
    return null;
  }
}

/**
 * Every literal must fit in an int.
 *
 * Run after parsing because `2147483648` is legal exactly when a unary minus
 * folds it into INT_MIN, and that is only known once the minus has been
 * applied. Anything still above INT_MAX here was written without one.
 */
function checkLiteralRanges(program, diags) {
  walk(program, (node) => {
    if (node?.kind === 'IntLit' && node.value > INT_MAX) {
      diags.error(`integer literal ${node.value} does not fit in int`, node.span, {
        label: 'too large',
        notes: [`int holds -${INT_MIN_MAGNITUDE} to ${INT_MAX}; write -${INT_MIN_MAGNITUDE} for the smallest`],
      });
    }
  });
}

/** Parse `source`, collecting diagnostics rather than stopping at the first. */
export function parse(source) {
  const { tokens, diags } = tokenize(source);
  const parser = new Parser(tokens, diags);
  const program = parser.program();
  checkLiteralRanges(program, diags);
  return { program, diags };
}

/** Parse, or throw a CompileError carrying every diagnostic. */
export function parseOrThrow(source) {
  const { program, diags } = parse(source);
  diags.throwIfFailed();
  return program;
}

export { CompileError };
