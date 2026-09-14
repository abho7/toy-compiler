// Delta debugging: the smallest program that still shows the bug.
//
// A generated program that disagrees is typically sixty lines of noise around
// two that matter. Shrinking is what turns it into a regression test somebody
// can read, so a found bug becomes a permanent one-line guard rather than a
// seed number and a shrug.
//
// The method is the obvious one: propose a smaller program, keep it if it still
// fails, otherwise discard it, and repeat until nothing can be removed. Two
// rules make it trustworthy:
//
//   A candidate that does not compile is rejected, not counted as a failure.
//   Most reductions produce one -- removing a function that is still called,
//   or the return a non-void function needs -- and a shrinker that accepted
//   them would "minimise" every bug to a syntax error.
//
//   The predicate insists on the *same* disagreement, not any disagreement.
//   Otherwise shrinking wanders onto whatever bug the reduced program happens
//   to hit, and reports a minimal reproducer for something else entirely.
//
// Candidates are addressed by position rather than by path: clone the model,
// walk the clone in the same deterministic order, and mutate the nth site
// found. That avoids threading paths through a recursive structure, and the
// order is stable because cloning preserves it.

const ZERO = { kind: 'lit', value: 0 };

/** Every statement list in the model, in a fixed order. */
function statementLists(model) {
  const lists = [];
  const visit = (stmts) => {
    lists.push(stmts);
    for (const stmt of stmts) {
      if (stmt.kind === 'for') visit(stmt.body);
      else if (stmt.kind === 'if') {
        visit(stmt.then);
        if (stmt.otherwise) visit(stmt.otherwise);
      }
    }
  };
  for (const func of model.funcs) visit(func.body);
  return lists;
}

/**
 * Every expression slot, as the object holding it and the key to write.
 *
 * An `arrayRef` argument is skipped: it is the one expression position whose
 * type is `int[]`, so replacing it with an integer would not compile.
 */
function expressionSlots(model) {
  const slots = [];
  const visitExpr = (owner, key) => {
    const expr = owner[key];
    if (!expr || typeof expr !== 'object') return;
    if (expr.kind !== 'arrayRef') slots.push({ owner, key });
    switch (expr.kind) {
      case 'bin': case 'logical':
        visitExpr(expr, 'left');
        visitExpr(expr, 'right');
        break;
      case 'un': visitExpr(expr, 'operand'); break;
      case 'index': visitExpr(expr, 'index'); break;
      case 'call':
        expr.args.forEach((_, i) => visitExpr(expr.args, i));
        break;
      default: break;
    }
  };
  const visitStmt = (stmt) => {
    switch (stmt.kind) {
      case 'declInt': visitExpr(stmt, 'init'); break;
      case 'declArray': stmt.init.forEach((_, i) => visitExpr(stmt.init, i)); break;
      case 'assign': case 'print': case 'putchar': case 'return': visitExpr(stmt, 'value'); break;
      case 'store': visitExpr(stmt, 'index'); visitExpr(stmt, 'value'); break;
      case 'callStmt': case 'printCall':
        stmt.args.forEach((_, i) => visitExpr(stmt.args, i));
        break;
      case 'if':
        visitExpr(stmt, 'cond');
        stmt.then.forEach(visitStmt);
        (stmt.otherwise ?? []).forEach(visitStmt);
        break;
      case 'for': stmt.body.forEach(visitStmt); break;
      default: break;
    }
  };
  for (const func of model.funcs) func.body.forEach(visitStmt);
  return slots;
}

/** Every `for` statement, in a fixed order. */
function loops(model) {
  const found = [];
  const visit = (stmts) => {
    for (const stmt of stmts) {
      if (stmt.kind === 'for') { found.push(stmt); visit(stmt.body); }
      else if (stmt.kind === 'if') {
        visit(stmt.then);
        if (stmt.otherwise) visit(stmt.otherwise);
      }
    }
  };
  for (const func of model.funcs) visit(func.body);
  return found;
}

/**
 * Smaller programs to try, largest reduction first.
 *
 * Order matters for speed rather than correctness: dropping a whole function
 * early saves trying to shrink each of its statements one at a time.
 */
