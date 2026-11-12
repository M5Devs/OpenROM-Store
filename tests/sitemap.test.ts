import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SITE_ORIGIN,
  buildSitemapEntries,
  listSitemapPlugins,
  listSitemapPublishers,
  renderSitemap,
  toLastmod,
  type SitemapRow,
} from '../src/lib/sitemap.ts';

// --- Minimal D1 stand-in ----------------------------------------------------
// D1 is an external boundary, so it is faked here; the code under test is real.
// The fake returns canned rows and records the SQL so the tests can assert on it.

interface Capture {
  sql: string;
}

function fakeDb(rows: SitemapRow[], capture: Capture): D1Database {
  return {
    prepare: (sql: string) => {
      capture.sql = sql;
      return { all: async () => ({ results: rows }) };
    },
  } as unknown as D1Database;
}

// --- toLastmod --------------------------------------------------------------

test('toLastmod reduces a D1 timestamp to date precision', () => {
  assert.equal(toLastmod('2026-11-08 15:13:37'), '2026-11-08');
  assert.equal(toLastmod('2026-11-08'), '2026-11-08');
  assert.equal(toLastmod('2026-11-08T15:13:37Z'), '2026-11-08');
});

test('toLastmod drops missing or unparseable values instead of emitting junk', () => {
  assert.equal(toLastmod(null), undefined);
  assert.equal(toLastmod(undefined), undefined);
  assert.equal(toLastmod(''), undefined);
  assert.equal(toLastmod('not-a-date'), undefined);
  assert.equal(toLastmod('2026-13-45 00:00:00'), undefined);
});

// --- renderSitemap ----------------------------------------------------------

test('renderSitemap emits a well-formed urlset with an XML declaration', () => {
  const xml = renderSitemap([{ loc: `${SITE_ORIGIN}/`, priority: '1.0' }]);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'));
  assert.ok(xml.endsWith('</urlset>'));
  assert.ok(xml.includes(`<loc>${SITE_ORIGIN}/</loc>`));
  assert.ok(xml.includes('<priority>1.0</priority>'));
});

test('renderSitemap omits optional elements when absent', () => {
  const xml = renderSitemap([{ loc: `${SITE_ORIGIN}/plugin/nkit` }]);
  assert.ok(!xml.includes('<lastmod>'));
  assert.ok(!xml.includes('<priority>'));
});

test('renderSitemap escapes XML-significant characters in a loc', () => {
  const xml = renderSitemap([{ loc: `${SITE_ORIGIN}/plugin/a&b<c>"d` }]);
  assert.ok(xml.includes('a&amp;b&lt;c&gt;&quot;d'));
  assert.ok(!xml.includes('a&b'));
});

// --- buildSitemapEntries ----------------------------------------------------

const PLUGIN: SitemapRow = { id: 'nkit', created_at: '2026-01-02 03:04:05' };
const PUBLISHER: SitemapRow = { id: 'm5dev', created_at: '2025-12-31 23:59:59' };

test('buildSitemapEntries lists the homepage first with priority 1.0', () => {
  const entries = buildSitemapEntries([PLUGIN], [PUBLISHER]);
  assert.deepEqual(entries[0], { loc: `${SITE_ORIGIN}/`, priority: '1.0' });
});

test('buildSitemapEntries lists the static /publish guide right after the homepage', () => {
  const entries = buildSitemapEntries([PLUGIN], [PUBLISHER]);
  assert.deepEqual(entries[1], { loc: `${SITE_ORIGIN}/publish`, priority: '0.7' });
});

test('buildSitemapEntries emits plugin and publisher URLs from the live rows', () => {
  const entries = buildSitemapEntries([PLUGIN], [PUBLISHER]);
  assert.deepEqual(
    entries.map((entry) => entry.loc),
    [
      `${SITE_ORIGIN}/`,
      `${SITE_ORIGIN}/publish`,
      `${SITE_ORIGIN}/plugin/nkit`,
      `${SITE_ORIGIN}/publisher/m5dev`,
    ],
  );
  assert.equal(entries[2].lastmod, '2026-01-02');
  assert.equal(entries[3].lastmod, '2025-12-31');
});

test('buildSitemapEntries keeps the homepage and /publish for an empty catalog', () => {
  assert.deepEqual(buildSitemapEntries([], []), [
    { loc: `${SITE_ORIGIN}/`, priority: '1.0' },
    { loc: `${SITE_ORIGIN}/publish`, priority: '0.7' },
  ]);
});

test('buildSitemapEntries never emits a route pattern or a private path', () => {
  const xml = renderSitemap(buildSitemapEntries([PLUGIN], [PUBLISHER]));
  assert.ok(!xml.includes('['));
  assert.ok(!xml.includes('/dashboard'));
  assert.ok(!xml.includes('/api/'));
});

test('buildSitemapEntries percent-encodes an id rather than emitting raw characters', () => {
  const entries = buildSitemapEntries([{ id: 'a b/c', created_at: null }], []);
  assert.equal(entries[2].loc, `${SITE_ORIGIN}/plugin/a%20b%2Fc`);
  assert.equal(entries[2].lastmod, undefined);
});

// --- the D1 queries ---------------------------------------------------------

test('listSitemapPlugins selects the id and created_at it needs', async () => {
  const capture: Capture = { sql: '' };
  const rows = await listSitemapPlugins(fakeDb([PLUGIN], capture));
  assert.deepEqual(rows, [PLUGIN]);
  assert.match(capture.sql, /SELECT id, created_at FROM plugins/);
  assert.ok(!capture.sql.includes('updated_at'), 'schema has no updated_at column');
});

test('listSitemapPublishers selects the id and created_at it needs', async () => {
  const capture: Capture = { sql: '' };
  const rows = await listSitemapPublishers(fakeDb([PUBLISHER], capture));
  assert.deepEqual(rows, [PUBLISHER]);
  assert.match(capture.sql, /SELECT id, created_at FROM publishers/);
});

test('the sitemap queries do not filter on a moderation column that does not exist', async () => {
  const capture: Capture = { sql: '' };
  await listSitemapPlugins(fakeDb([], capture));
  assert.ok(!/approved|status|pending/i.test(capture.sql));
});
