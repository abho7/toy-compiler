// The stepper is the same VM, so it has to produce the same answers.
//
// createStepper exists for the playground, which needs the machine state
// between two instructions. The risk it introduces is drift: a stepping path
// that diverges from the run path would make the page show something the tests
// never check, and every claim on that page would be about a different
// machine.
//
// So the claim tested here is equivalence, on the whole corpus: stepping a
// program to completion produces the same observable behaviour *and* the same
// step count as running it. Step count is not observable behaviour -- the
// interpreters legitimately disagree about it -- but between these two it must
// match exactly, because they are meant to be one implementation.
//
// Paired with the equivalence, as this project's habit: assertions that the
// stepper actually advances. Equivalence alone could be satisfied by a stepper
// that reported "finished" immediately on a program that happened to do
// nothing.

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
import { runBytecode, createStepper } from '../src/vm/vm.js';
import { observationBytes, trailerOf } from '../src/interp/ast-interp.js';
import { REGISTERS } from '../src/vm/bytecode.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, 'corpus');
const programs = readdirSync(CORPUS).filter((f) => f.endsWith('.mc')).sort();
const BUDGET = 60_000_000;

function compile(source) {
  const { program, diags } = parse(source);
  analyze(program, diags);
  assert.deepEqual(diags.items.map((d) => d.message), [], 'the program must compile');
  const module = buildModule(program);
  optimize(module, DEFAULT_PIPELINE);
  return generate(module);
}

/** Drive a stepper to completion and report it the way runBytecode does. */
function stepToEnd(bytecode, { maxSteps = BUDGET } = {}) {
  const stepper = createStepper(bytecode, { maxSteps });
  let state = stepper.state();
  let guard = 0;
  while (!state.finished) {
    state = stepper.step();
    if (++guard > maxSteps + 10) throw new Error('stepper never finished');
  }
  return {
    output: state.output,
    outcome: state.finished.outcome,
    status: state.finished.status,
    trap: state.finished.trap,
    steps: state.steps,
  };
}

for (const file of programs) {
  test(`stepping agrees with running: ${file}`, () => {
    const source = readFileSync(join(CORPUS, file), 'utf8');
    const ran = runBytecode(compile(source), { maxSteps: BUDGET });
    const stepped = stepToEnd(compile(source));

    // Text first so a failure is readable, then bytes, which is the claim.
    assert.equal(new TextDecoder().decode(observationBytes(stepped)),
      new TextDecoder().decode(observationBytes(ran)),
      `${file}: the stepper disagrees with the run loop`);
    assert.ok(Buffer.from(observationBytes(stepped)).equals(Buffer.from(observationBytes(ran))),
      `${file}: stepped bytes differ`);
    assert.equal(stepped.steps, ran.steps,
      `${file}: ${ran.steps} steps when run, ${stepped.steps} when stepped`);
  });
}

test('the stepper advances, rather than reporting the end immediately', () => {
  // The "does do Y" half. A stepper that finished at once would pass every
  // equivalence test above on any program that produces no output.
  const bytecode = compile('int main() {\n  int n = 0;\n  for (int i = 0; i < 4; i = i + 1) {\n'
    + '    n = n + i;\n  }\n  print(n);\n  return 0;\n}\n');
  const stepper = createStepper(bytecode, { maxSteps: BUDGET });

  const first = stepper.state();
  assert.equal(first.steps, 0, 'a fresh stepper has taken no steps');
  assert.equal(first.finished, null, 'a fresh stepper is not finished');
  assert.equal(first.func.name, 'main', 'execution starts in main');
  assert.equal(first.pc, 0, 'execution starts at the first instruction');
  assert.equal(first.regs.length, REGISTERS, 'every register is reported');

  const afterOne = stepper.step();
  assert.equal(afterOne.steps, 1, 'one step was taken');

  // Somewhere in the middle: still running, and the program counter has moved.
  let state = afterOne;
  for (let i = 0; i < 8; i++) state = stepper.step();
  assert.equal(state.steps, 9);
  assert.ok(!state.finished, 'this program takes more than nine instructions');

  const positions = new Set();
  while (!state.finished) {
    positions.add(state.pc);
    state = stepper.step();
  }
  assert.ok(positions.size > 5, `the program counter only ever held ${positions.size} values`);
  assert.equal(state.finished.outcome, 'exit');
  assert.equal(new TextDecoder().decode(state.output), '6\n', 'the loop summed 0+1+2+3');
});

test('a trap reaches the stepper as a trap, at the same place', () => {
  const source = readFileSync(join(CORPUS, 'trap-div-zero.mc'), 'utf8');
  const ran = runBytecode(compile(source), { maxSteps: BUDGET });
  const stepped = stepToEnd(compile(source));

  assert.equal(ran.outcome, 'trap', 'the corpus program is supposed to trap');
  assert.equal(stepped.outcome, 'trap');
  assert.equal(stepped.trap.kind, ran.trap.kind);
  assert.equal(trailerOf(stepped), trailerOf(ran), 'the trap position must match too');
});

test('the step budget stops a stepper, and says so', () => {
  // The budget is a tooling limit, never a behaviour: it has to be reported as
  // its own outcome rather than as a trap or a clean exit.
  const bytecode = compile('int main() {\n  for (int i = 0; i < 100; i = i + 1) {\n'
    + '    print(i);\n  }\n  return 0;\n}\n');
  const stepper = createStepper(bytecode, { maxSteps: 5 });

  let state = stepper.state();
  for (let i = 0; i < 20 && !state.finished; i++) state = stepper.step();

  assert.equal(state.finished.outcome, 'budget');
  assert.equal(state.finished.trap, null, 'an exhausted budget is not a trap');
  assert.equal(state.finished.status, null, 'an exhausted budget is not a clean exit');
});

test('the state describes the machine, not just whether it finished', () => {
  // The playground renders these, so an empty or mis-shaped state would show a
  // blank pane rather than fail anything.
  const bytecode = compile('int add(int a, int b) {\n  return a + b;\n}\n\n'
    + 'int main() {\n  int xs[2] = {7, 9};\n  print(add(xs[0], xs[1]));\n  return 0;\n}\n');
  const stepper = createStepper(bytecode, { maxSteps: BUDGET });

  let state = stepper.state();
  let deepest = state;
  while (!state.finished) {
    state = stepper.step();
    if (!state.finished && state.depth > deepest.depth) deepest = state;
  }

  assert.ok(deepest.depth >= 2, 'the call into add should have been visible as depth 2');
  assert.equal(deepest.stack.length, deepest.depth, 'the reported stack matches the depth');
  assert.equal(deepest.stack[0].name, 'add', 'the innermost frame is the callee');
  assert.equal(deepest.stack[deepest.stack.length - 1].name, 'main', 'the outermost frame is main');
  assert.ok(deepest.arrays.length >= 1, 'the array the program allocated is reported');
  assert.deepEqual(deepest.arrays[0], [7, 9], 'and it holds what the program put in it');
  assert.equal(new TextDecoder().decode(state.output), '16\n');
});
