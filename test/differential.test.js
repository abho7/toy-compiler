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
