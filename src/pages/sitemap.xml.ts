import type { APIRoute } from 'astro';
import { getDB } from '../lib/db';
import {
  buildSitemapEntries,
  listSitemapPlugins,
  listSitemapPublishers,
  renderSitemap,
} from '../lib/sitemap';

export const prerender = false;

/**
 * Dynamic sitemap. The catalog is live data in D1 and every route is
 * server-rendered, so the URLs are enumerated at request time — a build-time
 * generator could only ever emit the `/plugin/[id]` route pattern.
 */
export const GET: APIRoute = async ({ locals }) => {
  try {
    const db = getDB(locals);
    const [plugins, publishers] = await Promise.all([
      listSitemapPlugins(db),
      listSitemapPublishers(db),
    ]);

    return new Response(renderSitemap(buildSitemapEntries(plugins, publishers)), {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (error) {
    // A D1 read can fail (missing table, unavailable binding). A sitemap is not
    // worth an unhandled 500, so report the outage and let the cache expire.
    console.error('Failed to build sitemap', error);
    return new Response('Sitemap unavailable', {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }
};
