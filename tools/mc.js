// The minic command line.
//
//   node tools/mc.js program.mc              compile and run
//   node tools/mc.js --emit=tokens prog.mc   the token stream
//   node tools/mc.js --emit=ast prog.mc      the syntax tree
//   node tools/mc.js --max-steps=N prog.mc   stop after N steps
//
// Exit codes: a program that exits cleanly gives its own status (0-255); a
// compile error gives 2; a trap gives 70; exhausting the step budget gives 71.
// The trailer on stderr says which of those happened, so a program returning 70
// is still distinguishable from one that trapped.

import { readFileSync } from 'node:fs';

import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { analyze } from '../src/sema.js';
import { printAst } from '../src/ast.js';
import { runProgram, trailerOf, DEFAULT_MAX_STEPS } from '../src/interp/ast-interp.js';
import { buildModule } from '../src/ir/build.js';
import { printModule } from '../src/ir/ir.js';
import { assertValid } from '../src/ir/validate.js';
import { runModule } from '../src/ir/interp.js';

const EXIT_COMPILE_ERROR = 2;
const EXIT_TRAP = 70;
const EXIT_BUDGET = 71;

function usage(message) {
  if (message) process.stderr.write(`mc: ${message}\n`);
  process.stderr.write(`usage: node tools/mc.js [--emit=tokens|ast|ir|run] [--max-steps=N] [--via-ir] file.mc\n`);
  process.exit(message ? 2 : 0);
}

const args = process.argv.slice(2);
let emit = 'run';
let maxSteps = DEFAULT_MAX_STEPS;
let viaIr = false;
let file = null;

for (const arg of args) {
  if (arg === '-h' || arg === '--help') usage(null);
  else if (arg === '--via-ir') viaIr = true;
  else if (arg.startsWith('--emit=')) emit = arg.slice(7);
  else if (arg.startsWith('--max-steps=')) maxSteps = Number(arg.slice(12));
  else if (arg.startsWith('-')) usage(`unknown option ${arg}`);
  else if (file) usage('give exactly one file');
  else file = arg;
}
if (!file) usage('give a file to compile');
if (!['tokens', 'ast', 'ir', 'run'].includes(emit)) usage(`unknown --emit value '${emit}'`);
if (!Number.isFinite(maxSteps) || maxSteps <= 0) usage('--max-steps needs a positive number');

const source = readFileSync(file, 'utf8');

if (emit === 'tokens') {
  const { tokens, diags } = tokenize(source);
  for (const token of tokens) {
    process.stdout.write(`${String(token.span).padStart(7)}  ${token.kind.padEnd(8)} ${token.describe()}\n`);
  }
  if (diags.failed) {
    process.stderr.write(`${diags.items.map((d) => renderWith(source, d)).join('\n')}\n`);
    process.exit(EXIT_COMPILE_ERROR);
  }
  process.exit(0);
}

const { program, diags } = parse(source);
if (!diags.failed) analyze(program, diags);
if (diags.failed) {
  const { render } = await import('../src/diagnostics.js');
  process.stderr.write(`${diags.items.map((d) => render(source, d, file)).join('\n\n')}\n`);
  process.exit(EXIT_COMPILE_ERROR);
}

if (emit === 'ast') {
  process.stdout.write(`${printAst(program)}\n`);
  process.exit(0);
}

if (emit === 'ir') {
  const module = buildModule(program);
  assertValid(module, `the IR for ${file}`);
  process.stdout.write(`${printModule(module)}\n`);
  process.exit(0);
}

// --via-ir runs the same program through the IR interpreter instead of the
// reference one. The two must agree byte for byte; when they do not, this is
// how to see the difference on one program rather than through the harness.
const result = viaIr
  ? runModule(buildModule(program), { maxSteps })
  : runProgram(program, { maxSteps });
process.stdout.write(Buffer.from(result.output));
process.stderr.write(`${trailerOf(result)}\n`);

if (result.outcome === 'trap') process.exit(EXIT_TRAP);
if (result.outcome === 'budget') process.exit(EXIT_BUDGET);
process.exit(result.status);

/** Rendering for the token path, which runs before diagnostics are imported. */
function renderWith(src, diag) {
  return `${diag.span}: ${diag.message}`;
}
