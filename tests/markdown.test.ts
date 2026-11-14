import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdown } from '../src/lib/markdown.ts';

// A README that lost its newlines (collapsed to spaces) still carries the tokens
// of its block structure, so it must be reflowed rather than rendered as one
// run-on paragraph. This is the shape that produced the broken NKit overview.
const FLATTENED =
  '### NKit  Lossless Nintendo GameCube, Wii, and Wii U disc image toolkit.  ' +
  '- **Restoration** — rebuild a full, byte-identical disc image  ' +
  '- **WUA** — Wii U archive output  #### Usage  ```bash nkit convert ```';

test('reflows a README whose newlines were collapsed to spaces', () => {
  const html = renderMarkdown(FLATTENED);
  assert.match(html, /<h3>NKit<\/h3>/);
  assert.match(html, /<p>Lossless Nintendo GameCube/);
  assert.match(html, /<h4>Usage<\/h4>/);
  assert.match(html, /<li><strong>Restoration<\/strong>/);
  assert.match(html, /<li><strong>WUA<\/strong>/);
  assert.match(html, /<pre><code/);
  // The whole document must not collapse into a single heading.
  assert.equal((html.match(/<h3>/g) ?? []).length, 1);
});

test('leaves a well-formed README untouched', () => {
  const md = '### NKit\n\nA toolkit.\n\n- one\n- two\n\n#### Usage\n\n```bash\nnkit\n```\n';
  const html = renderMarkdown(md);
  assert.match(html, /<h3>NKit<\/h3>/);
  assert.match(html, /<li>one<\/li>/);
  assert.match(html, /<h4>Usage<\/h4>/);
});

test('leaves single-line prose without block markers untouched', () => {
  const md = 'A tiny plugin that does exactly one thing and nothing else.';
  assert.equal(renderMarkdown(md), `<p>${md}</p>\n`);
});

test('still strips script content and event handlers', () => {
  const html = renderMarkdown('## Hi\n\n<script>alert(1)</script>\n\n<a href="javascript:alert(1)">x</a>');
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /javascript:/i);
});

test('renders empty input as an empty string', () => {
  assert.equal(renderMarkdown('   '), '');
});
