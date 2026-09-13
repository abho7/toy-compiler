// Every corpus program against its golden, byte for byte.
//
// This is the baseline the whole project is built on: once the IR interpreter
// and the VM exist, they run these same programs and must produce the same
// bytes, at every optimization level. A mismatch here means the reference
// interpreter and the hand-written expectation disagree, and one of them is
// wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runSource, observationBytes } from '../src/interp/ast-interp.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, 'corpus');

const programs = readdirSync(CORPUS).filter((f) => f.endsWith('.mc')).sort();

test('the corpus exists and every program has a golden', () => {
  assert.ok(programs.length >= 15, `only ${programs.length} programs in the corpus`);
  for (const file of programs) {
    const golden = join(CORPUS, file.replace(/\.mc$/, '.expected'));
    assert.ok(existsSync(golden), `${file} has no .expected`);
  }
});

for (const file of programs) {
  test(`corpus: ${file}`, () => {
    const source = readFileSync(join(CORPUS, file), 'utf8');
    const expected = readFileSync(join(CORPUS, file.replace(/\.mc$/, '.expected')));
    // Generous but finite: a corpus program that needs more than this has a
    // bug. Exhausting it needs no separate assertion -- it appears as a
    // `=== budget exceeded` trailer and fails the comparison below.
    const result = runSource(source, { maxSteps: 5_000_000 });
    const actual = Buffer.from(observationBytes(result));

    // Compared as text first, so a failure shows a readable diff, then as
    // bytes, which catches trailing whitespace and line-ending damage that a
    // string comparison would forgive.
    assert.equal(actual.toString('utf8'), expected.toString('utf8'));
    assert.ok(actual.equals(expected), `${file}: bytes differ from the golden`);
  });
}
