// The SECURITY.md that `init` writes into every vault is where the lint finding
// for a secret and the push gate send a person under stress. It must point to
// the step-by-step page, by an absolute URL (the vault does not contain the
// kit's docs), in both languages, and the example vault must show the same text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE_URL = 'https://github.com/aleckyann/brain-kit/blob/main/docs/incident-response.md';

for (const lang of ['en', 'pt-BR']) {
  test(`the ${lang} vault SECURITY template points to the incident-response page`, () => {
    const text = readFileSync(join(ROOT, 'lang', lang, 'vault', 'SECURITY.md'), 'utf8');
    assert.ok(text.includes('docs/incident-response.md'), 'the template names the page');
    assert.ok(text.includes(PAGE_URL), 'the template links the page by its absolute URL');
  });
}

test('the example vault shows the same pointer as the template it was built from', () => {
  const text = readFileSync(join(ROOT, 'examples', 'minimal-vault', 'SECURITY.md'), 'utf8');
  assert.ok(text.includes(PAGE_URL), 'the example vault SECURITY.md carries the link');
});

test('the page the templates point to exists in this repository', () => {
  const page = readFileSync(join(ROOT, 'docs', 'incident-response.md'), 'utf8');
  assert.ok(page.length > 1000, 'docs/incident-response.md is a real page');
});
