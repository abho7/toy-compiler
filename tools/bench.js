// What register allocation actually bought.
//
//   node tools/bench.js            print the comparison
//   node tools/bench.js --write    also record it in golden/measurements.json
//
// The baseline is the same compiler with zero allocatable registers, which puts
// every value in a frame slot and loads and stores around every instruction --
// the scheme phase 5 shipped, reconstructed through the current generator so
// the comparison stays reproducible after that code is gone. Both sides run the
// same IR through the same optimizer; the only difference is whether values are
// allowed to live in registers.
//
// Instructions executed is the primary figure because it is machine
// independent: the same number on any host, today and in a year. Wall-clock
// time is reported too, as a median of repeated runs, but it is the weaker
// number and is labelled as such.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parse } from '../src/parser.js';
import { analyze } from '../src/sema.js';
import { buildModule } from '../src/ir/build.js';
import { optimize, DEFAULT_PIPELINE } from '../src/opt/passes.js';
import { generate } from '../src/backend/codegen.js';
import { runBytecode } from '../src/vm/vm.js';
import { OP, WORDS_PER_INSTR } from '../src/vm/bytecode.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(ROOT, 'corpus');
const write = process.argv.includes('--write');
const REPEATS = 5;

function compile(source) {
  const { program, diags } = parse(source);
  analyze(program, diags);
  if (diags.failed) throw new Error('program does not compile');
  const module = buildModule(program);
  optimize(module, DEFAULT_PIPELINE);
  return module;
}

function measure(bytecode) {
  const statics = bytecode.funcs.reduce((n, f) => n + f.spans.length, 0);
  let slotOps = 0;
  for (const func of bytecode.funcs) {
    for (let at = 0; at < func.spans.length; at++) {
      const op = func.code[at * WORDS_PER_INSTR];
      if (op === OP.LDSLOT || op === OP.STSLOT) slotOps++;
    }
  }
  const times = [];
  let steps = 0;
  for (let i = 0; i < REPEATS; i++) {
    const started = process.hrtime.bigint();
    const result = runBytecode(bytecode, { maxSteps: 200_000_000 });
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
    steps = result.steps;
  }
  times.sort((a, b) => a - b);
  return { statics, slotOps, steps, ms: times[Math.floor(times.length / 2)] };
}

const rows = [];
for (const file of readdirSync(CORPUS).filter((f) => f.endsWith('.mc')).sort()) {
  const source = readFileSync(join(CORPUS, file), 'utf8');
  const baseline = measure(generate(compile(source), { maxRegisters: 0 }));
  const allocated = measure(generate(compile(source)));
  rows.push({ program: file, baseline, allocated });
}

const sum = (side, key) => rows.reduce((n, r) => n + r[side][key], 0);
const pct = (before, after) => (before ? (100 * (before - after)) / before : 0);

process.stdout.write('register allocation against keeping every value in memory\n\n');
process.stdout.write('  program                   executed (before -> after)     cut    slot ops\n');
for (const r of rows) {
  const cut = `${pct(r.baseline.steps, r.allocated.steps).toFixed(0)}%`;
  process.stdout.write(
    `  ${r.program.padEnd(24)} ${String(r.baseline.steps).padStart(9)} -> ${String(r.allocated.steps).padStart(9)}`
    + `   ${cut.padStart(5)}   ${String(r.baseline.slotOps).padStart(4)} -> ${r.allocated.slotOps}\n`);
}

const totals = {
  staticBefore: sum('baseline', 'statics'),
  staticAfter: sum('allocated', 'statics'),
  executedBefore: sum('baseline', 'steps'),
  executedAfter: sum('allocated', 'steps'),
  slotOpsBefore: sum('baseline', 'slotOps'),
  slotOpsAfter: sum('allocated', 'slotOps'),
};

const worst = rows.reduce((w, r) =>
  (pct(r.baseline.steps, r.allocated.steps) < pct(w.baseline.steps, w.allocated.steps) ? r : w), rows[0]);
const best = rows.reduce((b, r) =>
  (pct(r.baseline.steps, r.allocated.steps) > pct(b.baseline.steps, b.allocated.steps) ? r : b), rows[0]);

process.stdout.write(
  `\n  static instructions: ${totals.staticBefore} -> ${totals.staticAfter}`
  + ` (${pct(totals.staticBefore, totals.staticAfter).toFixed(1)}% fewer)\n`);
process.stdout.write(
  `  executed:            ${totals.executedBefore} -> ${totals.executedAfter}`
  + ` (${pct(totals.executedBefore, totals.executedAfter).toFixed(1)}% fewer)\n`);
process.stdout.write(`  slot instructions:   ${totals.slotOpsBefore} -> ${totals.slotOpsAfter}\n`);
process.stdout.write(
  `\n  best: ${best.program} at ${pct(best.baseline.steps, best.allocated.steps).toFixed(0)}%`
  + `; weakest: ${worst.program} at ${pct(worst.baseline.steps, worst.allocated.steps).toFixed(0)}%\n`);

if (write) {
  const goldenDir = join(ROOT, 'golden');
  if (!existsSync(goldenDir)) mkdirSync(goldenDir, { recursive: true });
  const path = join(goldenDir, 'measurements.json');
  const existing = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  existing.registerAllocation = {
    producedBy: 'node tools/bench.js',
    baseline: 'the same compiler with zero allocatable registers: every value in a frame slot',
    primaryMetric: 'instructions executed, which is machine independent',
    totals,
    staticCutPercent: Number(pct(totals.staticBefore, totals.staticAfter).toFixed(1)),
    executedCutPercent: Number(pct(totals.executedBefore, totals.executedAfter).toFixed(1)),
    best: { program: best.program, cutPercent: Number(pct(best.baseline.steps, best.allocated.steps).toFixed(1)) },
    weakest: { program: worst.program, cutPercent: Number(pct(worst.baseline.steps, worst.allocated.steps).toFixed(1)) },
    perProgram: rows,
    wallClockNote: `median of ${REPEATS} runs, reported per program but not aggregated: it measures this host on this day`,
  };
  writeFileSync(path, `${JSON.stringify(existing, null, 1)}\n`);
  process.stdout.write('\nrecorded in golden/measurements.json\n');
}
