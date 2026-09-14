// The randomized differential, as a fixed subset that runs in CI.
//
// Long campaigns run locally with `node tools/fuzz.js --programs=100000`. This
// is the part that runs on every commit: a fixed seed band, so it is
// deterministic and a regression fails the same way on every machine, sized to
// stay inside the suite's time budget.
//
// The assertions are deliberately in two halves. Agreement is the claim, but a
// campaign of programs that all did nothing would agree perfectly and prove
// nothing, so the second half checks the campaign was worth running: every
// program compiled, output was actually produced, and traps actually happened.
// This project has twice shipped a green test that passed because the code
// under it never ran.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateProgram, printProgram } from '../src/testing/random-program.js';
import { checkSource, QUICK } from '../src/testing/differential.js';
import { shrinkProgram, programSize } from '../src/testing/shrink.js';

const FIRST_SEED = 1;
const PROGRAMS = 500;

/** Run the band once; every test below reads this. */
const campaign = (() => {
  const outcomes = new Map();
  const disagreements = [];
  const uncompilable = [];
  let agreed = 0;
  let skipped = 0;
  let outputBytes = 0;

  for (let i = 0; i < PROGRAMS; i++) {
    const seed = FIRST_SEED + i;
    const source = printProgram(generateProgram(seed));
    const result = checkSource(source, { configurations: QUICK });

    switch (result.status) {
      case 'agree':
        agreed++;
        outputBytes += result.outputBytes;
        outcomes.set(result.outcome, (outcomes.get(result.outcome) ?? 0) + 1);
        break;
      case 'skipped': skipped++; break;
      case 'compile-error': uncompilable.push({ seed, messages: result.messages }); break;
      default: disagreements.push({ seed, result }); break;
    }
  }
  return { outcomes, disagreements, uncompilable, agreed, skipped, outputBytes };
})();

test('every generated program agrees, unoptimized and optimized', () => {
  const described = campaign.disagreements
    .map(({ seed, result }) => `seed ${seed} at ${result.config}/${result.engine}: ${result.detail}`);
  assert.deepEqual(described, [],
    `${campaign.disagreements.length} of ${PROGRAMS} programs disagreed`);
});

test('every generated program compiles', () => {
  // The generator's central claim. A failure here is a generator bug, and it
  // would quietly shrink the campaign rather than fail it.
  const described = campaign.uncompilable.map(({ seed, messages }) => `seed ${seed}: ${messages.join('; ')}`);
  assert.deepEqual(described, []);
});

test('the campaign terminates, so agreement is about behaviour', () => {
  // Loop counters are unassignable and calls form a DAG, so no generated
  // program should run away. A skip is not a failure, but a campaign that is
  // mostly skips has stopped testing anything.
  assert.ok(campaign.skipped <= PROGRAMS * 0.01,
    `${campaign.skipped} of ${PROGRAMS} programs exceeded the reference budget`);
});

test('the campaign is worth running: output, traps and clean exits all occur', () => {
  assert.ok(campaign.agreed > PROGRAMS * 0.95, `only ${campaign.agreed} programs produced an observation`);

  // Two programs that both print nothing agree trivially.
  const meanOutput = campaign.outputBytes / campaign.agreed;
  assert.ok(meanOutput > 20, `mean output was only ${meanOutput.toFixed(1)} bytes per program`);

  const exits = campaign.outcomes.get('exit') ?? 0;
  assert.ok(exits > campaign.agreed * 0.5, `only ${exits} programs exited cleanly`);

  // Trap kind and position are what two implementations most easily disagree
  // about, so a campaign with no traps in it is missing the interesting half.
  for (const kind of ['div_by_zero', 'out_of_bounds']) {
    assert.ok((campaign.outcomes.get(kind) ?? 0) > 0, `no program trapped with ${kind}`);
  }
});

