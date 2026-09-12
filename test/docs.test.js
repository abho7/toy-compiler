// The documentation is part of the contract, so it is tested.
//
// docs/semantics.md is what every optimization-correctness argument in this
// project refers to. A trap kind that exists in code but not in that document
// is a behaviour nothing has committed to preserving, and a kind documented
// but not implemented is a promise nothing keeps. Either way the two must
// agree, so this fails when they do not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { TRAP, TRAP_KINDS, MAX_CALL_DEPTH, Trap } from '../src/traps.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('the documents the compiler is written against exist', () => {
  for (const doc of ['docs/semantics.md', 'docs/language.md', 'README.md']) {
    assert.ok(existsSync(join(ROOT, doc)), `${doc} is missing`);
  }
});

test('every trap kind is documented in semantics.md', () => {
  const semantics = read('docs/semantics.md');
  for (const kind of TRAP_KINDS) {
    assert.ok(semantics.includes(`\`${kind}\``), `${kind} is not documented in docs/semantics.md`);
  }
});

test('semantics.md documents no trap kind the code does not implement', () => {
  const semantics = read('docs/semantics.md');
  // Only the table under "## Traps" lists trap kinds. Scanning the whole
  // document is how this test first failed: it picked up `int` and `void` from
  // the table of value types, since a leading code span is not by itself a
  // trap kind.
  const section = semantics.split(/^## /m).find((s) => s.startsWith('Traps\n'));
  assert.ok(section, 'docs/semantics.md has no "## Traps" section');
  const documented = [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
  assert.ok(documented.length > 0, 'found no trap table under "## Traps"');
  for (const kind of documented) {
    assert.ok(TRAP_KINDS.includes(kind), `docs/semantics.md documents ${kind}, which src/traps.js lacks`);
  }
});

test('the documented call-depth limit matches the code', () => {
  assert.ok(read('docs/semantics.md').includes(String(MAX_CALL_DEPTH)),
    `docs/semantics.md does not mention the call depth limit ${MAX_CALL_DEPTH}`);
});

test('trap kinds are distinct, and unknown kinds are refused', () => {
  assert.equal(new Set(TRAP_KINDS).size, TRAP_KINDS.length);
  assert.throws(() => new Trap('not_a_kind', null), /unknown trap kind/);
});

test('a trap prints its kind and where it happened', () => {
  const t = new Trap(TRAP.OUT_OF_BOUNDS, { line: 7, col: 3 }, 'index 9, length 4');
  assert.equal(String(t), 'trap: out_of_bounds at 7:3 (index 9, length 4)');
});
