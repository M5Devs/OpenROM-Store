import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GET } from '../src/pages/api/img.ts';
import { sniffImageType } from '../src/lib/image.ts';

// --- Fixtures ---------------------------------------------------------------

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x1a, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

const ORIGIN = 'https://openrom-store.pages.dev';

/** Exactly how SourceForge FRS answers: a download, mislabelled as octet-stream. */
function upstreamResponse(bytes: Uint8Array, overrides: Record<string, string> = {}): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="preview.png"',
      'content-length': String(bytes.byteLength),
      ...overrides,
    },
  });
}

/**
 * A body that ends early — a CDN answering with fewer bytes than it declared,
 * without an error. `content-length` still promises the full size.
 */
function truncatedResponse(bytes: Uint8Array, declaredLength: number): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(declaredLength),
    },
  });
}

interface Stubs {
  calls: { url: string; init?: RequestInit }[];
  cache: { store: Map<string, Response>; puts: number };
  restore(): void;
}

/**
 * Replace the two globals the route reaches for — `fetch` and `caches.default`.
 * Both are platform boundaries, so they are the only things faked here; the route
 * itself, the header logic, and `sniffImageType` all run for real.
 */
function installStubs(upstream: () => Response): Stubs {
  const calls: Stubs['calls'] = [];
  const originalFetch = globalThis.fetch;
  const originalCaches = (globalThis as { caches?: unknown }).caches;

  const store = new Map<string, Response>();
  const cache = {
    store,
    puts: 0,
    match: async (key: Request) => store.get(key.url),
    put: async (key: Request, response: Response) => {
      cache.puts += 1;
      store.set(key.url, response);
    },
  };

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return upstream();
  }) as typeof fetch;
  (globalThis as { caches?: unknown }).caches = { default: cache };

  return {
    calls,
    cache,
    restore() {
      globalThis.fetch = originalFetch;
      if (originalCaches === undefined) {
        delete (globalThis as { caches?: unknown }).caches;
      } else {
        (globalThis as { caches?: unknown }).caches = originalCaches;
      }
    },
  };
}

function call(query: string, referer?: string): Promise<Response> {
  const request = new Request(`${ORIGIN}/api/img?${query}`, referer ? { headers: { referer } } : {});
  return GET({ request, url: new URL(request.url) } as never) as Promise<Response>;
}

const PREVIEW = 'path=m5dev/anime-tsundere/2.0.0/preview.png';

// --- Header sanitization (the point of the route) ---------------------------

test('strips content-disposition and labels the asset image/png', async () => {
  const stubs = installStubs(() => upstreamResponse(PNG));
  try {
    const response = await call(PREVIEW);

    assert.equal(response.status, 200);
    // The whole reason the proxy exists: the attachment header must be gone.
    assert.equal(response.headers.get('content-disposition'), null);
    assert.equal(response.headers.get('content-type'), 'image/png');
  } finally {
    stubs.restore();
  }
});

test('sets a long-lived, publicly cacheable response with the security headers', async () => {
  const stubs = installStubs(() => upstreamResponse(PNG));
  try {
    const response = await call(PREVIEW);

    const cacheControl = response.headers.get('cache-control') ?? '';
    assert.match(cacheControl, /public/);
    assert.match(cacheControl, /max-age=2592000/);
    assert.match(cacheControl, /s-maxage=2592000/);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    stubs.restore();
  }
});

test('drops set-cookie so the response is storable by the Cache API', async () => {
  const stubs = installStubs(() =>
    upstreamResponse(PNG, { 'set-cookie': 'session=abc; Path=/' }),
  );
  try {
    const response = await call(PREVIEW);
    assert.equal(response.headers.get('set-cookie'), null);
  } finally {
    stubs.restore();
  }
});

test('returns the upstream bytes unchanged, with a matching content-length', async () => {
  const payload = new Uint8Array([...PNG, 1, 2, 3, 4, 5, 6, 7, 8]);
  const stubs = installStubs(() => upstreamResponse(payload));
  try {
    const response = await call(PREVIEW);
    const received = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual(received, payload, 'the body must not be truncated or altered');
    assert.equal(response.headers.get('content-length'), String(payload.byteLength));
  } finally {
    stubs.restore();
  }
});

