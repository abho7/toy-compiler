// Source positions, compile errors, and how they are shown.
//
// Every token, AST node and IR instruction carries a Span, because a span is
// part of observable behaviour: docs/semantics.md says a trap reports where it
// happened, so a pass that moves a trapping operation to a different source
// location has changed the program. Spans therefore have to survive all the
// way from the lexer into the IR, not just into error messages.

/** A half-open range of the source, with the line and column of its start. */
export class Span {
  constructor(start, end, line, col) {
    this.start = start;
    this.end = end;
    this.line = line;
    this.col = col;
  }

  /** The span covering both, used to give a compound node its full extent. */
  static join(a, b) {
    if (!a) return b;
    if (!b) return a;
    return a.start <= b.start
      ? new Span(a.start, Math.max(a.end, b.end), a.line, a.col)
      : new Span(b.start, Math.max(a.end, b.end), b.line, b.col);
  }

  toString() { return `${this.line}:${this.col}`; }
}

export class Diagnostic {
  constructor(message, span, { label = null, notes = [] } = {}) {
    this.message = message;
    this.span = span;
    this.label = label;
    this.notes = notes;
  }
}

/**
 * Thrown when compilation cannot continue. Carries every diagnostic collected
 * so far, so a caller can show them all rather than only the fatal one.
 */
export class CompileError extends Error {
  constructor(diagnostics, source) {
    const first = diagnostics[0];
    super(first ? first.message : 'compilation failed');
    this.name = 'CompileError';
    this.diagnostics = diagnostics;
    this.source = source;
  }

  /** Every diagnostic, rendered, in source order. */
  format(file = '<input>') {
    return this.diagnostics.map((d) => render(this.source, d, file)).join('\n');
  }
}

/** The text of the 1-based line `line`, without its terminator. */
export function lineText(source, line) {
  let at = 0;
  for (let n = 1; n < line; n++) {
    const next = source.indexOf('\n', at);
    if (next < 0) return '';
    at = next + 1;
  }
  const end = source.indexOf('\n', at);
  return source.slice(at, end < 0 ? source.length : end);
}

/**
 * One diagnostic as text:
 *
 *   error: expected ';' after the declaration of 'x'
 *    --> 3:12
 *     |
 *   3 |   int x = 1
 *     |            ^ expected ';'
 *
 * The caret spans the offending tokens rather than marking a single character,
 * because "which token" is usually the whole question.
 */
export function render(source, diag, file = '<input>') {
  const span = diag.span;
  if (!span) return `error: ${diag.message}`;

  const text = lineText(source, span.line);
  const gutter = String(span.line);
  const pad = ' '.repeat(gutter.length);
  // A span may run past the end of its first line (an unterminated comment,
  // say); the caret stops at the line end so it cannot run off into nothing.
  const width = Math.max(1, Math.min(span.end - span.start, text.length - (span.col - 1)));
  const caret = `${' '.repeat(Math.max(0, span.col - 1))}${'^'.repeat(width)}`;

  const lines = [
    `error: ${diag.message}`,
    `${pad} --> ${file}:${span.line}:${span.col}`,
    `${pad} |`,
    `${gutter} | ${text}`,
    `${pad} | ${caret}${diag.label ? ` ${diag.label}` : ''}`,
  ];
  for (const note of diag.notes) lines.push(`${pad} = note: ${note}`);
  return lines.join('\n');
}

/**
 * Collects diagnostics during a phase.
 *
 * Phases report as much as they can rather than stopping at the first problem:
 * one missing semicolon should not hide five other errors. `fatal` is for the
 * cases where continuing would only produce nonsense.
 */
export class Diagnostics {
  constructor(source) {
    this.source = source;
    this.items = [];
  }

  error(message, span, options) {
    this.items.push(new Diagnostic(message, span, options));
    return this.items[this.items.length - 1];
  }

  get failed() { return this.items.length > 0; }

  /** Throw if anything was reported, with every diagnostic attached. */
  throwIfFailed() {
    if (this.items.length) throw new CompileError(this.items, this.source);
  }

  fatal(message, span, options) {
    this.error(message, span, options);
    throw new CompileError(this.items, this.source);
  }
}
