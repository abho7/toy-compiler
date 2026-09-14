// Random minic programs, well-typed by construction.
//
// The differential harness can only compare programs that compile, so this
// never generates one that does not: scopes and types are tracked while
// building, and every expression is assembled from things already in scope with
// the type the position requires. A generator that produced compile errors
// would spend the campaign testing the parser's error recovery instead of the
// optimizer.
//
// Three properties are structural rather than checked afterwards:
//
//   Termination. Loops are counting loops with a constant bound *whose counter
//   the body cannot modify*, and calls form a DAG -- a function may only call
//   one defined before it. Both halves are load-bearing. The first version
//   guaranteed only the constant bound, and the generator happily emitted
//   `i = (1 >> i)` inside the loop, which pins the counter below the bound
//   forever: 16% of programs ran until the step budget stopped them, producing
//   no comparable observation at all. Loop counters are now readable but never
//   assignable.
//
//   The cost of the DAG rule is that recursion is never generated, which means
//   stack_overflow and deep call chains are exercised only by the hand-written
//   corpus. That is a real gap, and it is stated here rather than discovered
//   later.
//
//   Bounded expression depth. docs/semantics.md's reference interpreter walks
//   the tree recursively, and a deeply nested expression exhausts the host
//   stack before the language's own limits apply. That failure looks exactly
//   like a mismatch and is not one, so depth is capped.
//
//   Observable output. Every function body and every loop body is guaranteed to
//   contain at least one print or putchar -- a loop because its bound is at
//   least 2 so the body always runs, a function because a body that happened to
//   contain no loop had no reason to print at all. Two programs that both
//   produce nothing agree trivially, and a campaign of those proves nothing. An
//   `if` branch does not count toward the guarantee, since it may not be taken.
//
// One more gap, stated here rather than discovered later: an array parameter's
// length is unknown to the callee, because any caller may pass any array, so a
// parameter is only ever indexed at 0 -- in range for every array the language
// can build. Interesting indices are exercised on local arrays only.
//
// The measured mix, over 3000 programs in two disjoint seed bands (1..1500 and
// 5001..6500): every program compiles, none exhausts the step budget, about 75%
// exit cleanly, 15% trap on division by zero and 10% out of bounds, and every
// one agrees byte for byte with the fully optimizing pipeline. Trapping is kept
// a minority outcome on purpose: a trap ends the program, so a generator that
// traps too eagerly tests the trap and nothing after it.
//
// Everything is driven by a seeded PRNG, so a failing program is reproducible
// from its seed alone.

/** mulberry32: small, fast, and identical on every host. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ARITH = ['+', '-', '*', '&', '|', '^', '<<', '>>'];
const COMPARE = ['==', '!=', '<', '<=', '>', '>='];
const DIVIDE = ['/', '%'];

/**
 * Does this statement list definitely produce output?
 *
 * A `for` counts because its bound is at least 2, so the body always runs. An
 * `if` deliberately does not: the branch may not be taken, and a guarantee that
 * holds only sometimes is not one. Being wrong in this direction costs an extra
 * print in a program that would have printed anyway.
 */
function emitsOutput(stmts) {
  return stmts.some((s) => {
    if (s.kind === 'print' || s.kind === 'putchar' || s.kind === 'printCall') return true;
    return s.kind === 'for' && emitsOutput(s.body);
  });
}

class Generator {
  constructor(seed, options) {
    this.random = rng(seed);
    this.maxDepth = options.maxDepth ?? 3;
    this.maxStmts = options.maxStmts ?? 6;
    // Depth 3 rather than 2: with counters no longer mutable the programs got
    // cheap (mean 206 steps) but also quiet (15 output bytes), and output is
    // the main thing the differential compares. Deeper nesting and larger
    // bounds put the work back without reintroducing unbounded loops.
    this.maxBlockDepth = options.maxBlockDepth ?? 3;
    // Separate, because they behave very differently. A bad divisor is one
    // value out of billions, so an arbitrary expression almost never traps and
    // the chance can be generous. A bad index is almost *any* value for a
    // six-element array, so the same chance made a third of all programs abort
    // on an out-of-bounds store before reaching their interesting code.
    this.divTrapChance = options.divTrapChance ?? 0.12;
    this.indexTrapChance = options.indexTrapChance ?? 0.06;
    this.funcs = [];
    this.nextName = 0;
  }

