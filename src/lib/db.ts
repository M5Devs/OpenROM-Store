/**
 * Typed access layer for the Cloudflare D1 `DB` binding.
 *
 * Every read/write against the catalog goes through here so the API endpoints and
 * pages share one shape. The database is the single source of truth — there is no
 * bundled fallback catalog.
 */

import { compareVersions } from './version.ts';

/** Raw row as stored in D1. */
export interface PluginRow {
  id: string;
  name: string;
  version: string;
  min_core_version: string;
  publisher_id: string | null;
  publisher_name: string;
  publisher_verified: number;
  category: string;
  description: string;
  readme_markdown: string | null;
  routes_json: string | null;
  platforms_json: string | null;
  screenshots_json: string | null;
  download_url: string;
  sha256: string;
  icon: string | null;
  downloads: number;
  created_at: string;
}

/** Normalized shape handed to components and the JSON API. */
export interface Plugin {
  id: string;
  name: string;
  version: string;
  minCoreVersion: string;
  publisherId: string | null;
  publisherName: string;
  publisherVerified: boolean;
  category: string;
  description: string;
  readme: string;
  routes: string[];
  platforms: string[];
  screenshots: string[];
  downloadUrl: string;
  sha256: string;
  icon: string;
  downloads: number;
  createdAt: string;
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function toPlugin(row: PluginRow): Plugin {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    minCoreVersion: row.min_core_version,
    publisherId: row.publisher_id ?? null,
    publisherName: row.publisher_name,
    publisherVerified: Boolean(row.publisher_verified),
    category: row.category,
    description: row.description,
    readme: row.readme_markdown ?? '',
    routes: parseJsonArray(row.routes_json),
    platforms: parseJsonArray(row.platforms_json),
    screenshots: parseJsonArray(row.screenshots_json),
    downloadUrl: row.download_url,
    sha256: row.sha256 ?? '',
    icon: row.icon ?? 'package',
    downloads: row.downloads ?? 0,
    createdAt: row.created_at,
  };
}

/** Resolve the D1 binding from the Cloudflare runtime provided by the adapter. */
export function getDB(locals: App.Locals): D1Database {
  const db = locals.runtime?.env?.DB;
  if (!db) {
    throw new Error(
      'D1 binding "DB" is unavailable. Check the [[d1_databases]] block in wrangler.toml.',
    );
  }
  return db;
}

/**
 * Columns every plugin query selects. Publisher name and verification come from the
 * `publishers` row when the plugin is linked (`publisher_id`); otherwise the
 * denormalized values on the plugin row are used, so legacy rows still render.
 */
const PLUGIN_COLUMNS = `
  p.id, p.name, p.version, p.min_core_version, p.publisher_id,
  COALESCE(pub.name, p.publisher_name)         AS publisher_name,
  COALESCE(pub.verified, p.publisher_verified) AS publisher_verified,
  p.category, p.description, p.readme_markdown, p.routes_json, p.platforms_json,
  p.screenshots_json, p.download_url, p.sha256, p.icon, p.downloads, p.created_at
`;

const PLUGIN_SOURCE = `FROM plugins p LEFT JOIN publishers pub ON pub.id = p.publisher_id`;

export async function listPlugins(db: D1Database): Promise<Plugin[]> {
  const { results } = await db
    .prepare(`SELECT ${PLUGIN_COLUMNS} ${PLUGIN_SOURCE} ORDER BY p.downloads DESC, p.name ASC`)
    .all<PluginRow>();
  return (results ?? []).map(toPlugin);
}

/**
 * Case-insensitive search across the fields a visitor can see on a card: name,
 * description and category. The term is bound, never interpolated, so the `%`
 * wildcards are the only pattern syntax that reaches SQL. `COALESCE` keeps rows
 * with a NULL description matchable.
 */
export async function searchPlugins(db: D1Database, query: string): Promise<Plugin[]> {
  const term = `%${query.toLowerCase()}%`;
  const { results } = await db
    .prepare(
      `SELECT ${PLUGIN_COLUMNS} ${PLUGIN_SOURCE}
        WHERE LOWER(p.name) LIKE ?1
           OR LOWER(COALESCE(p.description, '')) LIKE ?1
           OR LOWER(p.category) LIKE ?1
        ORDER BY p.downloads DESC, p.name ASC`,
    )
    .bind(term)
    .all<PluginRow>();
  return (results ?? []).map(toPlugin);
}

