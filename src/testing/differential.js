// One generated program, run every way, compared byte for byte.
//
// test/differential.test.js does this for the corpus, where the programs are
// fixed and every anomaly is a failure. Generated programs need different
// handling in three places, which is why this is a separate harness rather than
// a parameter on that one:
//
//   A program that does not compile is a bug in the *generator*, not in the
//   compiler, and has to be reported as such -- the generator's whole claim is
//   that it only emits well-typed programs.
//
//   A program the oracle cannot finish inside its budget is skipped, not
//   failed. docs/semantics.md is explicit that the budget is a tooling limit
//   and never a behaviour, so a program that hits it has produced no
//   observation to compare and proves nothing either way.
//
//   A disagreement has to be *reported* rather than asserted, because the
//   campaign driver wants to shrink it and carry on rather than stop.
//
// Agreement means observationBytes are equal: the same output, the same trap
// kind at the same source position, and the same exit status.

import { parse } from '../parser.js';
import { analyze } from '../sema.js';
import { runProgram, observationBytes } from '../interp/ast-interp.js';
import { buildModule } from '../ir/build.js';
import { runModule } from '../ir/interp.js';
import { validateModule } from '../ir/validate.js';
import { generate } from '../backend/codegen.js';
import { runBytecode } from '../vm/vm.js';
import { optimize, PASSES, DEFAULT_PIPELINE } from '../opt/passes.js';

// The budgets differ because the same program costs different amounts to run
// each way: the VM spends several instructions per IR instruction. These are
// deliberately generous -- a generated program that needs more than this is one
// the campaign skips rather than one it mis-reports.
export const AST_BUDGET = 5_000_000;
export const IR_BUDGET = 20_000_000;
export const VM_BUDGET = 60_000_000;

/** Pass lists to compare against the oracle. `[]` is the unoptimized build. */
export const QUICK = Object.freeze([[], [...DEFAULT_PIPELINE]]);

/**
 * Every pass alone as well, plus the pipeline applied twice.
 *
 * A pass only ever run inside a pipeline is one whose bugs get attributed to
 * its neighbours; running the pipeline twice catches a pass that is not
 * idempotent, which is the shape a stale-cache bug takes.
 */
export const THOROUGH = Object.freeze([
  [],
  ...Object.keys(PASSES).map((name) => [name]),
  [...DEFAULT_PIPELINE],
  [...DEFAULT_PIPELINE, ...DEFAULT_PIPELINE],
]);

const decode = (bytes) => new TextDecoder().decode(bytes);
const configName = (passes) => (passes.length ? passes.join('+') : 'O0');

/** Parse and analyse, returning null when the program does not compile. */
function compile(source) {
  const { program, diags } = parse(source);
  if (!diags.failed) analyze(program, diags);
  if (diags.failed) return { program: null, messages: diags.items.map((d) => `${d.span}: ${d.message}`) };
  return { program, messages: [] };
}

/** The first line that differs, so a failure report is readable. */
function firstDifference(expected, actual) {
  const a = decode(expected).split('\n');
  const b = decode(actual).split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `line ${i + 1}: expected ${JSON.stringify(a[i] ?? null)}, got ${JSON.stringify(b[i] ?? null)}`;
    }
  }
  return 'the byte streams differ in length only';
}

/**
 * Check one program.
 *
 * Returns one of:
 *   { status: 'compile-error', messages }   the generator emitted a bad program
 *   { status: 'skipped', reason }           the oracle ran out of budget
 *   { status: 'mismatch', config, engine, detail, ... }
 *   { status: 'agree', outcome, outputBytes, steps }
 *
 * `transform` is a hook for the test suite only: it runs over the module after
 * the passes, so a test can inject a deliberately wrong optimization and check
 * this harness actually notices. A harness that has never once reported a
 * disagreement has not been shown to be capable of reporting one.
 */
export function checkSource(source, { configurations = QUICK, transform = null } = {}) {
  const { program, messages } = compile(source);
  if (!program) return { status: 'compile-error', messages };

  const oracle = runProgram(program, { maxSteps: AST_BUDGET });
  if (oracle.outcome === 'budget') {
    return { status: 'skipped', reason: `the reference interpreter exceeded ${AST_BUDGET} steps` };
  }
  const expected = observationBytes(oracle);

  for (const passes of configurations) {
    const name = configName(passes);

    // A fresh build per configuration: the passes mutate the module, so a
    // shared one would make each configuration depend on the last.
    const { program: fresh } = compile(source);
    const module = buildModule(fresh);
    if (passes.length) optimize(module, passes);
    if (transform) transform(module);

    const malformed = validateModule(module);
    if (malformed.length) {
      return {
        status: 'mismatch', config: name, engine: 'validator',
        detail: `the IR is not well formed after ${name}: ${malformed[0]}`,
        outcome: oracle.outcome,
      };
    }

    const runs = [
      ['ir', () => runModule(module, { maxSteps: IR_BUDGET })],
      ['vm', () => runBytecode(generate(module), { maxSteps: VM_BUDGET })],
    ];
    for (const [engine, run] of runs) {
      const result = run();
      // The oracle finished, so this one running out of budget is a real
      // disagreement about how much work the program is, not a skip.
      if (result.outcome === 'budget') {
        return {
          status: 'mismatch', config: name, engine,
          detail: `the ${engine} exceeded its budget on a program the reference finished in ${oracle.steps} steps`,
          outcome: oracle.outcome,
        };
      }
      const actual = observationBytes(result);
      if (!Buffer.from(actual).equals(Buffer.from(expected))) {
        return {
          status: 'mismatch', config: name, engine,
          detail: firstDifference(expected, actual),
          expected: decode(expected), actual: decode(actual),
          outcome: oracle.outcome,
        };
      }
    }
  }

  return {
    status: 'agree',
    outcome: oracle.outcome === 'trap' ? oracle.trap.kind : oracle.outcome,
    outputBytes: oracle.output.length,
    steps: oracle.steps,
  };
}

/**
 * Which disagreement this is, as a string.
 *
 * The shrinker uses it to insist that a reduced program still fails *the same
 * way*. Without that, shrinking happily wanders onto a different bug and
 * reports a minimal program for something other than what was found.
 */
export function mismatchSignature(result) {
  return result.status === 'mismatch' ? `${result.config}/${result.engine}` : null;
}