  int(n) { return Math.floor(this.random() * n); }
  pick(list) { return list[this.int(list.length)]; }
  chance(p) { return this.random() < p; }
  name(prefix) { return `${prefix}${this.nextName++}`; }

  /** Choose from [value, weight] pairs, so the mix is tunable in one place. */
  pickWeighted(pairs) {
    const total = pairs.reduce((sum, [, weight]) => sum + weight, 0);
    let point = this.random() * total;
    for (const [value, weight] of pairs) {
      point -= weight;
      if (point < 0) return value;
    }
    return pairs[pairs.length - 1][0];
  }

  /** A nested scope. Loop counters stay readable but become unassignable. */
  child(scope, { ints = [], freeze = [] } = {}) {
    return {
      ints: [...scope.ints, ...ints],
      arrays: [...scope.arrays],
      frozen: new Set([...scope.frozen, ...freeze]),
    };
  }

  // ------------------------------------------------------------ expressions --

  /** An int-valued expression, at most `depth` levels deep. */
  expr(scope, depth) {
    if (depth <= 0 || this.chance(0.35)) return this.atom(scope);

    const choice = this.int(10);
    if (choice < 4) {
      return { kind: 'bin', op: this.pick(ARITH), left: this.expr(scope, depth - 1), right: this.expr(scope, depth - 1) };
    }
    if (choice < 6) {
      return { kind: 'bin', op: this.pick(COMPARE), left: this.expr(scope, depth - 1), right: this.expr(scope, depth - 1) };
    }
    if (choice < 7) {
      return { kind: 'un', op: this.pick(['-', '!', '~']), operand: this.expr(scope, depth - 1) };
    }
    if (choice < 8) {
      // Short-circuiting: the right side may never run, which is exactly the
      // kind of thing an optimizer gets wrong.
      return { kind: 'logical', op: this.pick(['&&', '||']), left: this.expr(scope, depth - 1), right: this.expr(scope, depth - 1) };
    }
    if (choice < 9) return this.divide(scope, depth);
    return this.load(scope, depth);
  }

  /**
   * A division, sometimes guarded and sometimes not.
   *
   * An unguarded one can trap, which is the point: a trap is observable, and
   * whether the optimizer preserves it is the question. A guarded one exercises
   * the case where the guard is what makes the division safe.
   */
  divide(scope, depth) {
    const op = this.pick(DIVIDE);
    const left = this.expr(scope, depth - 1);
    if (this.chance(this.divTrapChance)) {
      return { kind: 'bin', op, left, right: this.expr(scope, depth - 1) };
    }
    // (e % 7) + 1 is never zero, so this one cannot trap.
    const safe = {
      kind: 'bin',
      op: '+',
      left: { kind: 'bin', op: '%', left: this.expr(scope, depth - 1), right: { kind: 'lit', value: 7 } },
      right: { kind: 'lit', value: 1 },
    };
    return { kind: 'bin', op, left, right: safe };
  }

  /**
   * An index that is genuinely in range: ((e % L) + L) % L.
   *
   * The earlier version was `(-(-e)) % L`, which bounds the magnitude but
   * keeps the sign, so half of its "safe" indices were negative and trapped.
   * Modulo by a positive literal never traps, so this whole form is total.
   */
  safeIndex(scope, length, depth) {
    const wrapped = {
      kind: 'bin',
      op: '%',
      left: this.expr(scope, Math.max(0, depth)),
      right: { kind: 'lit', value: length },
    };
    return {
      kind: 'bin',
      op: '%',
      left: { kind: 'bin', op: '+', left: wrapped, right: { kind: 'lit', value: length } },
      right: { kind: 'lit', value: length },
    };
  }

