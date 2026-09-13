// The reference interpreter against the IR interpreter, on every corpus
// program, compared byte for byte.
//
// This is the gate for phase 4 and the shape of every gate after it: as the IR
// gains optimization passes and a bytecode backend, each new way of running a
// program joins this comparison. Agreement is not "produces the same numbers" --
// it is the same output bytes, the same trap kind at the same source position,
// and the same exit status, which is exactly what observationBytes encodes.

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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, 'corpus');
const programs = readdirSync(CORPUS).filter((f) => f.endsWith('.mc')).sort();

/** Compile a source to both an analysed tree and an IR module. */
function compile(source) {
  const { program, diags } = parse(source);
  analyze(program, diags);
  assert.deepEqual(diags.items.map((d) => d.message), [], 'the program must compile');
  return { program, module: buildModule(program) };
}

const decode = (bytes) => new TextDecoder().decode(bytes);

for (const file of programs) {
  test(`ast and ir agree: ${file}`, () => {
    const source = readFileSync(join(CORPUS, file), 'utf8');
    const { program, module } = compile(source);

    assert.deepEqual(validateModule(module), [], `${file}: the IR is not well formed`);

    const fromAst = runProgram(program, { maxSteps: 5_000_000 });
    const fromIr = runModule(module, { maxSteps: 20_000_000 });

    assert.notEqual(fromAst.outcome, 'budget', `${file}: the reference run did not finish`);
    assert.notEqual(fromIr.outcome, 'budget', `${file}: the IR run did not finish`);

    // Text first, so a failure is readable; then bytes, which is the claim.
    assert.equal(decode(observationBytes(fromIr)), decode(observationBytes(fromAst)));
    assert.ok(Buffer.from(observationBytes(fromIr)).equals(Buffer.from(observationBytes(fromAst))),
      `${file}: the two interpreters disagree`);
  });
}

test('the differential covers the whole corpus', () => {
  assert.ok(programs.length >= 15, `only ${programs.length} programs compared`);
});

test('every trap kind is exercised by the comparison', () => {
  // A differential test that never trapped would say nothing about traps, and
  // trap kind and position are the parts most likely to drift between two
  // implementations.
  const kinds = new Set();
  for (const file of programs) {
    const source = readFileSync(join(CORPUS, file), 'utf8');
    const { module } = compile(source);
    const result = runModule(module, { maxSteps: 20_000_000 });
    if (result.outcome === 'trap') kinds.add(result.trap.kind);
  }
  assert.deepEqual([...kinds].sort(),
    ['div_by_zero', 'div_overflow', 'out_of_bounds', 'stack_overflow']);
});