function* candidates(model) {
  // A whole function. Anything still calling it will fail to compile, which is
  // how a function that is actually needed gets rejected.
  for (let i = 0; i < model.funcs.length; i++) {
    if (model.funcs[i].name === 'main') continue;
    const next = structuredClone(model);
    next.funcs.splice(i, 1);
    yield next;
  }

  // One statement.
  const listCount = statementLists(model).length;
  for (let list = 0; list < listCount; list++) {
    const length = statementLists(model)[list].length;
    for (let i = 0; i < length; i++) {
      const next = structuredClone(model);
      statementLists(next)[list].splice(i, 1);
      yield next;
    }
  }

  // A loop that runs twice instead of nine times. Bounds below 2 are not
  // proposed: the generator guarantees every loop body runs, and a loop that
  // never runs would remove the output the comparison is made of.
  const loopCount = loops(model).length;
  for (let i = 0; i < loopCount; i++) {
    if (loops(model)[i].bound <= 2) continue;
    const next = structuredClone(model);
    loops(next)[i].bound = 2;
    yield next;
  }

  // An expression, replaced by one of its operands and then by a constant.
  // Operands first, because keeping a subexpression preserves more of whatever
  // made the program interesting than collapsing straight to zero.
  const slotCount = expressionSlots(model).length;
  for (let i = 0; i < slotCount; i++) {
    const current = expressionSlots(model)[i].owner[expressionSlots(model)[i].key];
    const replacements = [];
    if (current.kind === 'bin' || current.kind === 'logical') replacements.push(current.left, current.right);
    if (current.kind === 'un') replacements.push(current.operand);
    if (current.kind !== 'lit') replacements.push(ZERO);

    for (const replacement of replacements) {
      const next = structuredClone(model);
      const slot = expressionSlots(next)[i];
      slot.owner[slot.key] = structuredClone(replacement);
      yield next;
    }
  }

  // Array initializer elements, which are pure noise once the bug is found.
  const listsOfInit = [];
  for (const func of model.funcs) {
    const visit = (stmts) => {
      for (const stmt of stmts) {
        if (stmt.kind === 'declArray' && stmt.init.length) listsOfInit.push(true);
        if (stmt.kind === 'for') visit(stmt.body);
        if (stmt.kind === 'if') { visit(stmt.then); if (stmt.otherwise) visit(stmt.otherwise); }
      }
    };
    visit(func.body);
  }
  for (let i = 0; i < listsOfInit.length; i++) {
    const next = structuredClone(model);
    let seen = 0;
    const visit = (stmts) => {
      for (const stmt of stmts) {
        if (stmt.kind === 'declArray' && stmt.init.length) {
          if (seen === i) stmt.init = [];
          seen++;
        }
        if (stmt.kind === 'for') visit(stmt.body);
        if (stmt.kind === 'if') { visit(stmt.then); if (stmt.otherwise) visit(stmt.otherwise); }
      }
    };
    for (const func of next.funcs) visit(func.body);
    yield next;
  }
}

/**
 * Reduce a model for as long as it keeps failing.
 *
 * `stillFails(model)` must return true only for the disagreement being
 * shrunk -- see mismatchSignature in differential.js. Returns the smallest
 * model found and how much work it took.
 */
export function shrinkProgram(model, stillFails, { maxRounds = 50 } = {}) {
  let best = structuredClone(model);
  let rounds = 0;
  let accepted = 0;
  let tried = 0;

  for (; rounds < maxRounds; rounds++) {
    let improved = false;
    for (const candidate of candidates(best)) {
      tried++;
      if (!stillFails(candidate)) continue;
      best = candidate;
      accepted++;
      improved = true;
      break;                 // restart from the smaller program
    }
    if (!improved) break;    // nothing left to remove
  }

  return { model: best, rounds, accepted, tried };
}

/** How big a model is, for reporting what shrinking achieved. */
export function programSize(model) {
  let statements = 0;
  for (const list of statementLists(model)) statements += list.length;
  return { functions: model.funcs.length, statements, expressions: expressionSlots(model).length };
}
