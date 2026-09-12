// Scope resolution and type checking.
//
// This is the last phase before anything executes, and it is what lets every
// later phase assume its input makes sense: names are resolved to symbols,
// every expression has a type, calls match their signatures, arrays have
// known lengths, and every non-void function returns on every path. The IR
// builder and the interpreters are written against those guarantees rather
// than re-checking them.
//
// Annotations left on the tree, in place:
//
//   every expression       .type      'int' | 'int[]' | 'void'
//   Name, Index target     .symbol    the declaration it refers to
//   Call                   .sig       the signature it calls
//   ArrayDecl              .length    the constant length, or null if unknown
//   FunctionDecl           .sig       its own signature
//   FunctionDecl           .locals    every local and parameter, in order
//
// Errors are collected rather than thrown, and an expression whose type could
// not be determined gets the internal type 'error', which is compatible with
// everything. One mistake should produce one message, not a cascade from every
// operator that touches the result.

import { parse } from './parser.js';
import { evalBinop, evalUnop, isTrap } from './values.js';

/** Declared for every program. They are the only observable output. */
export const BUILTINS = new Map([
  ['print', {
    name: 'print', returnType: 'void', builtin: true, span: null,
    params: [{ name: 'value', type: 'int' }],
  }],
  ['putchar', {
    name: 'putchar', returnType: 'void', builtin: true, span: null,
    params: [{ name: 'byte', type: 'int' }],
  }],
]);

const ERROR = 'error';

/** How an expression is named in a message. */
function describe(node) {
  if (!node) return 'this';
  if (node.kind === 'Name') return `'${node.name}'`;
  if (node.kind === 'Call') return `'${node.callee}(...)'`;
  return 'this';
}

class Scope {
  constructor(parent) {
    this.parent = parent;
    this.names = new Map();
  }

  /** Declare, or return the existing symbol of that name in *this* scope. */
  declare(symbol) {
    const clash = this.names.get(symbol.name);
    if (clash) return clash;
    this.names.set(symbol.name, symbol);
    return null;
  }

  lookup(name) {
    for (let s = this; s; s = s.parent) {
      const hit = s.names.get(name);
      if (hit) return hit;
    }
    return null;
  }
}

/**
 * Evaluate an expression at compile time.
 *
 * Used for array lengths and for deciding whether a loop condition is
 * constantly true. It calls the same evalBinop the interpreters do, so a
 * constant length and a runtime computation of the same expression cannot
 * disagree. A trapping expression is not constant: `int a[4/0]` has no length.
 */
export function constEval(node) {
  if (!node) return { ok: false };
  switch (node.kind) {
    case 'IntLit':
      return { ok: true, value: node.value };
    case 'Unary': {
      const a = constEval(node.operand);
      if (!a.ok) return a;
      return { ok: true, value: evalUnop(node.op, a.value).value };
    }
    case 'Binary': {
      const a = constEval(node.left);
      if (!a.ok) return a;
      const b = constEval(node.right);
      if (!b.ok) return b;
      const r = evalBinop(node.op, a.value, b.value);
      if (isTrap(r)) return { ok: false, trap: r.trap };
      return { ok: true, value: r.value };
    }
    case 'Logical': {
      const a = constEval(node.left);
      if (!a.ok) return a;
      // Short-circuiting applies here too: `0 && f()` is constantly 0 even
      // though the right side is not constant.
      if (node.op === '&&' && a.value === 0) return { ok: true, value: 0 };
      if (node.op === '||' && a.value !== 0) return { ok: true, value: 1 };
      const b = constEval(node.right);
      if (!b.ok) return b;
      return { ok: true, value: b.value === 0 ? 0 : 1 };
    }
    default:
      return { ok: false };
  }
}

/**
 * Does this statement return on every path?
 *
 * A loop that cannot finish normally counts: `while (1) { ... }` with no break
 * never falls out of the bottom, so a function ending in one cannot reach its
 * closing brace. Without that rule an interpreter's main loop would have to be
 * written with a dead `return` after it to satisfy the checker.
 */
