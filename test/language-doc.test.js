// The example in the documentation has to parse.
//
// docs/language.md opens with a quicksort, presented as a program a reader can
// write in minic. It is extracted from the document and parsed here, so the
// claim stays true: a grammar change that breaks the documented example fails
// the build rather than quietly making the document wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parse } from '../src/parser.js';
import { render } from '../src/diagnostics.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every ```c fenced block in a markdown file. */
function codeBlocks(markdown) {
  return [...markdown.matchAll(/```c\n([\s\S]*?)```/g)].map((m) => m[1]);
}

test('the quicksort in docs/language.md parses with no diagnostics', () => {
  const blocks = codeBlocks(readFileSync(join(ROOT, 'docs/language.md'), 'utf8'));
  assert.ok(blocks.length > 0, 'docs/language.md has no ```c example');

  const source = blocks[0];
  const { program, diags } = parse(source);
  assert.deepEqual(diags.items.map((d) => render(source, d)), [],
    'the documented example must parse cleanly');

  assert.deepEqual(program.functions.map((f) => `${f.returnType} ${f.name}`),
    ['int partition', 'void quicksort', 'int main']);
  // The pieces that make it a real program rather than a snippet: an array
  // parameter passed by reference, recursion, and a loop with a body.
  assert.deepEqual(program.functions[0].params.map((p) => p.type), ['int[]', 'int', 'int']);
  assert.ok(program.functions[1].body.stmts[0].kind === 'If');
});

test('every complete program in the documentation parses', () => {
  // Not every ```c block is a program. The documentation also shows the array
  // initializer forms as bare declarations, and writes `{ ... }` for a body it
  // is not describing; both are illustrations and neither is meant to compile.
  // So the claim checked here is the one that can be true: every block that
  // declares `main` is a program this compiler accepts.
  let checked = 0;
  for (const doc of ['docs/language.md', 'docs/semantics.md', 'README.md']) {
    const text = readFileSync(join(ROOT, doc), 'utf8');
    for (const [i, source] of codeBlocks(text).entries()) {
      if (!source.includes('int main(')) continue;
      const { diags } = parse(source);
      assert.deepEqual(diags.items.map((d) => render(source, d)), [],
        `${doc}: code block ${i + 1} does not parse`);
      checked++;
    }
  }
  assert.ok(checked > 0, 'found no complete program in the documentation to check');
});
