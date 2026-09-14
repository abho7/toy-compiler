// Three ways of running a program, compared byte for byte on every corpus
// program.
//
// The reference interpreter walks the syntax tree, the IR interpreter runs SSA
// over a control flow graph, and the VM executes bytecode. They share the
// arithmetic kernel and nothing else -- different data structures, different
// control flow, different notion of a variable -- so agreement between them is
// evidence rather than tautology.
//
// Agreement means the same output bytes, the same trap kind at the same source
// position, and the same exit status, which is what observationBytes encodes.
// Each optimization pass will join this comparison as it is written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parse } from '../src/parser.js';
import { analyze } from '../src/sema.js';
import { runProgram, observationBytes } from '../src/interp/ast-interp.js';
import { buildModule } from '../src/ir/build.js';
import { runModule } from '../src/ir/interp.js';
import { validateModule } from '../src/ir/validate.js';
import { generate } from '../src/backend/codegen.js';
import { runBytecode } from '../src/vm/vm.js';
import { optimize, PASSES, DEFAULT_PIPELINE } from '../src/opt/passes.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, 'corpus');
const programs = readdirSync(CORPUS).filter((f) => f.endsWith('.mc')).sort();

function compile(source) {
  const { program, diags } = parse(source);
  analyze(program, diags);
  assert.deepEqual(diags.items.map((d) => d.message), [], 'the program must compile');
  const module = buildModule(program);
  return { program, module, bytecode: generate(module) };
}

const decode = (bytes) => new TextDecoder().decode(bytes);
const bytes = (result) => Buffer.from(observationBytes(result));

for (const file of programs) {
  test(`three ways agree: ${file}`, () => {
    const source = readFileSync(join(CORPUS, file), 'utf8');
    const { program, module, bytecode } = compile(source);

    assert.deepEqual(validateModule(module), [], `${file}: the IR is not well formed`);

    const fromAst = runProgram(program, { maxSteps: 5_000_000 });
    const fromIr = runModule(module, { maxSteps: 20_000_000 });
    // The naive code generator spends several instructions per IR instruction,
    // so the VM needs a larger budget to do the same work.
    const fromVm = runBytecode(bytecode, { maxSteps: 60_000_000 });

    for (const [name, result] of [['reference', fromAst], ['ir', fromIr], ['vm', fromVm]]) {
      assert.notEqual(result.outcome, 'budget', `${file}: the ${name} run did not finish`);
    }

    // Text first so a failure is readable, then bytes, which is the claim.
    assert.equal(decode(observationBytes(fromIr)), decode(observationBytes(fromAst)),
      `${file}: the IR interpreter disagrees with the reference`);
    assert.equal(decode(observationBytes(fromVm)), decode(observationBytes(fromAst)),
      `${file}: the VM disagrees with the reference`);
    assert.ok(bytes(fromIr).equals(bytes(fromAst)), `${file}: IR bytes differ`);
    assert.ok(bytes(fromVm).equals(bytes(fromAst)), `${file}: VM bytes differ`);
  });
}

test('the differential covers the whole corpus', () => {
  assert.ok(programs.length >= 15, `only ${programs.length} programs compared`);
});

// Every pass alone, the whole pipeline, and the pipeline twice. Each pass is
// run on its own because a pass only ever tested inside a pipeline is one whose
// bugs get attributed to its neighbours.
const CONFIGURATIONS = [
  ...Object.keys(PASSES).map((name) => [name]),
  [...DEFAULT_PIPELINE],
  [...DEFAULT_PIPELINE, ...DEFAULT_PIPELINE],
];

for (const file of programs) {
  for (const names of CONFIGURATIONS) {
    test(`optimized agrees: ${file} [${names.join('+')}]`, () => {
      const source = readFileSync(join(CORPUS, file), 'utf8');
      const { program } = compile(source);
      const expected = observationBytes(runProgram(program, { maxSteps: 5_000_000 }));

      const { module } = compile(source);
      optimize(module, names);
      assert.deepEqual(validateModule(module), [], `${file}: ${names.join('+')} left the IR malformed`);

      const fromIr = runModule(module, { maxSteps: 20_000_000 });
      const fromVm = runBytecode(generate(module), { maxSteps: 60_000_000 });

      assert.equal(decode(observationBytes(fromIr)), decode(expected),
        `${file}: the IR interpreter disagrees after ${names.join('+')}`);
      assert.equal(decode(observationBytes(fromVm)), decode(expected),
        `${file}: the VM disagrees after ${names.join('+')}`);
    });
  }
}

test('the optimizer actually optimizes, so the agreement above means something', () => {
  // Agreement is worthless if every pass is a no-op: value numbering once
  // reported zero changes on every program, and the tests that were supposed
  // to constrain it passed anyway. Each pass has to demonstrably fire
  // somewhere in the corpus.
  const fired = Object.fromEntries(Object.keys(PASSES).map((name) => [name, 0]));
  for (const file of programs) {
    const source = readFileSync(join(CORPUS, file), 'utf8');
    for (const name of Object.keys(PASSES)) {
      const { module } = compile(source);
      // Folding first for copyprop, which collapses phis that folding makes
      // trivial; alone it would have nothing to do on most programs.
      const report = optimize(module, name === 'copyprop' ? ['fold', name] : [name]);
      fired[name] += report[report.length - 1].changed;
    }
  }
  for (const [name, changes] of Object.entries(fired)) {
    assert.ok(changes > 0, `${name} changed nothing anywhere in the corpus`);
  }
});

test('every trap kind is exercised, in all three implementations', () => {
  // A comparison that never trapped would say nothing about traps, and trap
  // kind and position are what two implementations most easily disagree about.
  const seen = { ast: new Set(), ir: new Set(), vm: new Set() };
  for (const file of programs) {
    const source = readFileSync(join(CORPUS, file), 'utf8');
    const { program, module, bytecode } = compile(source);
    const runs = {
      ast: runProgram(program, { maxSteps: 5_000_000 }),
      ir: runModule(module, { maxSteps: 20_000_000 }),
      vm: runBytecode(bytecode, { maxSteps: 60_000_000 }),
    };
    for (const [which, result] of Object.entries(runs)) {
      if (result.outcome === 'trap') seen[which].add(result.trap.kind);
    }
  }
  const expected = ['div_by_zero', 'div_overflow', 'out_of_bounds', 'stack_overflow'];
  for (const which of ['ast', 'ir', 'vm']) {
    assert.deepEqual([...seen[which]].sort(), expected, `${which} did not produce every trap kind`);
  }
});