test('refuses to serve a body that is shorter than its declared length', async () => {
  // The SourceForge mirror really does this: a browser-like User-Agent yields
  // ~110 KB of a 530 KB PNG. The truncated bytes must never reach the visitor.
  const half = PNG.slice(0, 8);
  const stubs = installStubs(() => truncatedResponse(half, 542730));
  try {
    const response = await call(PREVIEW);
    assert.equal(response.status, 502);
    assert.equal(stubs.cache.puts, 0, 'a truncated body must not be cached');
  } finally {
    stubs.restore();
  }
});

test('refuses a body that is not an image at all', async () => {
  // An HTML error page served with 200 and a matching length is still not an image.
  const html = new TextEncoder().encode('<html>nope</html>');
  const stubs = installStubs(() => upstreamResponse(html));
  try {
    const response = await call(PREVIEW);
    assert.equal(response.status, 502);
    assert.equal(stubs.cache.puts, 0, 'a non-image must not be cached');
  } finally {
    stubs.restore();
  }
});

// --- MIME detection ---------------------------------------------------------

test('sniffs the real type from the bytes rather than trusting the extension', async () => {
  // A GIF served from a `.png` path: the payload is the authority.
  const stubs = installStubs(() => upstreamResponse(GIF));
  try {
    const response = await call(PREVIEW);
    assert.equal(response.headers.get('content-type'), 'image/gif');
  } finally {
    stubs.restore();
  }
});

test('maps each image format to its MIME type', async () => {
  const cases: [Uint8Array, string][] = [
    [PNG, 'image/png'],
    [JPEG, 'image/jpeg'],
    [WEBP, 'image/webp'],
    [GIF, 'image/gif'],
  ];
  for (const [bytes, expected] of cases) {
    const stubs = installStubs(() => upstreamResponse(bytes));
    try {
      const response = await call(PREVIEW);
      assert.equal(response.headers.get('content-type'), expected);
    } finally {
      stubs.restore();
    }
  }
});

test('labels the asset by its bytes even when the extension disagrees', async () => {
  // A PNG served from a `.webp` path: the payload wins, so the browser is told
  // the truth about what it is receiving.
  const stubs = installStubs(() => upstreamResponse(PNG));
  try {
    const response = await call('path=m5dev/anime-tsundere/2.0.0/preview.webp');
    assert.equal(response.headers.get('content-type'), 'image/png');
  } finally {
    stubs.restore();
  }
});

test('sniffImageType recognizes the four supported signatures only', () => {
  assert.equal(sniffImageType(PNG), 'png');
  assert.equal(sniffImageType(JPEG), 'jpeg');
  assert.equal(sniffImageType(WEBP), 'webp');
  assert.equal(sniffImageType(GIF), 'gif');
  assert.equal(sniffImageType(new Uint8Array([1, 2, 3])), null);
  assert.equal(sniffImageType(new Uint8Array()), null);
});

// --- Path validation --------------------------------------------------------

test('rejects traversal attempts without ever contacting the upstream', async () => {
  const attacks = [
    'path=../../etc/passwd',
    'path=m5dev/../../../etc/passwd.png',
    'path=/etc/passwd.png',
    'path=..',
    'path=m5dev/..%2f..%2fsecret.png',
    'path=https://evil.example/x.png',
    'path=//evil.example/x.png',
  ];
  for (const query of attacks) {
    const stubs = installStubs(() => upstreamResponse(PNG));
    try {
      const response = await call(query);
      assert.equal(response.status, 400, `${query} must be rejected`);
      assert.equal(stubs.calls.length, 0, `${query} must not reach the upstream`);
    } finally {
      stubs.restore();
    }
  }
});

test('rejects a missing or empty path', async () => {
  for (const query of ['', 'path=', 'path=%20']) {
    const stubs = installStubs(() => upstreamResponse(PNG));
    try {
      const response = await call(query);
      assert.equal(response.status, 400);
      assert.equal(stubs.calls.length, 0);
    } finally {
      stubs.restore();
    }
  }
});

test('proxies only image extensions', async () => {
  const stubs = installStubs(() => upstreamResponse(PNG));
  try {
    const response = await call('path=m5dev/anime-tsundere/2.0.0/anime-tsundere-2.0.0.orskin');
    assert.equal(response.status, 400);
    assert.equal(stubs.calls.length, 0, 'a non-image must not be fetched');
  } finally {
    stubs.restore();
  }
});