  /** An index at or just past an edge, where a bounds check is right or wrong. */
  boundaryIndex(length) {
    return this.pickWeighted([
      [{ kind: 'lit', value: length }, 3],            // one past the end
      [{ kind: 'lit', value: -1 }, 2],                // one before the start
      [{ kind: 'lit', value: length - 1 }, 3],        // the last element: legal
      [{ kind: 'lit', value: length + 1 + this.int(3) }, 1],
    ]);
  }

  /** An array read, mostly in range and occasionally on an edge. */
  load(scope, depth) {
    if (scope.arrays.length === 0) return this.atom(scope);
    const array = this.pick(scope.arrays);
    const index = this.chance(this.indexTrapChance)
      ? this.boundaryIndex(array.length)
      : this.safeIndex(scope, array.length, depth - 1);
    return { kind: 'index', array: array.name, index };
  }

  atom(scope) {
    const options = [];
    if (scope.ints.length) options.push('var');
    options.push('lit', 'lit');
    if (scope.arrays.length) options.push('index');
    const choice = this.pick(options);
    if (choice === 'var') return { kind: 'var', name: this.pick(scope.ints) };
    if (choice === 'index') {
      const array = this.pick(scope.arrays);
      return {
        kind: 'index',
        array: array.name,
        index: { kind: 'lit', value: this.int(array.length) },
      };
    }
    // A spread that includes the values where int arithmetic goes wrong.
    const pool = [0, 1, 2, 3, 7, -1, -2, 255, 65536, 2147483647, -2147483648];
    return { kind: 'lit', value: this.chance(0.25) ? this.pick(pool) : this.int(50) - 10 };
  }

  // ------------------------------------------------------------- statements --

  block(scope, depth, count) {
    const stmts = [];
    for (let i = 0; i < count; i++) {
      const stmt = this.statement(scope, depth);
      if (stmt) stmts.push(stmt);
    }
    return stmts;
  }

  statement(scope, depth) {
    // Weighted rather than threshold-based so the mix is visible and tunable.
    // Stores are weighted heavily: writing through an array is what the
    // aliasing rules in CSE and dead code elimination turn on, and it was the
    // thinnest coverage in the first version at 34% of programs.
    const nested = depth < this.maxBlockDepth;
    const kind = this.pickWeighted([
      ['declInt', 2],
      ['declArray', scope.arrays.length < 3 ? 2 : 0],
      ['assign', 2],
      ['store', scope.arrays.length ? 4 : 0],
      ['if', nested ? 2 : 0],
      ['for', nested ? 2 : 0],
      ['call', this.funcs.length ? 2 : 0],
      ['print', 2],
    ]);

    switch (kind) {
      case 'declInt': {
        const name = this.name('v');
        const stmt = { kind: 'declInt', name, init: this.expr(scope, this.maxDepth) };
        scope.ints.push(name);
        return stmt;
      }

      case 'declArray': {
        const name = this.name('a');
        const length = 1 + this.int(6);
        const init = [];
        for (let i = 0; i < this.int(length + 1); i++) init.push(this.expr(scope, 1));
        scope.arrays.push({ name, length });
        return { kind: 'declArray', name, length, init };
      }

      case 'assign': {
        // Never a loop counter: assigning to one can pin it below its bound
        // and the loop never finishes.
        const assignable = scope.ints.filter((name) => !scope.frozen.has(name));
        if (!assignable.length) return this.printStmt(scope);
        return { kind: 'assign', name: this.pick(assignable), value: this.expr(scope, this.maxDepth) };
      }

      case 'store': {
        const array = this.pick(scope.arrays);
        return {
          kind: 'store',
          array: array.name,
          index: this.chance(this.indexTrapChance)
            ? this.boundaryIndex(array.length)
            : this.safeIndex(scope, array.length, 1),
          value: this.expr(scope, 2),
        };
      }

      case 'if': {
        const otherwise = this.chance(0.5)
          ? this.block(this.child(scope), depth + 1, 1 + this.int(2))
          : null;
        return {
          kind: 'if',
          cond: this.expr(scope, this.maxDepth),
          then: this.block(this.child(scope), depth + 1, 1 + this.int(3)),
          otherwise,
        };
      }

      case 'for': {
        const varName = this.name('i');
        const inner = this.child(scope, { ints: [varName], freeze: [varName] });
        const body = this.block(inner, depth + 1, 1 + this.int(3));
        // Every loop emits something. Deeper nesting multiplied the work but
        // not the output, because a body of one to three statements usually
        // contained no print -- and output bytes are the main thing the
        // differential harness compares. Steps without output prove little.
        if (!emitsOutput(body)) body.push(this.printStmt(inner));
        return { kind: 'for', varName, bound: 2 + this.int(7), body };
      }

      case 'call': {
        // Prefer a callee that takes an array whenever one is in scope. A
        // callee writing through the caller's array is exactly what CSE's
        // memory rules must be conservative about, and it was the thinnest
        // coverage the generator had: 13% of programs.
        const callable = this.funcs.filter(
          (f) => scope.arrays.length > 0 || f.params.every((p) => p.type !== 'int[]'));
        if (!callable.length) return this.printStmt(scope);
        const takesArray = callable.filter((f) => f.params.some((p) => p.type === 'int[]'));
        const callee = (takesArray.length && scope.arrays.length && this.chance(0.7))
          ? this.pick(takesArray)
          : this.pick(callable);
        const args = this.callArgs(callee, scope);
        if (!args) return this.printStmt(scope);
        return callee.returnType === 'void'
          ? { kind: 'callStmt', name: callee.name, args }
          : { kind: 'printCall', name: callee.name, args };
      }

      default:
        return this.printStmt(scope);
    }
  }

