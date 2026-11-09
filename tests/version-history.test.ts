import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compareVersions, formatReleaseDate, isNewerVersion } from '../src/lib/version.ts';
import {
  listPluginVersions,
  getVersionDownloadUrl,
  type PluginVersionRow,
} from '../src/lib/db.ts';

// --- Minimal D1 stand-in ----------------------------------------------------
// D1 is an external boundary, so it is faked here; the code under test is real.
// The fake records the SQL and bound values so the tests can assert on how the
// query is built (the plugin id must be *bound*, never spliced into the text).

interface Capture {
  sql: string;
  bindings: unknown[];
}

function fakeDb(rows: PluginVersionRow[], capture: Capture): D1Database {
  const statement = (sql: string) => ({
    bind: (...values: unknown[]) => {
      capture.sql = sql;
      capture.bindings = values;
      return {
        all: async () => ({ results: rows }),
        first: async () => rows[0] ?? null,
      };
    },
    all: async () => ({ results: rows }),
    first: async () => rows[0] ?? null,
  });
  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}

function versionRow(overrides: Partial<PluginVersionRow> = {}): PluginVersionRow {
  return {
    id: 1,
    plugin_id: 'anime-tsundere',
    version: '2.0.0',
    min_core_version: '4.0.0',
    download_url: 'https://example.test/anime-tsundere-2.0.0.orskin',
    sha256: '45f4',
    created_at: '2026-11-08 15:13:37',
    ...overrides,
  };
}

// --- compareVersions --------------------------------------------------------

test('compareVersions orders numeric segments, not lexicographically', () => {
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0);
  assert.ok(compareVersions('1.9.0', '1.10.0') < 0);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
});

test('compareVersions pads missing segments with zero (1.0 == 1.0.0)', () => {
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.ok(compareVersions('1.0', '1.0.1') < 0);
  assert.ok(compareVersions('1.1', '1.0.9') > 0);
});

test('compareVersions ranks a pre-release below its bare release', () => {
  assert.ok(compareVersions('2.0.0-rc.1', '2.0.0') < 0);
  assert.ok(compareVersions('2.0.0', '2.0.0-rc.1') > 0);
  assert.ok(compareVersions('2.0.0-rc.1', '2.0.0-rc.2') < 0);
});

test('isNewerVersion reports strictly newer only', () => {
  assert.equal(isNewerVersion('2.0.0', '1.0.0'), true);
  assert.equal(isNewerVersion('1.0.0', '1.0.0'), false);
  assert.equal(isNewerVersion('1.0.0', '2.0.0'), false);
});

// --- formatReleaseDate ------------------------------------------------------

test('formatReleaseDate renders a D1 UTC timestamp without drifting the day', () => {
  assert.equal(formatReleaseDate('2026-11-08 15:13:37'), 'Nov 8, 2026');
  assert.equal(formatReleaseDate('2026-01-01 00:00:00'), 'Jan 1, 2026');
  // Late-evening UTC must not roll forward — the parser pins the day to UTC.
  assert.equal(formatReleaseDate('2026-11-08 23:59:59'), 'Nov 8, 2026');
});

test('formatReleaseDate accepts ISO strings and passes through unknown input', () => {
  assert.equal(formatReleaseDate('2026-11-08T15:13:37Z'), 'Nov 8, 2026');
  assert.equal(formatReleaseDate('not-a-date'), 'not-a-date');
  assert.equal(formatReleaseDate(''), '');
  assert.equal(formatReleaseDate(null), '');
});

// --- listPluginVersions -----------------------------------------------------

test('listPluginVersions binds the plugin id and selects from plugin_versions', async () => {
  const capture: Capture = { sql: '', bindings: [] };
  await listPluginVersions(fakeDb([versionRow()], capture), 'anime-tsundere');

  assert.match(capture.sql, /FROM plugin_versions/);
  assert.deepEqual(capture.bindings, ['anime-tsundere']);
});

test('listPluginVersions sorts releases newest first by version, not row order', async () => {
  const capture: Capture = { sql: '', bindings: [] };
  const rows = [
    versionRow({ id: 1, version: '1.0.0', created_at: '2026-10-01 00:00:00' }),
    versionRow({ id: 2, version: '1.10.0', created_at: '2026-11-01 00:00:00' }),
    versionRow({ id: 3, version: '1.9.0', created_at: '2026-10-15 00:00:00' }),
  ];
  const versions = await listPluginVersions(fakeDb(rows, capture), 'anime-tsundere');

  assert.deepEqual(
    versions.map((entry) => entry.version),
    ['1.10.0', '1.9.0', '1.0.0'],
  );
});

test('listPluginVersions normalizes rows (min core default + camelCase fields)', async () => {
  const capture: Capture = { sql: '', bindings: [] };
  const [entry] = await listPluginVersions(
    fakeDb([versionRow({ min_core_version: null })], capture),
    'anime-tsundere',
  );

  assert.equal(entry.pluginId, 'anime-tsundere');
  assert.equal(entry.minCoreVersion, '3.9.0');
  assert.equal(entry.downloadUrl, 'https://example.test/anime-tsundere-2.0.0.orskin');
});

test('listPluginVersions returns an empty array when the ledger has no rows', async () => {
  const capture: Capture = { sql: '', bindings: [] };
  const versions = await listPluginVersions(fakeDb([], capture), 'ghost');
  assert.deepEqual(versions, []);
});

// --- getVersionDownloadUrl --------------------------------------------------

test('getVersionDownloadUrl binds both plugin id and version', async () => {
  const capture: Capture = { sql: '', bindings: [] };
  await getVersionDownloadUrl(fakeDb([{ download_url: 'https://x.test/a.orskin' } as never], capture), 'anime-tsundere', '1.0.0');

  assert.match(capture.sql, /FROM plugin_versions WHERE plugin_id = \? AND version = \?/);
  assert.deepEqual(capture.bindings, ['anime-tsundere', '1.0.0']);
});

test('getVersionDownloadUrl returns the URL for a known release', async () => {
  const capture: Capture = { sql: '', bindings: [] };
  const url = await getVersionDownloadUrl(
    fakeDb([{ download_url: 'https://x.test/v1.orskin' } as never], capture),
    'anime-tsundere',
    '1.0.0',
  );
  assert.equal(url, 'https://x.test/v1.orskin');
});

test('getVersionDownloadUrl returns null for an unpublished version', async () => {
  const capture: Capture = { sql: '', bindings: [] };
  const url = await getVersionDownloadUrl(fakeDb([], capture), 'anime-tsundere', '9.9.9');
  assert.equal(url, null);
});

test('getVersionDownloadUrl never splices the version into the SQL text', async () => {
  const capture: Capture = { sql: '', bindings: [] };
  const payload = "' OR 1=1; --";
  await getVersionDownloadUrl(fakeDb([], capture), 'anime-tsundere', payload);

  assert.equal(capture.sql.includes('OR 1=1'), false);
  assert.deepEqual(capture.bindings, ['anime-tsundere', payload]);
});
