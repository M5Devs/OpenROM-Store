import { test } from 'node:test';
import assert from 'node:assert/strict';

import { POST } from '../src/pages/api/publishers/[id]/request-deletion.ts';
import { createSessionToken } from '../src/lib/session.ts';
import { fakeD1, type DbCall } from './helpers/fake-d1.ts';

/**
 * The deletion-request route, exercised end to end with the real session, team
 * authorization and Discord dispatch code. Only D1 and `fetch` are doubled.
 */

const SESSION_SECRET = 'test-secret-value';
const OWNER_GITHUB_ID = '193546948';
const PUBLISHER_ID = 'm5dev';

async function sessionCookie(): Promise<string> {
  const token = await createSessionToken(
    {
      githubId: OWNER_GITHUB_ID,
      githubUsername: 'ClausValcaTD',
      name: 'M5 Dev',
      avatarUrl: null,
    },
    { SESSION_SECRET },
  );
  assert.ok(token, 'session token must be mintable');
  return `openrom_session=${token}`;
}

/**
 * A D1 double that knows just enough about this route: the publisher exists and is
 * owned by the session user, no deletion request is pending, and inserts return a
 * row. Anything else throws so a new query cannot slip past unnoticed.
 */
function deletionDb(options: { activePlugins?: number; pending?: boolean } = {}) {
  const calls: DbCall[] = [];
  const { activePlugins = 3, pending = false } = options;

  const db = fakeD1((sql) => {
    if (/FROM publishers\b/i.test(sql)) {
      return {
        first: {
          id: PUBLISHER_ID,
          name: 'M5 Dev',
          owner_github_id: OWNER_GITHUB_ID,
          verified: 1,
          bio: '',
          avatar_url: '',
          banner_url: '',
          website_url: '',
          github_url: '',
          discord_url: '',
          twitter_url: '',
        },
      };
    }
    if (/FROM publisher_members\b/i.test(sql)) return { first: null };
    if (/FROM publisher_deletion_requests/i.test(sql)) {
      return { first: pending ? { id: 1, publisher_id: PUBLISHER_ID, status: 'pending' } : null };
    }
    if (/INSERT INTO publisher_deletion_requests/i.test(sql)) {
      return {
        first: {
          id: 7,
          publisher_id: PUBLISHER_ID,
          requested_by_github_id: OWNER_GITHUB_ID,
          reason: 'Consolidating accounts.',
          status: 'pending',
          created_at: '2026-01-01 00:00:00',
        },
      };
    }
    if (/COUNT\(\*\) AS count FROM plugins/i.test(sql)) {
      return { first: { count: activePlugins } };
    }
    throw new Error(`deletionDb does not implement: ${sql}`);
  }, calls);

  return { db: db.db, calls };
}

/**
 * The route reads the session through `context.cookies`, so the fake supplies a
 * jar holding the one cookie under test.
 */
function cookieJar(header: string | null) {
  const value = header ? header.slice(header.indexOf('=') + 1) : undefined;
  return {
    get: (name: string) => (name === 'openrom_session' && value ? { value } : undefined),
    set: () => {},
    delete: () => {},
  };
}

interface CallOptions {
  env?: Record<string, unknown>;
  body?: unknown;
  cookie?: string | null;
}

async function fileRequest(options: CallOptions = {}): Promise<Response> {
  // The route verifies the session cookie against the runtime secret, so the
  // default env must carry the same one the cookie was minted with.
  const env = options.env ?? {
    SESSION_SECRET,
    DISCORD_ADMIN_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/2',
  };
  const { db } = deletionDb();
  const cookie = options.cookie === undefined ? await sessionCookie() : options.cookie;
  const request = new Request(
    `https://openrom-store.pages.dev/api/publishers/${PUBLISHER_ID}/request-deletion`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(options.body ?? { reason: 'Consolidating accounts.' }),
    },
  );
  const context = {
    params: { id: PUBLISHER_ID },
    request,
    cookies: cookieJar(cookie),
    locals: { runtime: { env: { DB: db, ...env } } },
  };
  return POST(context as never) as Promise<Response>;
}

test('a deletion request is recorded and alerts the operator channel', async () => {
  const original = globalThis.fetch;
  const posted: { url: string; body: string }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    posted.push({ url: String(url), body: String(init?.body) });
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    const response = await fileRequest();
    assert.equal(response.status, 201);
    assert.equal(posted.length, 1, 'exactly one webhook should be posted');
    assert.equal(posted[0].url, 'https://discord.com/api/webhooks/1/2');

    const payload = JSON.parse(posted[0].body) as { embeds: { title: string; fields: { name: string; value: string }[] }[] };
    assert.equal(payload.embeds[0].title, '🚨 Publisher Deletion Request: @m5dev');
    const fields = Object.fromEntries(payload.embeds[0].fields.map((f) => [f.name, f.value]));
    assert.equal(fields['Requested by'], 'ClausValcaTD');
    assert.equal(fields['Reason'], 'Consolidating accounts.');
    assert.equal(fields['Active plugins'], '3');
  } finally {
    globalThis.fetch = original;
  }
});

test('a dead webhook still returns 201 and records the request', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('connection refused');
  }) as typeof fetch;

  try {
    const response = await fileRequest();
    // The alert is a courtesy; the request is already durable.
    assert.equal(response.status, 201);
    const body = (await response.json()) as { request: { id: number } };
    assert.equal(body.request.id, 7);
  } finally {
    globalThis.fetch = original;
  }
});

test('no webhook is posted when none is configured', async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    const response = await fileRequest({ env: { SESSION_SECRET } });
    assert.equal(response.status, 201);
    assert.equal(called, false, 'no webhook URL means no request at all');
  } finally {
    globalThis.fetch = original;
  }
});

test('an anonymous caller is refused before anything is written', async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    const response = await fileRequest({ cookie: null });
    assert.equal(response.status, 401);
    assert.equal(called, false, 'an unauthenticated request must not alert anyone');
  } finally {
    globalThis.fetch = original;
  }
});

test('an existing pending request is returned without re-alerting', async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    const { db } = deletionDb({ pending: true });
    const cookie = await sessionCookie();
    const request = new Request(
      `https://openrom-store.pages.dev/api/publishers/${PUBLISHER_ID}/request-deletion`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ reason: 'Filing a second request while one is pending.' }),
      },
    );
    const response = (await POST({
      params: { id: PUBLISHER_ID },
      request,
      cookies: cookieJar(cookie),
      locals: {
        runtime: {
          env: {
            DB: db,
            SESSION_SECRET,
            DISCORD_ADMIN_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/2',
          },
        },
      },
    } as never)) as Response;

    assert.equal(response.status, 200);
    // A duplicate request must not spam the operator channel.
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});