export function alwaysReturns(stmt) {
  if (!stmt) return false;
  switch (stmt.kind) {
    case 'Return': return true;
    case 'Block': return stmt.stmts.some(alwaysReturns);
    case 'If': return !!stmt.otherwise && alwaysReturns(stmt.then) && alwaysReturns(stmt.otherwise);
    case 'While': {
      const c = constEval(stmt.cond);
      return c.ok && c.value !== 0 && !hasBreak(stmt.body);
    }
    case 'For': {
      if (stmt.cond === null) return !hasBreak(stmt.body);
      const c = constEval(stmt.cond);
      return c.ok && c.value !== 0 && !hasBreak(stmt.body);
    }
    default: return false;
  }
}

/** A break belonging to *this* loop; one inside a nested loop is not ours. */
function hasBreak(stmt) {
  if (!stmt) return false;
  switch (stmt.kind) {
    case 'Break': return true;
    case 'Block': return stmt.stmts.some(hasBreak);
    case 'If': return hasBreak(stmt.then) || hasBreak(stmt.otherwise);
    case 'While': case 'For': return false;
    default: return false;
  }
}

class Sema {
  constructor(program, diags) {
    this.program = program;
    this.diags = diags;
    this.functions = new Map();
    this.fn = null;
    this.loopDepth = 0;
    this.locals = [];
  }

  run() {
    this.collectFunctions();
    this.checkMain();
    for (const fn of this.program.functions) this.checkFunction(fn);
    return { functions: this.functions };
  }

  /** Signatures first, so a function may call one declared after it. */
  collectFunctions() {
    for (const fn of this.program.functions) {
      if (BUILTINS.has(fn.name)) {
        this.diags.error(`'${fn.name}' is a builtin and cannot be redeclared`, fn.span);
        continue;
      }
      const existing = this.functions.get(fn.name);
      if (existing) {
        this.diags.error(`function '${fn.name}' is declared twice`, fn.span,
          { notes: [`first declared at ${existing.span.line}:${existing.span.col}`] });
        continue;
      }
      const seen = new Set();
      for (const p of fn.params) {
        if (seen.has(p.name)) this.diags.error(`parameter '${p.name}' is declared twice`, p.span);
        seen.add(p.name);
      }
      const sig = {
        name: fn.name, returnType: fn.returnType, params: fn.params, span: fn.span, decl: fn,
      };
      this.functions.set(fn.name, sig);
      fn.sig = sig;
    }
  }

  checkMain() {
    const main = this.functions.get('main');
    if (!main) {
      this.diags.error("every program must declare 'int main()'", this.program.span);
      return;
    }
    if (main.returnType !== 'int') this.diags.error("'main' must return int", main.span);
    if (main.params.length) this.diags.error("'main' must take no parameters", main.span);
  }

  checkFunction(fn) {
    if (!fn.sig) return;          // duplicate or redeclared builtin, already reported
    this.fn = fn.sig;
    this.loopDepth = 0;
    this.locals = [];

    // Parameters live in a scope outside the body, so a declaration in the
    // body may shadow one, as docs/semantics.md allows for any block.
    const params = new Scope(null);
    for (const p of fn.params) {
      const sym = {
        name: p.name, type: p.type, kind: 'param', length: null, span: p.span,
        id: this.locals.length,
      };
      if (!params.declare(sym)) this.locals.push(sym);
      p.symbol = sym;
    }

    this.block(fn.body, new Scope(params));

    if (fn.returnType !== 'void' && !alwaysReturns(fn.body)) {
      this.diags.error(`'${fn.name}' must return a value on every path`, fn.span,
        { label: 'not every path returns' });
    }
    fn.locals = this.locals;
    this.fn = null;
  }

  block(node, scope) {
    for (const stmt of node.stmts) this.stmt(stmt, scope);
  }

