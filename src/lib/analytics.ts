/**
 * Creator analytics: per-day view and download counters, and the aggregate the
 * dashboard reads.
 *
 * Counters live in `plugin_analytics`, one row per plugin per day. The tracking
 * hooks upsert into it (`ON CONFLICT ... DO UPDATE SET x = x + 1`), so incrementing
 * is a single atomic statement in D1 rather than a read-modify-write that could lose
 * a concurrent hit.
 *
 * A page view is recorded best-effort: a failed analytics write must never take
 * down the page it is counting, so `trackView` swallows its errors (see the caller
 * in src/pages/plugin/[id].astro).
 */

export interface AnalyticsRow {
  plugin_id: string;
  views: number;
  downloads: number;
}

export interface PluginAnalytics {
  pluginId: string;
  views: number;
  downloads: number;
  /** downloads / views, as a percentage rounded to one decimal. `null` with no views. */
  conversionRate: number | null;
}

export interface AnalyticsSummary {
  totalViews: number;
  totalDownloads: number;
  /** downloads / views across everything, as a percentage, or `null` with no views. */
  conversionRate: number | null;
  plugins: PluginAnalytics[];
}

/** Conversion as a percentage, guarding the divide-by-zero that a fresh plugin has. */
export function conversionRate(views: number, downloads: number): number | null {
  if (views <= 0) return null;
  return Math.round((downloads / views) * 1000) / 10;
}

export function toPluginAnalytics(row: AnalyticsRow): PluginAnalytics {
  const views = row.views ?? 0;
  const downloads = row.downloads ?? 0;
  return {
    pluginId: row.plugin_id,
    views,
    downloads,
    conversionRate: conversionRate(views, downloads),
  };
}

export function summarize(rows: AnalyticsRow[]): AnalyticsSummary {
  const plugins = rows.map(toPluginAnalytics);
  const totalViews = plugins.reduce((sum, entry) => sum + entry.views, 0);
  const totalDownloads = plugins.reduce((sum, entry) => sum + entry.downloads, 0);
  return {
    totalViews,
    totalDownloads,
    conversionRate: conversionRate(totalViews, totalDownloads),
    plugins: plugins.sort((a, b) => b.views - a.views || b.downloads - a.downloads),
  };
}

/** Record one view of a plugin for today. */
export async function trackView(db: D1Database, pluginId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO plugin_analytics (plugin_id, date, views)
       VALUES (?1, CURRENT_DATE, 1)
       ON CONFLICT (plugin_id, date) DO UPDATE SET views = views + 1`,
    )
    .bind(pluginId)
    .run();
}

/**
 * Record one download for today. Best-effort like `trackView`: a failure to log
 * analytics must not stop the visitor reaching the bundle, so the caller logs and
 * swallows (see src/pages/api/download/[id].ts).
 */
export async function trackDownload(db: D1Database, pluginId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO plugin_analytics (plugin_id, date, downloads)
       VALUES (?1, CURRENT_DATE, 1)
       ON CONFLICT (plugin_id, date) DO UPDATE SET downloads = downloads + 1`,
    )
    .bind(pluginId)
    .run();
}

/**
 * Lifetime views/downloads per plugin for one publisher.
 *
 * A publisher owns its plugins through `publisher_id`, with a display-name fallback
 * for rows that predate the link column — the same match `listPluginsByPublisher`
 * uses, so the analytics tab and the public profile agree on which plugins are
 * "theirs". Plugins with no analytics rows yet are absent from the result; the caller
 * merges against the plugin list so a brand-new listing still shows a zero row.
 */
export async function getPublisherAnalytics(
  db: D1Database,
  publisherId: string,
  publisherName: string,
): Promise<AnalyticsSummary> {
  const { results } = await db
    .prepare(
      `SELECT a.plugin_id                AS plugin_id,
              COALESCE(SUM(a.views), 0)     AS views,
              COALESCE(SUM(a.downloads), 0) AS downloads
         FROM plugin_analytics a
         JOIN plugins p ON p.id = a.plugin_id
        WHERE (p.publisher_id = ?1 OR (p.publisher_id IS NULL AND p.publisher_name = ?2))
        GROUP BY a.plugin_id`,
    )
    .bind(publisherId, publisherName)
    .all<AnalyticsRow>();
  return summarize(results ?? []);
}
