// The code generator's spill paths, under real pressure.
//
// With the natural register file, peak pressure across the corpus is 11 live
// values against 13 allocatable, so nothing ever spills -- which means the code
// that loads a spilled operand, stores a spilled result, and copies slot to
// slot across a phi edge never executes. Every test in the rest of the suite
// would pass with all of it broken.
//
// That is not hypothetical. Two passes in this project shipped in exactly that
// state: phase 5's copy-cycle breaker was unreachable, and phase 6's value
// numbering was inert, and in both cases a green suite was measuring code that
// never ran. So this squeezes the allocator down until spilling is forced, and
// checks the generated program still agrees with the reference interpreter.
//
// At zero allocatable registers every value lives in memory, which is the
// phase 5 scheme reconstructed through the current generator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parse } from '../src/parser.js';
import { analyze } from '../src/sema.js';
import { buildModule } from '../src/ir/build.js';
import { optimize, DEFAULT_PIPELINE } from '../src/opt/passes.js';
import { generate } from '../src/backend/codegen.js';
import { runBytecode } from '../src/vm/vm.js';
import { runProgram, observationBytes } from '../src/interp/ast-interp.js';
import { OP, WORDS_PER_INSTR } from '../src/vm/bytecode.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, 'corpus');
const programs = readdirSync(CORPUS).filter((f) => f.endsWith('.mc')).sort();
const decode = (bytes) => new TextDecoder().decode(bytes);

/** A fresh analysed program and optimized module, since both get consumed. */
function compile(source) {
  const { program, diags } = parse(source);
  analyze(program, diags);
  assert.deepEqual(diags.items.map((d) => d.message), []);
  const module = buildModule(program);
  optimize(module, DEFAULT_PIPELINE);
  return { program, module };
}

/** How many emitted instructions move values to or from frame slots. */
function slotTraffic(bytecode) {
  let n = 0;
  for (const func of bytecode.funcs) {
    for (let at = 0; at < func.spans.length; at++) {
      const op = func.code[at * WORDS_PER_INSTR];
      if (op === OP.LDSLOT || op === OP.STSLOT) n++;
    }
  }
  return n;
}

// Squeezing to 3 forces some spilling, 1 forces a great deal, and 0 puts every
// value in memory. Each level exercises a different mix of the spilled-operand
// and spilled-destination paths.
for (const maxRegisters of [3, 1, 0]) {
  test(`generated code agrees with the reference with ${maxRegisters} allocatable registers`, () => {
    let spills = 0;
    let slots = 0;

    for (const file of programs) {
      const source = readFileSync(join(CORPUS, file), 'utf8');

      const expected = observationBytes(runProgram(compile(source).program, { maxSteps: 5_000_000 }));
      const bytecode = generate(compile(source).module, { maxRegisters });
      const actual = observationBytes(runBytecode(bytecode, { maxSteps: 90_000_000 }));

      assert.equal(decode(actual), decode(expected),
        `${file} disagrees with ${maxRegisters} registers`);

      spills += bytecode.funcs.reduce((n, f) => n + (f.spills ?? 0), 0);
      slots += slotTraffic(bytecode);
    }

    // The point of the exercise: if these are zero, the paths under test did
    // not run and the assertions above proved nothing.
    assert.ok(spills > 0, `${maxRegisters} registers should have forced spills, got none`);
    assert.ok(slots > 0, `${maxRegisters} registers should have emitted slot traffic, got none`);
  });
}

test('the natural register file needs no slot traffic at all', () => {
  // The measurement phase 7 exists to produce, asserted so it cannot quietly
  // regress: with registers allocated, nothing in the corpus touches a frame
  // slot.
  let slots = 0;
  for (const file of programs) {
    const source = readFileSync(join(CORPUS, file), 'utf8');
    slots += slotTraffic(generate(compile(source).module));
  }
  assert.equal(slots, 0, 'allocation should have removed every slot access');
});

test('allocation emits far fewer instructions than keeping everything in memory', () => {
  let allocated = 0;
  let inMemory = 0;
  for (const file of programs) {
    const source = readFileSync(join(CORPUS, file), 'utf8');
    const a = generate(compile(source).module);
    const b = generate(compile(source).module, { maxRegisters: 0 });
    allocated += a.funcs.reduce((n, f) => n + f.spans.length, 0);
    inMemory += b.funcs.reduce((n, f) => n + f.spans.length, 0);
  }
  assert.ok(allocated < inMemory * 0.75,
    `expected a substantial cut, got ${inMemory} -> ${allocated}`);
});

test('the pre-fix allocation still generates correct code, and it is not the same code', () => {
  // tools/bench.js measures the cost of skipping void instructions by
  // compiling with `voidIntervals` on and off. If the generator dropped the
  // flag, both sides would be identical and the report would show no cost.
  let differs = 0;
  for (const file of programs) {
    const source = readFileSync(join(CORPUS, file), 'utf8');
    const expected = observationBytes(runProgram(compile(source).program, { maxSteps: 5_000_000 }));
    const before = generate(compile(source).module, { voidIntervals: true });
    const after = generate(compile(source).module);
    const actual = observationBytes(runBytecode(before, { maxSteps: 90_000_000 }));
    assert.equal(decode(actual), decode(expected), `${file} disagrees with void intervals`);
    const size = (b) => b.funcs.reduce((n, f) => n + f.spans.length, 0);
    if (size(before) !== size(after)) differs++;
  }
  assert.ok(differs > 0, 'the flag changed no generated code anywhere in the corpus');
});