  stmt(node, scope) {
    if (!node) return;
    switch (node.kind) {
      case 'Block':
        this.block(node, new Scope(scope));
        return;
      case 'Empty':
        return;
      case 'VarDecl':
        if (node.init) this.expectInt(node.init, `the initial value of '${node.name}'`, scope);
        this.declareLocal(node, scope, 'int', null);
        return;
      case 'ArrayDecl':
        this.arrayDecl(node, scope);
        return;
      case 'If':
        this.expectInt(node.cond, 'a condition', scope);
        this.stmt(node.then, scope);
        this.stmt(node.otherwise, scope);
        return;
      case 'While':
        this.expectInt(node.cond, 'a condition', scope);
        this.loopDepth++;
        this.stmt(node.body, scope);
        this.loopDepth--;
        return;
      case 'For': {
        // The initializer's declaration is scoped to the loop.
        const inner = new Scope(scope);
        this.stmt(node.init, inner);
        if (node.cond) this.expectInt(node.cond, 'a condition', inner);
        if (node.step) this.expr(node.step, inner);
        this.loopDepth++;
        this.stmt(node.body, inner);
        this.loopDepth--;
        return;
      }
      case 'Break':
      case 'Continue': {
        const word = node.kind === 'Break' ? 'break' : 'continue';
        if (this.loopDepth === 0) {
          this.diags.error(`'${word}' is only allowed inside a loop`, node.span);
        }
        return;
      }
      case 'Return':
        this.returnStmt(node, scope);
        return;
      case 'ExprStmt':
        this.expr(node.expr, scope);
        return;
      default:
        return;
    }
  }

  declareLocal(node, scope, type, length) {
    const sym = {
      name: node.name, type, kind: 'var', length, span: node.span, id: this.locals.length,
    };
    const clash = scope.declare(sym);
    if (clash) {
      this.diags.error(`'${node.name}' is already declared in this scope`, node.span,
        { notes: [`first declared at ${clash.span.line}:${clash.span.col}`] });
      return;
    }
    this.locals.push(sym);
    node.symbol = sym;
  }

  arrayDecl(node, scope) {
    let length = null;
    if (node.size) {
      this.expectInt(node.size, 'an array length', scope);
      const c = constEval(node.size);
      if (c.trap) {
        this.diags.error('an array length must be a constant expression that does not trap',
          node.size.span);
      } else if (!c.ok) {
        this.diags.error('an array length must be a constant expression', node.size.span,
          { notes: ['the length has to be known while compiling, so it cannot depend on a variable'] });
      } else if (c.value <= 0) {
        this.diags.error(`an array length must be greater than zero, but is ${c.value}`,
          node.size.span);
      } else {
        length = c.value;
      }
    }

    if (node.init) {
      for (const el of node.init) {
        this.expectInt(el, `an initializer element of '${node.name}'`, scope);
      }
      if (!node.size) {
        if (node.init.length === 0) {
          this.diags.error(`array '${node.name}' needs at least one element`, node.span);
        } else {
          length = node.init.length;
        }
      } else if (length !== null && node.init.length > length) {
        this.diags.error(
          `the initializer has ${node.init.length} elements but '${node.name}' holds ${length}`,
          node.span);
      }
    }

    node.length = length;
    this.declareLocal(node, scope, 'int[]', length);
  }

  returnStmt(node, scope) {
    const wants = this.fn ? this.fn.returnType : 'void';
    if (node.value) {
      this.expectInt(node.value, 'the returned value', scope);
      if (wants === 'void') {
        this.diags.error(`cannot return a value from '${this.fn.name}', which returns void`,
          node.span);
      }
      return;
    }
    if (wants !== 'void') this.diags.error(`'${this.fn.name}' must return a value`, node.span);
  }

  /** Check `node` and require an int, naming the context in any complaint. */
  expectInt(node, what, scope) {
    const t = this.expr(node, scope);
    if (t === 'int[]') {
      this.diags.error(`${what} must be an int, but ${describe(node)} is an array`, node.span);
    } else if (t === 'void') {
      this.diags.error(`${what} must be an int, but ${describe(node)} returns nothing`, node.span);
    }
    return t;
  }