test('the shrinker reduces a program while the predicate still holds', () => {
  // Shrinking is exercised on a synthetic predicate rather than a real bug,
  // because there is no real bug to shrink -- and a shrinker that is only ever
  // run when something fails is one that has never run at all.
  const model = generateProgram(7);
  const before = programSize(model);
  assert.ok(before.statements > 5, 'the seed chosen for shrinking is too small to be a test');

  // "Still contains a print of some kind", which most reductions preserve and
  // enough violate to make the search do real work.
  const hasOutput = (m) => {
    let found = false;
    const visit = (stmts) => {
      for (const s of stmts) {
        if (s.kind === 'print' || s.kind === 'putchar' || s.kind === 'printCall') found = true;
        if (s.kind === 'for') visit(s.body);
        if (s.kind === 'if') { visit(s.then); visit(s.otherwise ?? []); }
      }
    };
    for (const f of m.funcs) visit(f.body);
    return found;
  };

  const shrunk = shrinkProgram(model, hasOutput);
  const after = programSize(shrunk.model);

  assert.ok(shrunk.accepted > 0, 'the shrinker accepted no reduction at all');
  assert.ok(after.statements < before.statements,
    `shrinking did not reduce the program: ${before.statements} -> ${after.statements}`);
  assert.ok(hasOutput(shrunk.model), 'the shrinker returned a program failing its own predicate');
});

test('the harness detects a wrong optimization, so its agreement means something', () => {
  // The campaign reports zero disagreements. That is either because the
  // compiler is right or because the comparison cannot see a wrong answer, and
  // those look identical from the outside. So: break the optimizer on purpose
  // and require the harness to catch it.
  //
  // The injected bug is the one docs/correctness.md singles out as the folder's
  // central hazard -- deleting a division that would have trapped. It changes
  // observable behaviour without changing the shape of the IR, so nothing but
  // the byte comparison can catch it.
  const deleteDivisionTraps = (module) => {
    for (const func of module.funcs.values()) {
      for (const block of func.blocks) {
        for (const instr of block.instrs) {
          if (instr.op === 'binop' && (instr.imm === '/' || instr.imm === '%')) {
            instr.op = 'const';
            instr.imm = 0;
            instr.args = [];
            instr.incoming = null;
          }
        }
      }
    }
  };

  // A program that actually divides by zero, or the injected bug has nothing
  // to delete and the test would pass while proving nothing.
  let trapping = null;
  for (let seed = 1; seed <= 200 && !trapping; seed++) {
    const source = printProgram(generateProgram(seed));
    const result = checkSource(source, { configurations: QUICK });
    if (result.status === 'agree' && result.outcome === 'div_by_zero') trapping = { seed, source };
  }
  assert.ok(trapping, 'no generated program in the first 200 seeds trapped on division by zero');

  // Paired, in this project's habit: the harness stays quiet on the real
  // compiler and speaks up on the broken one. Only the first half is what CI
  // asserts everywhere else, and on its own it is satisfied by a harness that
  // can never fail.
  const honest = checkSource(trapping.source, { configurations: QUICK });
  assert.equal(honest.status, 'agree', `seed ${trapping.seed} should agree without the injected bug`);

  const sabotaged = checkSource(trapping.source, { configurations: QUICK, transform: deleteDivisionTraps });
  assert.equal(sabotaged.status, 'mismatch',
    `the harness did not notice that every division was replaced by zero (seed ${trapping.seed})`);
});

test('the shrinker never returns a program that does not compile', () => {
  // The rule that keeps shrinking honest: most reductions produce an
  // uncompilable program, and accepting one would "minimise" every bug to a
  // syntax error.
  const model = generateProgram(103);
  const compiles = (m) => checkSource(printProgram(m), { configurations: [] }).status !== 'compile-error';
  const shrunk = shrinkProgram(model, compiles);
  assert.ok(compiles(shrunk.model), 'the shrinker produced an uncompilable program');
});
