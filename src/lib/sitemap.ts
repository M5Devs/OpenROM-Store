/**
 * Building blocks for the dynamic sitemap.
 *
 * The sitemap is assembled at the edge from D1 rather than at build time. Every
 * route in this app is `prerender = false` and the catalog is live data, so a
 * build-time generator has no ids to enumerate — it can only emit route patterns
 * such as `/plugin/[id]`, which are not real URLs. See src/pages/sitemap.xml.ts.
 */

/** The canonical origin. Mirrors `site` in astro.config.mjs. */
export const SITE_ORIGIN = 'https://openrom-store.pages.dev';

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
  priority?: string;
}

/** Only the columns the sitemap needs; the full row shape lives in lib/db.ts. */
export interface SitemapRow {
  id: string;
  created_at: string | null;
}

/**
 * Every plugin row is a live listing — there is no moderation/`approved` column
 * in the schema, so no extra filter is applied here.
 */
export async function listSitemapPlugins(db: D1Database): Promise<SitemapRow[]> {
  const { results } = await db
    .prepare('SELECT id, created_at FROM plugins ORDER BY id')
    .all<SitemapRow>();
  return results ?? [];
}

export async function listSitemapPublishers(db: D1Database): Promise<SitemapRow[]> {
  const { results } = await db
    .prepare('SELECT id, created_at FROM publishers ORDER BY id')
    .all<SitemapRow>();
  return results ?? [];
}

/**
 * Reduce a D1 timestamp to the `YYYY-MM-DD` precision `lastmod` expects. D1
 * stores `YYYY-MM-DD HH:MM:SS`; anything that does not start with a real date is
 * dropped so an unparseable value never becomes an invalid `lastmod`.
 */
export function toLastmod(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  if (!match) return undefined;
  return Number.isNaN(Date.parse(`${match[1]}T00:00:00Z`)) ? undefined : match[1];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function renderEntry(entry: SitemapEntry): string {
  const parts = [`<loc>${escapeXml(entry.loc)}</loc>`];
  if (entry.lastmod) parts.push(`<lastmod>${entry.lastmod}</lastmod>`);
  if (entry.priority) parts.push(`<priority>${entry.priority}</priority>`);
  return `<url>${parts.join('')}</url>`;
}

/** The complete urlset document. The caller decides the entry order. */
export function renderSitemap(entries: SitemapEntry[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries.map(renderEntry),
    '</urlset>',
  ].join('');
}

/** The homepage first, then one entry per live listing and publisher. */
export function buildSitemapEntries(
  plugins: SitemapRow[],
  publishers: SitemapRow[],
): SitemapEntry[] {
  return [
    { loc: `${SITE_ORIGIN}/`, priority: '1.0' },
    ...plugins.map((row) => ({
      loc: `${SITE_ORIGIN}/plugin/${encodeURIComponent(row.id)}`,
      lastmod: toLastmod(row.created_at),
      priority: '0.8',
    })),
    ...publishers.map((row) => ({
      loc: `${SITE_ORIGIN}/publisher/${encodeURIComponent(row.id)}`,
      lastmod: toLastmod(row.created_at),
      priority: '0.6',
    })),
  ];
}
