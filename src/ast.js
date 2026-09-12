// The abstract syntax tree.
//
// Nodes are plain objects with a `kind` and a `span`. They are built by the
// parser, annotated in place by semantic analysis (which adds `type` to
// expressions and `symbol` to names), and read by the IR builder, the
// reference interpreter and the playground.
//
// The shapes, in one place so the rest of the compiler can be read against it:
//
//   Program      { functions: FunctionDecl[] }
//   FunctionDecl { name, returnType: 'int'|'void', params: Param[], body: Block }
//   Param        { name, type: 'int'|'int[]' }
//
//   Block        { stmts: Stmt[] }
//   VarDecl      { name, init: Expr|null }
//   ArrayDecl    { name, size: Expr|null, init: Expr[]|null, fromString: bool }
//   If           { cond, then, otherwise: Stmt|null }
//   While        { cond, body }
//   For          { init: Stmt|null, cond: Expr|null, step: Expr|null, body }
//   Break        { }
//   Continue     { }
//   Return       { value: Expr|null }
//   ExprStmt     { expr }
//   Empty        { }
//
//   IntLit       { value }
//   Name         { name }
//   Index        { array: Expr, index: Expr }
//   Call         { callee: string, args: Expr[] }
//   Unary        { op: '-'|'!'|'~', operand }
//   Binary       { op, left, right }        // arithmetic, bitwise, comparison
//   Logical      { op: '&&'|'||', left, right }   // short-circuiting
//   Assign       { target: Name|Index, value }
//
// Logical is separate from Binary because short-circuiting is control flow:
// docs/semantics.md says the right operand of `&&` is not evaluated at all
// when the left is zero, so the IR builder has to emit branches for it rather
// than a single instruction. Keeping them apart means no pass can treat one as
// the other by accident.

export const EXPR_KINDS = new Set([
  'IntLit', 'Name', 'Index', 'Call', 'Unary', 'Binary', 'Logical', 'Assign',
]);

export const STMT_KINDS = new Set([
  'Block', 'VarDecl', 'ArrayDecl', 'If', 'While', 'For', 'Break', 'Continue',
  'Return', 'ExprStmt', 'Empty',
]);

/** The children of a node, in evaluation order. Order matters: docs/semantics.md
 *  fixes left-to-right evaluation, and walkers rely on it to stay faithful. */
export function children(node) {
  // Error recovery leaves holes: `1 + ;` parses with a null right operand, and
  // the phases after the parser still walk the tree to report what they can.
  // Holes are filtered here, once, so no walker has to remember they exist.
  if (!node) return [];
  return rawChildren(node).filter(Boolean);
}

function rawChildren(node) {
  switch (node.kind) {
    case 'Program': return node.functions;
    case 'FunctionDecl': return [node.body];
    case 'Block': return node.stmts;
    case 'VarDecl': return node.init ? [node.init] : [];
    case 'ArrayDecl': return [...(node.size ? [node.size] : []), ...(node.init ?? [])];
    case 'If': return [node.cond, node.then, ...(node.otherwise ? [node.otherwise] : [])];
    case 'While': return [node.cond, node.body];
    case 'For': return [
      ...(node.init ? [node.init] : []), ...(node.cond ? [node.cond] : []),
      ...(node.step ? [node.step] : []), node.body,
    ];
    case 'Return': return node.value ? [node.value] : [];
    case 'ExprStmt': return [node.expr];
    case 'Index': return [node.array, node.index];
    case 'Call': return node.args;
    case 'Unary': return [node.operand];
    case 'Binary': case 'Logical': return [node.left, node.right];
    case 'Assign': return [node.target, node.value];
    default: return [];
  }
}

/** Depth-first walk in evaluation order. */
export function walk(node, visit) {
  if (!node) return;
  visit(node);
  for (const child of children(node)) walk(child, visit);
}

/**
 * The tree as indented text, e.g.
 *
 *   FunctionDecl int main()
 *     Block
 *       Return
 *         Binary +
 *           IntLit 1
 *           IntLit 2
 *
 * Used by the parser tests, which compare structure without hand-writing deep
 * object literals, and by the playground's AST view.
 */
export function printAst(node, indent = 0) {
  const pad = '  '.repeat(indent);
  const lines = [`${pad}${label(node)}`];
  for (const child of children(node)) lines.push(printAst(child, indent + 1));
  return lines.join('\n');
}

function label(node) {
  switch (node.kind) {
    case 'Program': return 'Program';
    case 'FunctionDecl':
      return `FunctionDecl ${node.returnType} ${node.name}(${node.params.map((p) => `${p.type} ${p.name}`).join(', ')})`;
    case 'VarDecl': return `VarDecl ${node.name}`;
    case 'ArrayDecl': return `ArrayDecl ${node.name}[]${node.fromString ? ' (string)' : ''}`;
    case 'IntLit': return `IntLit ${node.value}`;
    case 'Name': return `Name ${node.name}`;
    case 'Call': return `Call ${node.callee}`;
    case 'Unary': return `Unary ${node.op}`;
    case 'Binary': return `Binary ${node.op}`;
    case 'Logical': return `Logical ${node.op}`;
    default: return node.kind;
  }
}