  printStmt(scope) {
    if (this.chance(0.25)) {
      return { kind: 'putchar', value: this.expr(scope, 2) };
    }
    return { kind: 'print', value: this.expr(scope, this.maxDepth) };
  }

  /** Arguments matching a callee's parameter types, or null if impossible. */
  callArgs(callee, scope) {
    const args = [];
    for (const param of callee.params) {
      if (param.type === 'int[]') {
        if (!scope.arrays.length) return null;
        args.push({ kind: 'arrayRef', name: this.pick(scope.arrays).name });
      } else {
        args.push(this.expr(scope, 2));
      }
    }
    return args;
  }

  // -------------------------------------------------------------- functions --

  func(isMain) {
    const name = isMain ? 'main' : this.name('f');
    const params = [];
    if (!isMain) {
      for (let i = 0; i < 1 + this.int(3); i++) {
        // Array parameters are the only way a callee writes through memory the
        // caller can see, which is the case CSE has to be conservative about.
        // They were 15% of programs; this raises that materially.
        params.push({ name: this.name('p'), type: this.chance(0.4) ? 'int[]' : 'int' });
      }
    }
    const returnType = isMain ? 'int' : (this.chance(0.3) ? 'void' : 'int');

    const scope = { ints: [], arrays: [], frozen: new Set() };
    for (const param of params) {
      if (param.type === 'int[]') scope.arrays.push({ name: param.name, length: 1 });
      else scope.ints.push(param.name);
    }

    // Seed an array early in most functions, so a call taking int[] has
    // something to pass and a store has something to write through, rather
    // than depending on one happening to be declared before it is needed.
    const body = [];
    if (this.chance(0.6)) {
      const name = this.name('a');
      const length = 1 + this.int(6);
      scope.arrays.push({ name, length });
      body.push({ kind: 'declArray', name, length, init: [] });
    }
    body.push(...this.block(scope, 0, 2 + this.int(this.maxStmts)));
    // Every function emits, not just every loop. Half of all programs were
    // still ending on a single-digit byte count, because a body that happened
    // to contain no loop had no reason to print at all.
    if (!emitsOutput(body)) body.push(this.printStmt(scope));
    // Every non-void function ends in a return, so no path can fall off the
    // end -- which sema rejects, and which would make the program uncompilable.
    if (returnType !== 'void') body.push({ kind: 'return', value: this.expr(scope, 2) });

    return { name, params, returnType, body };
  }

