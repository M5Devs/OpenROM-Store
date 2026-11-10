import type { APIRoute } from 'astro';
import { getDB, getVersionDownloadUrl, incrementDownloads } from '../../../lib/db';
import { trackDownload } from '../../../lib/analytics';

export const prerender = false;

/**
 * Real download tracking. Atomically increments the extension's counter and then
 * hands the visitor off to the hosted bundle. Responses are never cached so every
 * click is counted exactly once.
 *
 * `?v=<version>` pins the download to one published release (see the version
 * history table on the plugin page). The counter still belongs to the listing as
 * a whole — an old release is a download of the same product — so the version only
 * changes *which* artifact is served, never which row is incremented. An unknown
 * version is a 404 rather than a quiet fall back to the latest bundle, because a
 * visitor who asked for 1.0.0 and silently received 2.0.0 would get a file whose
 * checksum does not match the one displayed.
 */
export const GET: APIRoute = async ({ params, request, locals }) => {
  const id = params.id;
  if (!id) {
    return new Response('Missing extension id', { status: 400 });
  }

  const version = new URL(request.url).searchParams.get('v')?.trim() ?? '';

  let target: string | null;
  try {
    const db = getDB(locals);

    // Bumping the counter doubles as the existence check for the listing: a
    // missing plugin returns no row, so we never reach the version lookup.
    const latest = await incrementDownloads(db, id);
    if (!latest) {
      return new Response(`Extension "${id}" not found`, { status: 404 });
    }

    if (version) {
      target = await getVersionDownloadUrl(db, id, version);
      if (!target) {
        return new Response(`Version "${version}" of "${id}" not found`, { status: 404 });
      }
    } else {
      target = latest;
    }
  } catch (error) {
    return new Response(`Download tracking unavailable: ${error}`, { status: 503 });
  }

  // Record the download in the daily analytics table too. Like the lifetime
  // counter above this is best-effort: a failure to log analytics must not stop
  // the visitor from reaching the bundle they asked for.
  try {
    await trackDownload(getDB(locals), id);
  } catch (error) {
    console.error(`Failed to record a download for "${id}"`, error);
  }

  return new Response(null, {
    status: 302,
    headers: { Location: target, 'Cache-Control': 'no-store' },
  });
};
