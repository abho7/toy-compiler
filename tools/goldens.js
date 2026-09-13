// Check, or regenerate, the corpus golden files.
//
//   node tools/goldens.js            check every program against its golden
//   node tools/goldens.js --update   rewrite the goldens from what runs today
//
// --update exists for after a deliberate change to the language or to the
// trailer format. The diff it produces is the thing to review: a golden that
// was regenerated without reading the diff has stopped being evidence of
// anything, since it now says whatever the code says.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

import { runSource, observationBytes, trailerOf } from '../src/interp/ast-interp.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, 'corpus');
const update = process.argv.includes('--update');

const programs = readdirSync(CORPUS).filter((f) => f.endsWith('.mc')).sort();
let failures = 0;
let written = 0;

for (const file of programs) {
  const source = readFileSync(join(CORPUS, file), 'utf8');
  const goldenPath = join(CORPUS, file.replace(/\.mc$/, '.expected'));

  let result;
  try {
    result = runSource(source, { maxSteps: 5_000_000 });
  } catch (error) {
    failures++;
    process.stdout.write(`FAIL ${file}\n  did not compile: ${error.message}\n`);
    continue;
  }

  const actual = Buffer.from(observationBytes(result));

  if (update) {
    writeFileSync(goldenPath, actual);
    written++;
    process.stdout.write(`wrote ${basename(goldenPath)}  (${trailerOf(result)})\n`);
    continue;
  }

  let expected;
  try {
    expected = readFileSync(goldenPath);
  } catch {
    failures++;
    process.stdout.write(`FAIL ${file}\n  no golden file; write one by hand\n`);
    continue;
  }

  if (actual.equals(expected)) {
    process.stdout.write(`ok   ${file.padEnd(26)} ${trailerOf(result)}\n`);
    continue;
  }

  failures++;
  process.stdout.write(`FAIL ${file}\n`);
  const show = (label, buf) => buf.toString('utf8').split('\n')
    .map((line) => `  ${label} ${line}`).join('\n');
  process.stdout.write(`${show('expected', expected)}\n${show('actual  ', actual)}\n`);
}

if (update) {
  process.stdout.write(`\n${written} golden file${written === 1 ? '' : 's'} rewritten. Review the diff.\n`);
  process.exit(0);
}

process.stdout.write(`\n${programs.length - failures}/${programs.length} programs match their golden\n`);
process.exit(failures ? 1 : 0);