  generate(functionCount) {
    for (let i = 0; i < functionCount - 1; i++) this.funcs.push(this.func(false));
    this.funcs.push(this.func(true));
    return { funcs: this.funcs };
  }
}

/** Build a random program model from a seed. */
export function generateProgram(seed, options = {}) {
  const generator = new Generator(seed, options);
  return generator.generate(1 + (options.functions ?? Math.floor(rng(seed ^ 0x9e3779b9)() * 3)));
}

// ---------------------------------------------------------------- printing --

function printExpr(expr) {
  switch (expr.kind) {
    case 'lit':
      // INT_MIN has no literal form; it is written as a negation, which the
      // parser folds back.
      return String(expr.value);
    case 'var': return expr.name;
    case 'arrayRef': return expr.name;
    case 'index': return `${expr.array}[${printExpr(expr.index)}]`;
    case 'bin': return `(${printExpr(expr.left)} ${expr.op} ${printExpr(expr.right)})`;
    case 'logical': return `(${printExpr(expr.left)} ${expr.op} ${printExpr(expr.right)})`;
    case 'un': return `(${expr.op}${printExpr(expr.operand)})`;
    case 'call': return `${expr.name}(${expr.args.map(printExpr).join(', ')})`;
    default: throw new Error(`printExpr: unknown ${expr.kind}`);
  }
}

function printStmt(stmt, indent) {
  const pad = '  '.repeat(indent);
  switch (stmt.kind) {
    case 'declInt': return `${pad}int ${stmt.name} = ${printExpr(stmt.init)};`;
    case 'declArray': {
      const init = stmt.init.length ? ` = {${stmt.init.map(printExpr).join(', ')}}` : '';
      return `${pad}int ${stmt.name}[${stmt.length}]${init};`;
    }
    case 'assign': return `${pad}${stmt.name} = ${printExpr(stmt.value)};`;
    case 'store': return `${pad}${stmt.array}[${printExpr(stmt.index)}] = ${printExpr(stmt.value)};`;
    case 'print': return `${pad}print(${printExpr(stmt.value)});`;
    case 'putchar': return `${pad}putchar(${printExpr(stmt.value)});`;
    case 'callStmt': return `${pad}${stmt.name}(${stmt.args.map(printExpr).join(', ')});`;
    case 'printCall': return `${pad}print(${stmt.name}(${stmt.args.map(printExpr).join(', ')}));`;
    case 'return': return `${pad}return ${printExpr(stmt.value)};`;
    case 'if': {
      const lines = [`${pad}if (${printExpr(stmt.cond)}) {`];
      for (const s of stmt.then) lines.push(printStmt(s, indent + 1));
      if (stmt.otherwise) {
        lines.push(`${pad}} else {`);
        for (const s of stmt.otherwise) lines.push(printStmt(s, indent + 1));
      }
      lines.push(`${pad}}`);
      return lines.join('\n');
    }
    case 'for': {
      const lines = [`${pad}for (int ${stmt.varName} = 0; ${stmt.varName} < ${stmt.bound}; ${stmt.varName} = ${stmt.varName} + 1) {`];
      for (const s of stmt.body) lines.push(printStmt(s, indent + 1));
      lines.push(`${pad}}`);
      return lines.join('\n');
    }
    default: throw new Error(`printStmt: unknown ${stmt.kind}`);
  }
}

/** Render a program model as minic source. */
export function printProgram(model) {
  const parts = [];
  for (const func of model.funcs) {
    const params = func.params
      .map((p) => (p.type === 'int[]' ? `int[] ${p.name}` : `int ${p.name}`))
      .join(', ');
    const lines = [`${func.returnType} ${func.name}(${params}) {`];
    for (const stmt of func.body) lines.push(printStmt(stmt, 1));
    lines.push('}');
    parts.push(lines.join('\n'));
  }
  return `${parts.join('\n\n')}\n`;
}

/** A program from a seed, as source text. */
export function randomSource(seed, options = {}) {
  return printProgram(generateProgram(seed, options));
}
