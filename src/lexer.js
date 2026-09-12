// Source text to tokens.
//
// The lexer reports problems rather than throwing on the first one, so a file
// with two bad literals produces two diagnostics. Where it cannot make sense
// of a character it skips exactly one and continues, which guarantees progress:
// a lexer that can fail without consuming input is a lexer that can hang.

import { Span, Diagnostics } from './diagnostics.js';

export const KEYWORDS = new Set([
  'int', 'void', 'if', 'else', 'while', 'for', 'break', 'continue', 'return',
]);

/** Multi-character operators, longest first: `<<` must beat `<`. */
const OPERATORS = [
  '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
  '+', '-', '*', '/', '%', '<', '>', '=', '!', '&', '|', '^', '~',
  '(', ')', '[', ']', '{', '}', ',', ';',
];

export const INT_MAX = 2147483647;
/** The magnitude of INT_MIN, which is only writable as `-2147483648`. */
export const INT_MIN_MAGNITUDE = 2147483648;

const ESCAPES = new Map([
  ['n', 10], ['t', 9], ['r', 13], ['0', 0], ['\\', 92], ["'", 39], ['"', 34],
]);

export class Token {
  constructor(kind, value, span) {
    this.kind = kind;     // 'int' | 'ident' | 'keyword' | 'string' | 'op' | 'eof'
    this.value = value;   // number | string | number[] (string literal bytes)
    this.span = span;
  }

  /** How the token is named in a message: `';'`, `identifier 'x'`, `end of file`. */
  describe() {
    switch (this.kind) {
      case 'eof': return 'end of file';
      case 'int': return `integer ${this.value}`;
      case 'ident': return `identifier '${this.value}'`;
      case 'keyword': return `keyword '${this.value}'`;
      case 'string': return 'string literal';
      default: return `'${this.value}'`;
    }
  }
}

const isDigit = (c) => c >= '0' && c <= '9';
const isHex = (c) => isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
const isIdentStart = (c) => c === '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isIdentPart = (c) => isIdentStart(c) || isDigit(c);

class Lexer {
  constructor(source, diags) {
    this.src = source;
    this.diags = diags;
    this.at = 0;
    this.line = 1;
    this.lineStart = 0;
  }

  get done() { return this.at >= this.src.length; }
  peek(k = 0) { return this.src[this.at + k] ?? ''; }

  /** Advance one character, keeping the line and column counters honest. */
  bump() {
    const c = this.src[this.at++];
    if (c === '\n') { this.line++; this.lineStart = this.at; }
    return c;
  }

  spanFrom(start, startLine, startCol) {
    return new Span(start, this.at, startLine, startCol);
  }

  here() { return { start: this.at, line: this.line, col: this.at - this.lineStart + 1 }; }

