import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  conversionRate,
  summarize,
  toPluginAnalytics,
  trackDownload,
  trackView,
  type AnalyticsRow,
} from '../src/lib/analytics.ts';
import { fakeD1 } from './helpers/fake-d1.ts';

// --- Conversion -------------------------------------------------------------

test('conversionRate is downloads over views as a percentage', () => {
  assert.equal(conversionRate(100, 25), 25);
  assert.equal(conversionRate(3, 1), 33.3);
});

test('conversionRate is null with no views instead of dividing by zero', () => {
  assert.equal(conversionRate(0, 0), null);
  assert.equal(conversionRate(0, 5), null);
});

test('toPluginAnalytics defaults missing counters to zero', () => {
  const entry = toPluginAnalytics({ plugin_id: 'nkit', views: undefined as never, downloads: 2 });
  assert.equal(entry.views, 0);
  assert.equal(entry.downloads, 2);
  assert.equal(entry.conversionRate, null);
});

// --- Summarize --------------------------------------------------------------

const ROWS: AnalyticsRow[] = [
  { plugin_id: 'nkit', views: 100, downloads: 10 },
  { plugin_id: 'saturn', views: 50, downloads: 20 },
];

test('summarize totals views and downloads and computes the overall rate', () => {
  const summary = summarize(ROWS);
  assert.equal(summary.totalViews, 150);
  assert.equal(summary.totalDownloads, 30);
  assert.equal(summary.conversionRate, 20);
});

test('summarize ranks plugins by views, then downloads', () => {
  const summary = summarize(ROWS);
  assert.deepEqual(
    summary.plugins.map((entry) => entry.pluginId),
    ['nkit', 'saturn'],
  );

  const tied = summarize([
    { plugin_id: 'a', views: 10, downloads: 1 },
    { plugin_id: 'b', views: 10, downloads: 9 },
  ]);
  assert.deepEqual(
    tied.plugins.map((entry) => entry.pluginId),
    ['b', 'a'],
  );
});

test('summarize handles an empty catalog without dividing by zero', () => {
  const summary = summarize([]);
  assert.equal(summary.totalViews, 0);
  assert.equal(summary.totalDownloads, 0);
  assert.equal(summary.conversionRate, null);
  assert.deepEqual(summary.plugins, []);
});

// --- Tracking hooks ---------------------------------------------------------

test('trackView upserts today\'s row and increments atomically', async () => {
  const { db, last } = fakeD1(() => ({ changes: 1 }));
  await trackView(db, 'nkit');

  const call = last();
  assert.match(call.sql, /INSERT INTO plugin_analytics \(plugin_id, date, views\)/);
  assert.match(call.sql, /ON CONFLICT \(plugin_id, date\) DO UPDATE SET views = views \+ 1/);
  assert.deepEqual(call.bindings, ['nkit']);
});

test('trackDownload increments the downloads column on conflict', async () => {
  const { db, last } = fakeD1(() => ({ changes: 1 }));
  await trackDownload(db, 'saturn');

  const call = last();
  assert.match(call.sql, /ON CONFLICT \(plugin_id, date\) DO UPDATE SET downloads = downloads \+ 1/);
  assert.deepEqual(call.bindings, ['saturn']);
});

test('the plugin id is bound, never spliced into the tracking SQL', async () => {
  const { db, last } = fakeD1(() => ({ changes: 1 }));
  await trackView(db, "x'; DROP TABLE plugins;--");
  assert.ok(!last().sql.includes('DROP TABLE'));
  assert.deepEqual(last().bindings, ["x'; DROP TABLE plugins;--"]);
});
