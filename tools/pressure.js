// Register pressure across the corpus.
//
//   node tools/pressure.js            print the table
//   node tools/pressure.js --write    also record it in golden/measurements.json
//
// Peak pressure is the largest number of values live at any one point in a
// function. It is a property of the program, not of the machine, so it decides
// whether allocation has anything interesting to do: a function whose peak is
// below the register file never spills, however the allocator is written.
//
// This exists because the answer turned out to matter. Nothing in the corpus
// comes close to filling the register file, so the spill path never runs on
// real input, and any claim phase 9 makes about what allocation bought has to
// say so rather than implying the allocator is making hard choices.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parse } from '../src/parser.js';
import { analyze } from '../src/sema.js';
import { buildModule } from '../src/ir/build.js';
import { optimize, DEFAULT_PIPELINE } from '../src/opt/passes.js';
import { splitCriticalEdges } from '../src/backend/linearize.js';
import { liveIntervals, allocate, allocatableRegisters } from '../src/backend/regalloc.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, 'corpus');
const write = process.argv.includes('--write');

const rows = [];
for (const file of readdirSync(CORPUS).filter((f) => f.endsWith('.mc')).sort()) {
  const source = readFileSync(join(CORPUS, file), 'utf8');
  const { program, diags } = parse(source);
  analyze(program, diags);
  if (diags.failed) {
    process.stderr.write(`${file} does not compile\n`);
    process.exit(1);
  }
  const module = buildModule(program);
  optimize(module, DEFAULT_PIPELINE);

  for (const func of module.funcs.values()) {
    splitCriticalEdges(func);
    const { order, intervals } = liveIntervals(func);
    let peak = 0;
    for (let p = 0; p <= order.length; p++) {
      const live = intervals.filter((iv) => iv.start <= p && p <= iv.end).length;
      if (live > peak) peak = live;
    }
    const available = allocatableRegisters(func);
    const result = allocate(func);
    rows.push({
      program: file,
      func: func.name,
      values: intervals.length,
      peak,
      available: available.registers.length,
      reserved: available.reservedForArgs,
      spills: result.spills,
      registersUsed: result.registersUsed,
      // The same allocation with void instructions given intervals, as the
      // allocator did before it learned to skip them. Measured, not remembered.
      registersUsedWithVoidIntervals: allocate(func, { voidIntervals: true }).registersUsed,
    });
  }
}

rows.sort((a, b) => b.peak - a.peak);

process.stdout.write('peak simultaneous live values, highest first\n\n');
for (const r of rows) {
  const head = `${r.program}:${r.func}`;
  process.stdout.write(
    `  ${head.padEnd(34)} peak ${String(r.peak).padStart(2)} of ${String(r.available).padStart(2)}`
    + `   ${String(r.values).padStart(3)} values   ${r.spills} spilled\n`);
}

const peaks = rows.map((r) => r.peak).sort((a, b) => a - b);
const summary = {
  producedBy: 'node tools/pressure.js',
  functions: rows.length,
  peakPressure: peaks[peaks.length - 1],
  peakAt: `${rows[0].program}:${rows[0].func}`,
  medianPeak: peaks[Math.floor(peaks.length / 2)],
  allocatableRegisters: rows[0].available,
  totalSpillsAtNaturalRegisterFile: rows.reduce((n, r) => n + r.spills, 0),
  registersUsed: {
    withVoidIntervals: rows.reduce((n, r) => n + r.registersUsedWithVoidIntervals, 0),
    withoutVoidIntervals: rows.reduce((n, r) => n + r.registersUsed, 0),
    functionsThatUseFewer: rows.filter((r) => r.registersUsed < r.registersUsedWithVoidIntervals).length,
  },
  note: 'No corpus function fills the register file, so the spill path never runs on this input. '
    + 'It is exercised by squeezing the register set in test/regalloc.test.js.',
};

process.stdout.write(`\npeak ${summary.peakPressure} at ${summary.peakAt}; median ${summary.medianPeak}; `);
process.stdout.write(`${summary.totalSpillsAtNaturalRegisterFile} spills across ${summary.functions} functions\n`);
const used = summary.registersUsed;
process.stdout.write(`registers used: ${used.withVoidIntervals} with void intervals, ${used.withoutVoidIntervals} without `
  + `(${used.functionsThatUseFewer} functions use fewer)\n`);

if (write) {
  const goldenDir = join(ROOT, 'golden');
  if (!existsSync(goldenDir)) mkdirSync(goldenDir, { recursive: true });
  const path = join(goldenDir, 'measurements.json');
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  existing.registerPressure = { ...summary, perFunction: rows };
  writeFileSync(path, `${JSON.stringify(existing, null, 1)}\n`);
  process.stdout.write(`\nrecorded in golden/measurements.json\n`);
}
