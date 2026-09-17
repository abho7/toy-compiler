// What the optimizer actually bought, measured two ways.
//
//   node tools/bench.js            print both comparisons
//   node tools/bench.js --write    also record them in golden/measurements.json
//
// The first comparison holds the passes fixed and varies register allocation.
// The second holds allocation fixed and varies the passes. They answer
// different questions and are kept apart rather than rolled into one number.
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
import { optimize, PASSES, DEFAULT_PIPELINE } from '../src/opt/passes.js';
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

// ---------------------------------------------------------------------------
// What each optimization pass buys, which is a different question.
//
// The comparison above holds the optimizer fixed and varies register
// allocation. This one holds allocation fixed at its natural register file and
// varies the passes: none at all, each pass alone, and the whole pipeline.
// Every configuration is compiled and run the same way, so the only difference
// is which rewrites happened to the IR.
//
// Each pass is measured alone even where that is not how it would ever ship.
// Copy propagation alone has almost nothing to do, because what creates the
// trivial phis it removes is constant folding -- and reporting that plainly is
// the point. A pass whose contribution is invisible here is one whose place in
// the pipeline rests entirely on the passes around it, which is worth knowing.

const PASS_CONFIGS = [
  ['O0', []],
  ...Object.keys(PASSES).map((name) => [name, [name]]),
  ['fold+copyprop', ['fold', 'copyprop']],
  ['all', [...DEFAULT_PIPELINE]],
];

/** Compile with an explicit pass list, reporting how much the passes changed. */
function compileWith(source, passes) {
  const { program, diags } = parse(source);
  analyze(program, diags);
  if (diags.failed) throw new Error('program does not compile');
  const module = buildModule(program);
  const report = passes.length ? optimize(module, passes) : [];
  return { module, irChanges: report.reduce((n, r) => n + r.changed, 0) };
}

/** Static size, spills and executed instructions for one build. */
function measureBuild(bytecode) {
  const statics = bytecode.funcs.reduce((n, f) => n + f.spans.length, 0);
  const spills = bytecode.funcs.reduce((n, f) => n + (f.spills ?? 0), 0);
  const times = [];
  let steps = 0;
  for (let i = 0; i < REPEATS; i++) {
    const started = process.hrtime.bigint();
    const result = runBytecode(bytecode, { maxSteps: 200_000_000 });
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
    steps = result.steps;
  }
  times.sort((a, b) => a - b);
  return { statics, spills, steps, ms: times[Math.floor(times.length / 2)] };
}

const passPerProgram = [];
const passTotals = new Map(PASS_CONFIGS.map(([name]) => [name,
  { statics: 0, steps: 0, spills: 0, irChanges: 0 }]));

for (const file of readdirSync(CORPUS).filter((f) => f.endsWith('.mc')).sort()) {
  const source = readFileSync(join(CORPUS, file), 'utf8');
  const byConfiguration = {};
  for (const [name, passes] of PASS_CONFIGS) {
    const { module, irChanges } = compileWith(source, passes);
    const measured = measureBuild(generate(module));
    byConfiguration[name] = { ...measured, irChanges };
    const total = passTotals.get(name);
    total.statics += measured.statics;
    total.steps += measured.steps;
    total.spills += measured.spills;
    total.irChanges += irChanges;
  }
  passPerProgram.push({ program: file, byConfiguration });
}

const zero = passTotals.get('O0');
const passRows = PASS_CONFIGS.map(([name]) => {
  const t = passTotals.get(name);
  return {
    configuration: name,
    statics: t.statics,
    executed: t.steps,
    spills: t.spills,
    irChanges: t.irChanges,
    staticCutPercent: Number(pct(zero.statics, t.statics).toFixed(1)),
    executedCutPercent: Number(pct(zero.steps, t.steps).toFixed(1)),
  };
});

// Per program, so the aggregate cannot hide a spread. The corpus total is
// dominated by whichever program runs longest, and a single number that happens
// to be that program's number is not a result about the optimizer.
const passCut = (row) => pct(row.byConfiguration.O0.steps, row.byConfiguration.all.steps);
const passBest = passPerProgram.reduce((b, r) => (passCut(r) > passCut(b) ? r : b), passPerProgram[0]);
const passWorst = passPerProgram.reduce((w, r) => (passCut(r) < passCut(w) ? r : w), passPerProgram[0]);

process.stdout.write('\n\nwhat each pass buys, against the same compiler with no passes at all\n\n');
process.stdout.write('  configuration     static    executed     cut   spills   IR changes\n');
for (const r of passRows) {
  const cut = r.configuration === 'O0' ? '-' : `${r.executedCutPercent.toFixed(1)}%`;
  process.stdout.write(
    `  ${r.configuration.padEnd(16)} ${String(r.statics).padStart(6)} ${String(r.executed).padStart(11)}`
    + `  ${cut.padStart(6)}  ${String(r.spills).padStart(6)}   ${String(r.irChanges).padStart(6)}\n`);
}

// The honest part: a pass that rewrote instructions but did not make the
// program do less work has not earned anything the benchmark can see.
const inert = passRows.filter((r) => r.configuration !== 'O0' && r.executedCutPercent <= 0);
const fired = passRows.filter((r) => r.configuration !== 'O0' && r.irChanges === 0);
process.stdout.write('\n');
for (const r of inert) {
  process.stdout.write(
    `  note: ${r.configuration} changed ${r.irChanges} IR instructions and executed `
    + `${r.executedCutPercent <= 0 ? 'no fewer' : 'fewer'} instructions than O0\n`);
}
for (const r of fired) {
  process.stdout.write(`  note: ${r.configuration} changed nothing at all on this corpus\n`);
}
if (!inert.length && !fired.length) {
  process.stdout.write('  every configuration both fired and reduced work.\n');
}

