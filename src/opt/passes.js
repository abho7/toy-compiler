// The optimization pipeline.
//
// Passes are named so that any combination can be run, which is what the
// differential harness needs: every pass alone, and all of them together, on
// every corpus program. A pass that is only ever tested as part of a pipeline
// is a pass whose bugs get attributed to its neighbours.
//
// The IR is validated after every pass. That does not check the pass preserved
// behaviour -- the harness does that -- it checks the result is still a
// well-formed program, which is the cheaper failure to find and the one that
// localises to a single pass.

import { assertValid } from '../ir/validate.js';
import { fold } from './fold.js';
import { dce } from './dce.js';
import { cse } from './cse.js';
import { copyprop } from './copyprop.js';

export const PASSES = Object.freeze({
  fold,
  copyprop,
  cse,
  dce,
});

/**
 * The default order, and why it is this one.
 *
 * Folding first, because a known constant is what lets a branch become a jump
 * and a whole region become unreachable. Copy propagation next, since folding
 * is what makes phis trivial. Then CSE, which benefits from both -- two
 * expressions are more likely to be recognised as the same once their operands
 * have been folded to the same constants. Dead code elimination last, because
 * every pass before it leaves work for it.
 */
export const DEFAULT_PIPELINE = Object.freeze(['fold', 'copyprop', 'cse', 'dce']);

/**
 * Run the named passes over a module, in order, validating after each.
 *
 * Returns a record of what each pass changed, which the benchmark and the
 * playground both display -- a pass that reports zero changes on every program
 * is a pass that is not earning its place.
 */
export function optimize(module, names = DEFAULT_PIPELINE, { validate = true } = {}) {
  const report = [];
  for (const name of names) {
    const pass = PASSES[name];
    if (!pass) throw new Error(`optimize: no pass named '${name}'`);
    const changed = pass(module);
    if (validate) assertValid(module, `the IR after ${name}`);
    report.push({ pass: name, changed });
  }
  return report;
}