  /** Whitespace and comments. Returns nothing; only advances. */
  skipTrivia() {
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { this.bump(); continue; }
      if (c === '/' && this.peek(1) === '/') {
        while (!this.done && this.peek() !== '\n') this.bump();
        continue;
      }
      if (c === '/' && this.peek(1) === '*') {
        const open = this.here();
        this.bump(); this.bump();
        let closed = false;
        while (!this.done) {
          if (this.peek() === '*' && this.peek(1) === '/') { this.bump(); this.bump(); closed = true; break; }
          this.bump();
        }
        if (!closed) {
          this.diags.error('unterminated block comment',
            new Span(open.start, open.start + 2, open.line, open.col),
            { label: 'opened here', notes: ['block comments do not nest; add `*/`'] });
        }
        continue;
      }
      return;
    }
  }

  number(start, startLine, startCol) {
    let value = 0;
    let text = '';
    if (this.peek() === '0' && (this.peek(1) === 'x' || this.peek(1) === 'X')) {
      this.bump(); this.bump();
      if (!isHex(this.peek())) {
        while (isIdentPart(this.peek())) this.bump();
        this.diags.error('hexadecimal literal needs at least one digit after `0x`',
          this.spanFrom(start, startLine, startCol));
        return new Token('int', 0, this.spanFrom(start, startLine, startCol));
      }
      while (isHex(this.peek()) || this.peek() === '_') { const c = this.bump(); if (c !== '_') text += c; }
      value = Number.parseInt(text, 16);
    } else if (this.peek() === '0' && (this.peek(1) === 'b' || this.peek(1) === 'B')) {
      this.bump(); this.bump();
      if (this.peek() !== '0' && this.peek() !== '1') {
        while (isIdentPart(this.peek())) this.bump();
        this.diags.error('binary literal needs at least one digit after `0b`',
          this.spanFrom(start, startLine, startCol));
        return new Token('int', 0, this.spanFrom(start, startLine, startCol));
      }
      while (this.peek() === '0' || this.peek() === '1' || this.peek() === '_') {
        const c = this.bump(); if (c !== '_') text += c;
      }
      value = Number.parseInt(text, 2);
    } else {
      while (isDigit(this.peek()) || this.peek() === '_') { const c = this.bump(); if (c !== '_') text += c; }
      value = Number.parseInt(text, 10);
    }

    // `123abc` is a mistake, not an integer followed by a name.
    if (isIdentPart(this.peek())) {
      while (isIdentPart(this.peek())) this.bump();
      const span = this.spanFrom(start, startLine, startCol);
      this.diags.error(`invalid number literal '${this.src.slice(start, this.at)}'`, span);
      return new Token('int', 0, span);
    }

    const span = this.spanFrom(start, startLine, startCol);
    // INT_MIN_MAGNITUDE is let through: it is legal only directly under a
    // unary minus, which the parser folds. Anything larger cannot be written
    // at all, so it is reported here where the text is at hand.
    if (value > INT_MIN_MAGNITUDE) {
      this.diags.error(`integer literal ${text} does not fit in int`, span,
        { notes: [`int holds -${INT_MIN_MAGNITUDE} to ${INT_MAX}`] });
      return new Token('int', 0, span);
    }
    return new Token('int', value, span);
  }

  /** One escape sequence or plain character, as a byte. Returns -1 on error. */
  charBody(quote) {
    if (this.peek() === '\\') {
      const escStart = this.here();
      this.bump();
      const e = this.peek();
      if (ESCAPES.has(e)) { this.bump(); return ESCAPES.get(e); }
      this.bump();
      this.diags.error(`unknown escape sequence '\\${e}'`,
        new Span(escStart.start, this.at, escStart.line, escStart.col),
        { notes: ['known escapes: \\n \\t \\r \\0 \\\\ \\\' \\"'] });
      return -1;
    }
    const c = this.bump();
    if (c === '\n') return -1;
    // Source is text; a character outside ASCII becomes its UTF-8 bytes, which
    // only string literals can hold. A char literal takes the first byte.
    const bytes = new TextEncoder().encode(c);
    if (quote === "'" && bytes.length > 1) return -2;
    return bytes.length === 1 ? bytes[0] : Array.from(bytes);
  }

  charLiteral(start, startLine, startCol) {
    this.bump(); // opening quote
    if (this.peek() === "'") {
      this.bump();
      const span = this.spanFrom(start, startLine, startCol);
      this.diags.error('empty character literal', span, { notes: ["write '\\0' for a zero byte"] });
      return new Token('int', 0, span);
    }
    const value = this.charBody("'");
    if (this.peek() !== "'") {
      // Consume to the closing quote or end of line so one bad literal does
      // not derail everything after it.
      while (!this.done && this.peek() !== "'" && this.peek() !== '\n') this.bump();
      const closed = this.peek() === "'";
      if (closed) this.bump();
      const span = this.spanFrom(start, startLine, startCol);
      this.diags.error(closed
        ? 'character literal must hold exactly one character'
        : 'unterminated character literal', span);
      return new Token('int', 0, span);
    }
    this.bump();
    const span = this.spanFrom(start, startLine, startCol);
    if (value === -2) {
      this.diags.error('character literal must hold exactly one byte', span,
        { notes: ['characters outside ASCII take more than one byte; use a string literal'] });
      return new Token('int', 0, span);
    }
    return new Token('int', value < 0 ? 0 : value, span);
  }

  stringLiteral(start, startLine, startCol) {
    this.bump(); // opening quote
    const bytes = [];
    for (;;) {
      if (this.done || this.peek() === '\n') {
        const span = this.spanFrom(start, startLine, startCol);
        this.diags.error('unterminated string literal', span);
        return new Token('string', bytes, span);
      }
      if (this.peek() === '"') { this.bump(); break; }
      const b = this.charBody('"');
      if (Array.isArray(b)) bytes.push(...b);
      else if (b >= 0) bytes.push(b);
    }
    return new Token('string', bytes, this.spanFrom(start, startLine, startCol));
  }

  next() {
    this.skipTrivia();
    const { start, line, col } = this.here();
    if (this.done) return new Token('eof', null, new Span(start, start, line, col));

    const c = this.peek();
    if (isDigit(c)) return this.number(start, line, col);
    if (isIdentStart(c)) {
      while (isIdentPart(this.peek())) this.bump();
      const text = this.src.slice(start, this.at);
      return new Token(KEYWORDS.has(text) ? 'keyword' : 'ident', text,
        this.spanFrom(start, line, col));
    }
    if (c === "'") return this.charLiteral(start, line, col);
    if (c === '"') return this.stringLiteral(start, line, col);

    for (const op of OPERATORS) {
      if (this.src.startsWith(op, this.at)) {
        for (let i = 0; i < op.length; i++) this.bump();
        return new Token('op', op, this.spanFrom(start, line, col));
      }
    }

    this.bump(); // exactly one, so progress is guaranteed
    const span = this.spanFrom(start, line, col);
    this.diags.error(`unexpected character '${c}'`, span);
    return null; // skipped; the caller asks again
  }
}

/**
 * Tokenize `source`.
 *
 * Returns every token including a final 'eof', and the diagnostics collected.
 * Callers decide whether to continue: the parser does not, but the playground
 * shows the token stream even for input that does not lex cleanly.
 */
export function tokenize(source, diags = new Diagnostics(source)) {
  const lexer = new Lexer(source, diags);
  const tokens = [];
  for (;;) {
    const token = lexer.next();
    if (!token) continue;      // a skipped character; already reported
    tokens.push(token);
    if (token.kind === 'eof') break;
  }
  return { tokens, diags };
}