process.stdout.write(
  `\n  best: ${passBest.program} at ${passCut(passBest).toFixed(1)}%`
  + `; weakest: ${passWorst.program} at ${passCut(passWorst).toFixed(1)}%\n`);
process.stdout.write(
  `  static size ${zero.statics} -> ${passTotals.get('all').statics}`
  + ` (${pct(zero.statics, passTotals.get('all').statics).toFixed(1)}% fewer), `
  + `but executed only ${pct(zero.steps, passTotals.get('all').steps).toFixed(1)}% fewer.\n`
  + '  None of these four passes optimizes across an iteration or a call, and the corpus spends\n'
  + '  almost every instruction inside a loop or a recursive call.\n');

// ---------------------------------------------------------------------------
// What it cost to stop giving void instructions a register.
//
// tools/pressure.js records the saving: fewer registers used. This records the
// price, which lands in the code. A shorter interval list hands the linear scan
// a different free-register order, and some functions end up with assignments
// that need more copies at phi edges. The two sides differ only in the
// allocator's `voidIntervals` flag, so every difference below is that filter's.

const countMoves = (bytecode) => {
  let moves = 0;
  for (const func of bytecode.funcs) {
    for (let at = 0; at < func.spans.length; at++) {
      if (func.code[at * WORDS_PER_INSTR] === OP.MOVE) moves++;
    }
  }
  return moves;
};

const measureFilterSide = (bytecode) => ({
  statics: bytecode.funcs.reduce((n, f) => n + f.spans.length, 0),
  moves: countMoves(bytecode),
  steps: runBytecode(bytecode, { maxSteps: 200_000_000 }).steps,
});

const filterTotals = {
  withVoidIntervals: { statics: 0, moves: 0, steps: 0 },
  withoutVoidIntervals: { statics: 0, moves: 0, steps: 0 },
};
const filterChanged = [];
for (const file of readdirSync(CORPUS).filter((f) => f.endsWith('.mc')).sort()) {
  const source = readFileSync(join(CORPUS, file), 'utf8');
  const before = measureFilterSide(generate(compile(source), { voidIntervals: true }));
  const after = measureFilterSide(generate(compile(source)));
  for (const key of ['statics', 'moves', 'steps']) {
    filterTotals.withVoidIntervals[key] += before[key];
    filterTotals.withoutVoidIntervals[key] += after[key];
  }
  if (before.statics !== after.statics || before.moves !== after.moves || before.steps !== after.steps) {
    filterChanged.push({ program: file, withVoidIntervals: before, withoutVoidIntervals: after });
  }
}

const fb = filterTotals.withVoidIntervals;
const fa = filterTotals.withoutVoidIntervals;
process.stdout.write('\n\nwhat skipping void instructions in allocation cost, in code\n\n');
process.stdout.write(`  moves:               ${fb.moves} -> ${fa.moves}\n`);
process.stdout.write(`  static instructions: ${fb.statics} -> ${fa.statics}\n`);
process.stdout.write(`  executed:            ${fb.steps} -> ${fa.steps}\n`);
for (const r of filterChanged) {
  const [b, a] = [r.withVoidIntervals, r.withoutVoidIntervals];
  process.stdout.write(`  ${r.program.padEnd(24)} moves ${b.moves} -> ${a.moves}, `
    + `static ${b.statics} -> ${a.statics}, executed ${b.steps} -> ${a.steps}\n`);
}
process.stdout.write(`  ${filterChanged.length} of ${rows.length} programs compile differently; the rest are unchanged\n`);

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
  existing.optimizationPasses = {
    producedBy: 'node tools/bench.js --write',
    baseline: 'the same compiler with no optimization passes, register allocation on in both',
    primaryMetric: 'instructions executed, which is machine independent',
    configurations: passRows,
    perProgram: passPerProgram,
    best: { program: passBest.program, cutPercent: Number(passCut(passBest).toFixed(1)) },
    weakest: { program: passWorst.program, cutPercent: Number(passCut(passWorst).toFixed(1)) },
    inert: inert.map((r) => r.configuration),
    finding: 'The four passes cut static code size by '
      + `${pct(zero.statics, passTotals.get('all').statics).toFixed(1)}% but executed instructions by only `
      + `${pct(zero.steps, passTotals.get('all').steps).toFixed(1)}%. None of them optimizes across an `
      + 'iteration or a call -- there is no loop-invariant code motion, no strength reduction, no '
      + 'unrolling, no inlining -- so a program whose time goes into a loop or a recursive call gets '
      + 'nothing. The aggregate is dominated by exactly those programs. Per program the passes cut '
      + 'about half the work from small straight-line code and nothing at all from the hot ones, '
      + 'which is why the per-program table matters more than the total. Register allocation, '
      + 'measured separately, is where this compiler\'s dynamic win actually comes from.',
    note: 'Each pass is measured alone as well as in the pipeline. A pass that reduces nothing on '
      + 'its own is reported as such rather than omitted: copy propagation removes trivial phis, '
      + 'and what creates them is constant folding.',
    wallClockNote: `median of ${REPEATS} runs, per program, not aggregated: it measures this host on this day`,
  };
  existing.voidIntervalFilter = {
    producedBy: 'node tools/bench.js --write',
    compares: 'the allocator giving void instructions a register, against skipping them; nothing else differs',
    totals: filterTotals,
    programs: rows.length,
    changed: filterChanged,
  };
  writeFileSync(path, `${JSON.stringify(existing, null, 1)}\n`);
  process.stdout.write('\nrecorded in golden/measurements.json\n');
}