  expr(node, scope) {
    if (!node) return ERROR;
    switch (node.kind) {
      case 'IntLit':
        return (node.type = 'int');

      case 'Name': {
        const sym = scope.lookup(node.name);
        if (!sym) {
          if (this.functions.has(node.name) || BUILTINS.has(node.name)) {
            this.diags.error(`'${node.name}' is a function; call it as ${node.name}(...)`, node.span);
          } else {
            this.diags.error(`undeclared variable '${node.name}'`, node.span);
          }
          return (node.type = ERROR);
        }
        node.symbol = sym;
        return (node.type = sym.type);
      }

      case 'Index': {
        const arrayType = this.expr(node.array, scope);
        if (arrayType === 'int') {
          this.diags.error(`cannot index ${describe(node.array)}, which is an int`, node.array.span);
        } else if (arrayType === 'void') {
          this.diags.error(`cannot index ${describe(node.array)}, which returns nothing`,
            node.array.span);
        }
        this.expectInt(node.index, 'an array index', scope);
        return (node.type = 'int');
      }

      case 'Call':
        return this.call(node, scope);

      case 'Unary':
        this.expectInt(node.operand, `the operand of '${node.op}'`, scope);
        return (node.type = 'int');

      case 'Binary':
      case 'Logical':
        this.expectInt(node.left, `the left operand of '${node.op}'`, scope);
        this.expectInt(node.right, `the right operand of '${node.op}'`, scope);
        return (node.type = 'int');

      case 'Assign':
        return this.assign(node, scope);

      default:
        return ERROR;
    }
  }

  call(node, scope) {
    const sig = this.functions.get(node.callee) ?? BUILTINS.get(node.callee);
    if (!sig) {
      if (scope.lookup(node.callee)) {
        this.diags.error(`'${node.callee}' is not a function`, node.span);
      } else {
        this.diags.error(`undeclared function '${node.callee}'`, node.span);
      }
      for (const arg of node.args) this.expr(arg, scope);
      return (node.type = ERROR);
    }

    node.sig = sig;
    if (node.args.length !== sig.params.length) {
      const n = sig.params.length;
      const given = node.args.length;
      this.diags.error(
        `'${sig.name}' takes ${n} argument${n === 1 ? '' : 's'} but ${given} ${given === 1 ? 'was' : 'were'} given`,
        node.span);
    }

    node.args.forEach((arg, i) => {
      const param = sig.params[i];
      const t = this.expr(arg, scope);
      if (!param || t === ERROR) return;
      if (param.type === 'int' && t !== 'int') {
        const what = t === 'void' ? 'returns nothing' : 'is an array';
        this.diags.error(`argument ${i + 1} of '${sig.name}' must be an int, but ${describe(arg)} ${what}`,
          arg.span);
      } else if (param.type === 'int[]' && t !== 'int[]') {
        const what = t === 'void' ? 'returns nothing' : 'is an int';
        this.diags.error(`argument ${i + 1} of '${sig.name}' must be an array, but ${describe(arg)} ${what}`,
          arg.span);
      }
    });

    return (node.type = sig.returnType);
  }

  assign(node, scope) {
    const target = node.target;
    if (target.kind === 'Name') {
      const t = this.expr(target, scope);
      if (t === 'int[]') {
        this.diags.error(`cannot assign to array '${target.name}'`, target.span,
          { notes: ['there is no array assignment; assign to its elements instead'] });
        // The value is still checked, so a mistake inside it is reported, but
        // it is not required to be an int: there is no assignment here to have
        // a type, and demanding one would imply `a = 5` were allowed.
        this.expr(node.value, scope);
        return (node.type = ERROR);
      }
    } else {
      this.expr(target, scope);   // an Index: checks both the array and the index
    }
    this.expectInt(node.value, 'the assigned value', scope);
    return (node.type = 'int');
  }
}

/** Analyse a parsed program, annotating it in place. */
export function analyze(program, diags) {
  return new Sema(program, diags).run();
}

/**
 * Parse and analyse `source`.
 *
 * A parse failure stops here: analysing a tree with holes in it produces
 * messages about the holes rather than about the program, and the parser has
 * already said what is wrong.
 */
export function analyzeSource(source) {
  const { program, diags } = parse(source);
  if (diags.failed) return { program, functions: new Map(), diags };
  const { functions } = analyze(program, diags);
  return { program, functions, diags };
}