test('builds the upstream URL on the fixed SourceForge origin', async () => {
  const stubs = installStubs(() => upstreamResponse(PNG));
  try {
    await call(PREVIEW);
    assert.equal(
      stubs.calls[0].url,
      'https://downloads.sourceforge.net/project/openrom-skins/m5dev/anime-tsundere/2.0.0/preview.png',
    );
    assert.equal(stubs.calls[0].init?.redirect, 'follow');
  } finally {
    stubs.restore();
  }
});

// --- Project allowlist ------------------------------------------------------

test('accepts the two known projects and defaults to openrom-skins', async () => {
  for (const query of [PREVIEW, `${PREVIEW}&project=openrom-skins`, `${PREVIEW}&project=openrom-plugins`]) {
    const stubs = installStubs(() => upstreamResponse(PNG));
    try {
      const response = await call(query);
      assert.equal(response.status, 200, `${query} should be allowed`);
    } finally {
      stubs.restore();
    }
  }
});

test('refuses an unknown project so the origin cannot be retargeted', async () => {
  const stubs = installStubs(() => upstreamResponse(PNG));
  try {
    const response = await call(`${PREVIEW}&project=evil`);
    assert.equal(response.status, 400);
    assert.equal(stubs.calls.length, 0);
  } finally {
    stubs.restore();
  }
});

// --- Anti-hotlinking --------------------------------------------------------

test('refuses a cross-origin referer', async () => {
  const stubs = installStubs(() => upstreamResponse(PNG));
  try {
    const response = await call(PREVIEW, 'https://evil.example/hotlink.html');
    assert.equal(response.status, 403);
    assert.equal(stubs.calls.length, 0, 'a hotlink must not be proxied');
  } finally {
    stubs.restore();
  }
});

test('allows no referer, the same host, localhost, and preview deployments', async () => {
  const referers = [
    undefined,
    `${ORIGIN}/plugin/anime-tsundere`,
    'http://localhost:4321/plugin/anime-tsundere',
    'https://abc123.openrom-store.pages.dev/plugin/anime-tsundere',
  ];
  for (const referer of referers) {
    const stubs = installStubs(() => upstreamResponse(PNG));
    try {
      const response = await call(PREVIEW, referer);
      assert.equal(response.status, 200, `referer ${referer} should be allowed`);
    } finally {
      stubs.restore();
    }
  }
});

// --- Upstream failures ------------------------------------------------------

test('propagates a non-OK upstream status', async () => {
  const stubs = installStubs(() => new Response('missing', { status: 404 }));
  try {
    const response = await call(PREVIEW);
    assert.equal(response.status, 404);
  } finally {
    stubs.restore();
  }
});

test('reports a network failure as 502 rather than throwing', async () => {
  const stubs = installStubs(() => {
    throw new Error('boom');
  });
  try {
    const response = await call(PREVIEW);
    assert.equal(response.status, 502);
  } finally {
    stubs.restore();
  }
});

// --- Edge cache -------------------------------------------------------------

test('stores the sanitized response in the edge cache', async () => {
  const stubs = installStubs(() => upstreamResponse(PNG));
  try {
    await call(PREVIEW);
    assert.equal(stubs.cache.puts, 1, 'the response should be written to the cache');
    const [stored] = [...stubs.cache.store.values()];
    assert.equal(stored.headers.get('content-type'), 'image/png');
    assert.equal(stored.headers.get('content-disposition'), null);
  } finally {
    stubs.restore();
  }
});

test('serves the second request from cache without hitting the upstream', async () => {
  const stubs = installStubs(() => upstreamResponse(PNG));
  try {
    await call(PREVIEW);
    const second = await call(PREVIEW);

    assert.equal(stubs.calls.length, 1, 'the upstream should be contacted exactly once');
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('content-type'), 'image/png');
  } finally {
    stubs.restore();
  }
});

test('keys the cache per URL so a different asset is not served from another', async () => {
  const stubs = installStubs(() => upstreamResponse(PNG));
  try {
    await call(PREVIEW);
    await call('path=m5dev/anime-tsundere/2.0.0/other.png');

    assert.equal(stubs.calls.length, 2, 'each distinct asset must be fetched');
    assert.equal(stubs.cache.store.size, 2);
  } finally {
    stubs.restore();
  }
});