export async function getPlugin(db: D1Database, id: string): Promise<Plugin | null> {
  const row = await db
    .prepare(`SELECT ${PLUGIN_COLUMNS} ${PLUGIN_SOURCE} WHERE p.id = ?`)
    .bind(id)
    .first<PluginRow>();
  return row ? toPlugin(row) : null;
}

/**
 * Match a plugin to a publisher by the explicit `publisher_id` link, falling back
 * to the display name only for rows that predate the link column.
 */
const PUBLISHER_MATCH = `(p.publisher_id = ?1 OR (p.publisher_id IS NULL AND p.publisher_name = ?2))`;

export async function listPluginsByPublisher(
  db: D1Database,
  publisherId: string,
  publisherName: string,
): Promise<Plugin[]> {
  const { results } = await db
    .prepare(
      `SELECT ${PLUGIN_COLUMNS} ${PLUGIN_SOURCE} WHERE ${PUBLISHER_MATCH}
       ORDER BY p.downloads DESC, p.name ASC`,
    )
    .bind(publisherId, publisherName)
    .all<PluginRow>();
  return (results ?? []).map(toPlugin);
}

export interface PublisherStats {
  totalPlugins: number;
  totalDownloads: number;
}

/** Live aggregates for the public profile — summed in D1, never cached in the row. */
export async function getPublisherStats(
  db: D1Database,
  publisherId: string,
  publisherName: string,
): Promise<PublisherStats> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total_plugins, COALESCE(SUM(p.downloads), 0) AS total_downloads
         FROM plugins p
        WHERE ${PUBLISHER_MATCH}`,
    )
    .bind(publisherId, publisherName)
    .first<{ total_plugins: number; total_downloads: number }>();
  return {
    totalPlugins: row?.total_plugins ?? 0,
    totalDownloads: row?.total_downloads ?? 0,
  };
}

/** Atomically bump the real download counter. Returns the target URL, if known. */
export async function incrementDownloads(db: D1Database, id: string): Promise<string | null> {
  const row = await db
    .prepare('UPDATE plugins SET downloads = downloads + 1 WHERE id = ? RETURNING download_url')
    .bind(id)
    .first<{ download_url: string }>();
  return row?.download_url ?? null;
}

/** Raw row as stored in `plugin_versions`. */
export interface PluginVersionRow {
  id: number;
  plugin_id: string;
  version: string;
  min_core_version: string | null;
  download_url: string;
  sha256: string;
  created_at: string;
}

/** Normalized release record handed to the version-history UI. */
export interface PluginVersion {
  id: number;
  pluginId: string;
  version: string;
  minCoreVersion: string;
  downloadUrl: string;
  sha256: string;
  createdAt: string;
}

export function toPluginVersion(row: PluginVersionRow): PluginVersion {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    version: row.version,
    minCoreVersion: row.min_core_version ?? '3.9.0',
    downloadUrl: row.download_url,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

/**
 * Every published release for a plugin, newest first.
 *
 * The ordering is done in JS with `compareVersions` rather than SQL because
 * `version` is free-form text: SQLite's `ORDER BY` would rank `1.9.0` above
 * `1.10.0`. The table is small (one row per release), so sorting in memory is
 * cheap and gives the version selector a trustworthy order.
 *
 * A missing `plugin_versions` table (pre-0010 database) is not fatal — callers
 * treat an empty list as "fall back to the row's current release".
 */
export async function listPluginVersions(
  db: D1Database,
  pluginId: string,
): Promise<PluginVersion[]> {
  const { results } = await db
    .prepare(
      `SELECT id, plugin_id, version, min_core_version, download_url, sha256, created_at
         FROM plugin_versions
        WHERE plugin_id = ?`,
    )
    .bind(pluginId)
    .all<PluginVersionRow>();
  return (results ?? [])
    .map(toPluginVersion)
    .sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * Resolve the download URL for one specific release. Returns `null` when the
 * version was never published, which the download route turns into a 404 rather
 * than silently serving the latest bundle.
 */
export async function getVersionDownloadUrl(
  db: D1Database,
  pluginId: string,
  version: string,
): Promise<string | null> {
  const row = await db
    .prepare('SELECT download_url FROM plugin_versions WHERE plugin_id = ? AND version = ?')
    .bind(pluginId, version)
    .first<{ download_url: string }>();
  return row?.download_url ?? null;
}
