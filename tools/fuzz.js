// The randomized differential campaign.
//
//   node tools/fuzz.js                          1000 programs from seed 1
//   node tools/fuzz.js --programs=100000        a long campaign
//   node tools/fuzz.js --seed=5000 --thorough   every pass alone as well
//   node tools/fuzz.js --programs=500 --quiet   just the summary
//
// Every program is generated from a seed, run through the reference
// interpreter, and compared byte for byte against the IR interpreter and the VM
// at each optimization configuration. A disagreement is shrunk to a minimal
// reproducer and written to failures/, so it can become a regression test.
//
// Exit status is 0 when everything agreed and 1 when anything did not, so this
// is usable as a gate.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { generateProgram, printProgram } from '../src/testing/random-program.js';
import { checkSource, mismatchSignature, QUICK, THOROUGH } from '../src/testing/differential.js';
import { shrinkProgram, programSize } from '../src/testing/shrink.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const flag = (name) => process.argv.includes(`--${name}`);
const option = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? Number(found.slice(name.length + 3)) : fallback;
};

const programs = option('programs', 1000);
const firstSeed = option('seed', 1);
const thorough = flag('thorough');
const quiet = flag('quiet');
const shrinking = !flag('no-shrink');
const configurations = thorough ? THOROUGH : QUICK;

const write = (text) => process.stdout.write(text);

const outcomes = new Map();
const failures = [];
let agreed = 0;
let skipped = 0;
let compileErrors = 0;
let outputTotal = 0;

const started = Date.now();

for (let i = 0; i < programs; i++) {
  const seed = firstSeed + i;
  const source = printProgram(generateProgram(seed));
  const result = checkSource(source, { configurations });

  if (result.status === 'agree') {
    agreed++;
    outputTotal += result.outputBytes;
    outcomes.set(result.outcome, (outcomes.get(result.outcome) ?? 0) + 1);
  } else if (result.status === 'skipped') {
    skipped++;
  } else if (result.status === 'compile-error') {
    // The generator's claim is that this cannot happen, so it is loud.
    compileErrors++;
    failures.push({ seed, kind: 'compile-error', detail: result.messages.join('; '), source });
    if (!quiet) write(`\nseed ${seed}: GENERATED PROGRAM DOES NOT COMPILE\n  ${result.messages.join('\n  ')}\n`);
  } else {
    failures.push(recordMismatch(seed, source, result));
  }

  if (!quiet && (i + 1) % 500 === 0) {
    const rate = Math.round((i + 1) / ((Date.now() - started) / 1000));
    write(`  ${i + 1}/${programs}  ${failures.length} failing  ${rate}/s\n`);
  }
}

// ------------------------------------------------------------------ report --

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
write(`\n${programs} programs from seed ${firstSeed}, `);
write(`${configurations.length} configurations each, in ${elapsed}s\n\n`);
write(`  agreed          ${agreed}\n`);
write(`  skipped         ${skipped}   (the reference ran out of budget)\n`);
write(`  did not compile ${compileErrors}\n`);
write(`  DISAGREED       ${failures.length - compileErrors}\n`);

if (agreed) {
  write('\noutcomes\n');
  for (const [kind, count] of [...outcomes].sort((a, b) => b[1] - a[1])) {
    write(`  ${kind.padEnd(16)} ${String(count).padStart(6)}  ${((100 * count) / agreed).toFixed(1)}%\n`);
  }
  write(`\n  mean output ${Math.round(outputTotal / agreed)} bytes\n`);
}

if (failures.length) {
  write(`\n${failures.length} failure(s) written to failures/\n`);
  for (const failure of failures) write(`  seed ${failure.seed}: ${failure.kind} ${failure.detail}\n`);
  process.exit(1);
}

write('\nno disagreements.\n');
process.exit(0);

// -------------------------------------------------------------- mismatches --

function recordMismatch(seed, source, result) {
  const signature = mismatchSignature(result);
  if (!quiet) write(`\nseed ${seed}: DISAGREEMENT at ${signature}\n  ${result.detail}\n`);

  let minimal = source;
  let reported = result;
  let shrinkNote = 'not shrunk';
  if (shrinking) {
    const before = programSize(generateProgram(seed));
    // The same disagreement, not merely some disagreement: a reduced program
    // that fails differently is a different bug wearing this one's seed.
    const stillFails = (model) => {
      const attempt = checkSource(printProgram(model), { configurations });
      return mismatchSignature(attempt) === signature;
    };
    const shrunk = shrinkProgram(generateProgram(seed), stillFails);
    const after = programSize(shrunk.model);
    minimal = printProgram(shrunk.model);
    // The header has to describe the program printed beneath it, not the sixty
    // line one it came from. They disagree about where the trap is, because the
    // shrunk program has different line numbers, and a reproducer whose comment
    // contradicts its own source is worse than no comment at all.
    reported = checkSource(minimal, { configurations });
    shrinkNote = `${before.statements} statements -> ${after.statements}, `
      + `${before.functions} functions -> ${after.functions} `
      + `(${shrunk.accepted} reductions accepted of ${shrunk.tried} tried)`;
    if (!quiet) write(`  shrunk: ${shrinkNote}\n`);
  }

  const dir = join(ROOT, 'failures');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const header = [
    `// seed ${seed}`,
    `// disagreement: ${signature}`,
    `// ${reported.detail ?? result.detail}`,
    `// ${shrinkNote}`,
    '',
  ].join('\n');
  writeFileSync(join(dir, `seed-${seed}.mc`), `${header}${minimal}`);
  if (reported.expected !== undefined) {
    writeFileSync(join(dir, `seed-${seed}.diff`),
      `expected (reference interpreter):\n${reported.expected}\n\nactual (${signature}):\n${reported.actual}\n`);
  }

  return { seed, kind: `disagreement at ${signature}:`, detail: result.detail, source: minimal };
}
