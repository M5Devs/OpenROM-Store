import type { APIRoute } from 'astro';
import { sniffImageType } from '../../lib/image.ts';

export const prerender = false;

/**
 * Edge image proxy for SourceForge-hosted artwork.
 *
 * SourceForge FRS serves every asset as `application/octet-stream` with
 * `Content-Disposition: attachment`, so a browser downloads the file instead of
 * painting it in an `<img>`. This route fetches the same asset at the edge, drops
 * the attachment header, labels it with the MIME type its own bytes prove, and
 * caches the result for 30 days.
 *
 * It is deliberately narrow, because a proxy that takes a URL from the query
 * string is otherwise an open relay. The upstream host is fixed (only the path
 * varies), the path cannot traverse or carry a scheme, and only image
 * extensions are served — so it cannot be aimed at an internal address or used
 * to mirror arbitrary files.
 */

/** The only upstream this route ever contacts. */
const UPSTREAM_ORIGIN = 'https://downloads.sourceforge.net';

/**
 * Identify the proxy plainly.
 *
 * A browser-like `Mozilla/5.0 …` User-Agent must NOT be sent: SourceForge's
 * mirror answers one with a truncated body (roughly 110 KB of a 530 KB PNG),
 * which would cache a corrupt image for 30 days. A non-browser token streams the
 * whole file.
 */
const UPSTREAM_USER_AGENT = 'OpenROM-Storefront/1.0 (+https://openrom-store.pages.dev)';

/** SourceForge projects the storefront may mirror. */
const ALLOWED_PROJECTS = new Set(['openrom-skins', 'openrom-plugins']);
const DEFAULT_PROJECT = 'openrom-skins';

/** Hosts allowed to hotlink an asset. A bare hit (no referer) is also allowed. */
const ALLOWED_REFERER_HOSTS = ['openrom-store.pages.dev'];

/**
 * One or more path segments. The character class excludes `/`, so a segment
 * cannot be empty, and `:` (a scheme), `?` and `#` never match — the value
 * cannot escape its slot in the URL. `..` is rejected separately before this.
 */
const SAFE_PATH = /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;

/**
 * Extension → MIME type. Doubles as the allowlist of what may be proxied, and
 * is kept in step with `sniffImageType` so every allowed extension is one the
 * verifier can actually confirm.
 */
const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** Sniffed magic-byte type → MIME type. */
const SNIFFED_TYPES: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** 30 days, at the edge and in the browser. */
const CACHE_SECONDS = 60 * 60 * 24 * 30;

/** The slice of the Cache API this route uses, so it can be stubbed in tests. */
interface EdgeCache {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, response: Response): Promise<void>;
}

function edgeCache(): EdgeCache | null {
  const store = (globalThis as { caches?: { default?: EdgeCache } }).caches;
  return store?.default ?? null;
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * The proxy exists to be embedded by the storefront, so a request whose referer
 * points somewhere else is refused. A request with no referer at all is allowed:
 * that is a direct hit or a privacy-stripped navigation, neither of which is
 * hotlinking, and browsers drop the header under some referrer policies.
 */
function refererAllowed(referer: string | null, selfHostname: string): boolean {
  if (!referer) return true;
  let hostname: string;
  try {
    hostname = new URL(referer).hostname;
  } catch {
    return false;
  }
  if (hostname === selfHostname || isLocalHost(hostname)) return true;
  // Cloudflare preview deployments are `<hash>.openrom-store.pages.dev`.
  return ALLOWED_REFERER_HOSTS.some(
    (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
  );
}

/** The lowercased extension of the final path segment, or an empty string. */
function extensionOf(path: string): string {
  const last = path.slice(path.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  return dot < 0 ? '' : last.slice(dot + 1).toLowerCase();
}

/**
 * Read the whole upstream body and confirm it is exactly the image the mirror
 * promised.
 *
 * The body is buffered rather than streamed for one concrete reason: a CDN can
 * end a response early without an error, and a *truncated* image would then be
 * cached for 30 days. SourceForge does exactly this — answering a browser-like
 * User-Agent with ~110 KB of a 530 KB PNG — so the byte count is checked against
 * `Content-Length` before anything is served or cached.
 *
 * Two guards run:
 *   1. the bytes must be a recognized image (magic-byte sniff), which rejects an
 *      HTML error page served with a 200;
 *   2. when the mirror states a length, the payload must match it exactly.
 *
 * Returns the validated bytes, or `null` when either guard fails.
 */
async function readVerifiedImage(
  upstream: Response,
): Promise<{ bytes: Uint8Array; type: string } | null> {
  const bytes = new Uint8Array(await upstream.arrayBuffer());

  const sniffed = sniffImageType(bytes);
  if (!sniffed) return null;

  const declared = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 0 && bytes.byteLength !== declared) return null;

  return { bytes, type: SNIFFED_TYPES[sniffed] ?? 'application/octet-stream' };
}

export const GET: APIRoute = async ({ request, url }) => {
  // 1. Anti-hotlinking: only the storefront (or a direct hit) may embed an asset.
  if (!refererAllowed(request.headers.get('referer'), url.hostname)) {
    return new Response('Forbidden', { status: 403 });
  }

  // 2. Extract and validate the target path. `..` is rejected outright so a
  //    traversal attempt cannot be smuggled through the character class.
  const path = (url.searchParams.get('path') ?? '').trim();
  if (!path || path.includes('..') || !SAFE_PATH.test(path)) {
    return new Response('Invalid or missing path parameter', { status: 400 });
  }

  const project = (url.searchParams.get('project') ?? '').trim() || DEFAULT_PROJECT;
  if (!ALLOWED_PROJECTS.has(project)) {
    return new Response('Unknown project', { status: 400 });
  }

  // 3. Only image assets are proxied — the extension is the allowlist.
  if (!EXTENSION_TYPES[extensionOf(path)]) {
    return new Response('Only image assets may be proxied', { status: 400 });
  }

  const upstreamUrl = `${UPSTREAM_ORIGIN}/project/${project}/${path}`;

  // 4. Serve from the edge cache when we have it.
  const cache = edgeCache();
  const cacheKey = new Request(url.toString());
  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  // 5. Fetch upstream, following SourceForge's redirect to a mirror.
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { 'User-Agent': UPSTREAM_USER_AGENT },
      redirect: 'follow',
    });
  } catch (error) {
    return new Response(`Upstream fetch failed: ${error}`, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    return new Response('Upstream asset not found', { status: upstream.status || 502 });
  }

  // 6. Trust the bytes, not the upstream header — FRS labels every file as
  //    octet-stream. Buffer and verify the payload so a truncated download is
  //    never served, let alone cached for 30 days.
  const verified = await readVerifiedImage(upstream);
  if (!verified) {
    return new Response('Upstream asset is not a valid image', { status: 502 });
  }

  // 7. Sanitize: drop the attachment disposition, set the real type, and pin a
  //    long-lived edge cache. `set-cookie` is removed because the Cache API
  //    refuses to store a response that carries one.
  const headers = new Headers(upstream.headers);
  headers.delete('content-disposition');
  headers.delete('set-cookie');
  headers.set('content-type', verified.type);
  headers.set('content-length', String(verified.bytes.byteLength));
  headers.set('cache-control', `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`);
  headers.set('access-control-allow-origin', '*');
  headers.set('x-content-type-options', 'nosniff');

  const response = new Response(verified.bytes, { status: 200, headers });

  if (cache) {
    try {
      await cache.put(cacheKey, response.clone());
    } catch {
      // A cache write must never cost the visitor the image they asked for.
    }
  }

  return response;
};
