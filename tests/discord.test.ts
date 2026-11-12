import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';

import { POST } from '../src/pages/api/discord/interactions.ts';
import {
  FLAG_EPHEMERAL,
  INTERACTION_APPLICATION_COMMAND,
  INTERACTION_PING,
  RESPONSE_CHANNEL_MESSAGE,
  RESPONSE_PONG,
  broadcastAnnouncement,
  collectStoreStats,
  countPublisherPlugins,
  deletionRequestEmbed,
  hexToBytes,
  interactionCommandName,
  interactionUserId,
  isValidActionUrl,
  readStringOption,
  sendDiscordWebhook,
  validateAnnounce,
  validateVerify,
  verifyDiscordSignature,
  verifyPublisher,
} from '../src/lib/discord.ts';
import { fakeD1, type DbCall } from './helpers/fake-d1.ts';

// --- Fixtures ---------------------------------------------------------------

/**
 * A real Ed25519 keypair, generated once. Discord holds the private half; we keep
 * both so a test can produce a signature the endpoint will accept, and then
 * produce a *wrong* one by signing different bytes.
 */
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
/** The raw 32-byte key, hex-encoded — the format Discord gives you in the portal. */
const PUBLIC_KEY_HEX = publicKey
  .export({ type: 'spki', format: 'der' })
  .subarray(-32)
  .toString('hex');

const OWNER_ID = '999000111222333444';
const GUILD_ID = '111222333444555666';

function signBody(body: string, timestamp = '1700000000'): { signature: string; timestamp: string } {
  const signature = sign(null, new TextEncoder().encode(timestamp + body), privateKey).toString('hex');
  return { signature, timestamp };
}

/** Build a signed POST to the interactions endpoint. */
function interactionRequest(
  payload: unknown,
  overrides: { signature?: string; timestamp?: string; body?: string } = {},
): Request {
  const body = overrides.body ?? JSON.stringify(payload);
  const signed = signBody(body, overrides.timestamp);
  return new Request('https://openrom-store.pages.dev/api/discord/interactions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature-ed25519': overrides.signature ?? signed.signature,
      'x-signature-timestamp': signed.timestamp,
    },
    body,
  });
}

interface CallOptions {
  env?: Record<string, unknown> | undefined;
  db?: D1Database;
}

async function callEndpoint(payload: unknown, options: CallOptions = {}): Promise<Response> {
  const env =
    'env' in options
      ? options.env
      : {
          DISCORD_PUBLIC_KEY: PUBLIC_KEY_HEX,
          DISCORD_OWNER_USER_ID: OWNER_ID,
        };
  const request = interactionRequest(payload);
  const context = {
    request,
    locals: { runtime: env ? { env: { DB: options.db, ...env } } : undefined },
  };
  return POST(context as never) as Promise<Response>;
}

/** A slash-command payload from the configured owner. */
function commandPayload(
  name: string,
  options: { name: string; type: number; value: string }[] = [],
): unknown {
  return {
    id: 'interaction-1',
    type: INTERACTION_APPLICATION_COMMAND,
    guild_id: GUILD_ID,
    member: { user: { id: OWNER_ID, username: 'operator' } },
    data: { name, options },
  };
}

const stringOption = (name: string, value: string) => ({ name, type: 3, value });

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text());
}

// --- hexToBytes -------------------------------------------------------------

test('hexToBytes decodes valid hex to the right bytes', () => {
  assert.deepEqual([...hexToBytes('00ff10')!], [0, 255, 16]);
});

test('hexToBytes rejects odd-length, non-hex, empty and non-string input', () => {
  for (const bad of ['abc', 'zz', '', 'gg', null, undefined, 42, {}]) {
    assert.equal(hexToBytes(bad), null, `expected null for ${String(bad)}`);
  }
});

// --- Signature verification -------------------------------------------------

test('accepts a signature over the exact timestamp and body', async () => {
  const body = '{"type":1}';
  const { signature, timestamp } = signBody(body);
  assert.equal(
    await verifyDiscordSignature({ publicKey: PUBLIC_KEY_HEX, signature, timestamp, body }),
    true,
  );
});

test('rejects a signature when the body has been altered', async () => {
  const { signature, timestamp } = signBody('{"type":1}');
  assert.equal(
    await verifyDiscordSignature({
      publicKey: PUBLIC_KEY_HEX,
      signature,
      timestamp,
      body: '{"type":1,"extra":true}',
    }),
    false,
  );
});

test('rejects a signature when the timestamp has been altered', async () => {
  const body = '{"type":1}';
  const { signature } = signBody(body, '1700000000');
  assert.equal(
    await verifyDiscordSignature({ publicKey: PUBLIC_KEY_HEX, signature, timestamp: '1700000001', body }),
    false,
  );
});

test('rejects a signature from a different key', async () => {
  const other = generateKeyPairSync('ed25519');
  const body = '{"type":1}';
  const timestamp = '1700000000';
  const signature = sign(null, new TextEncoder().encode(timestamp + body), other.privateKey).toString('hex');
  assert.equal(
    await verifyDiscordSignature({ publicKey: PUBLIC_KEY_HEX, signature, timestamp, body }),
    false,
  );
});

test('rejects malformed, missing and non-hex headers without throwing', async () => {
  const body = '{"type":1}';
  const cases: Record<string, string | null | undefined>[] = [
    { publicKey: PUBLIC_KEY_HEX, signature: null, timestamp: '1700000000', body },
    { publicKey: PUBLIC_KEY_HEX, signature: undefined, timestamp: '1700000000', body },
    { publicKey: PUBLIC_KEY_HEX, signature: 'not-hex', timestamp: '1700000000', body },
    { publicKey: PUBLIC_KEY_HEX, signature: 'abcd', timestamp: '1700000000', body },
    { publicKey: PUBLIC_KEY_HEX, signature: 'ab', timestamp: '', body },
    { publicKey: PUBLIC_KEY_HEX, signature: 'ab', timestamp: null, body },
  ];
  for (const input of cases) {
    assert.equal(await verifyDiscordSignature(input as never), false);
  }
});

test('rejects a malformed or missing public key instead of throwing', async () => {
  const body = '{"type":1}';
  const { signature, timestamp } = signBody(body);
  for (const publicKey of ['', 'zz', 'abc', PUBLIC_KEY_HEX.slice(0, 20)]) {
    assert.equal(
      await verifyDiscordSignature({ publicKey, signature, timestamp, body }),
      false,
      `key ${JSON.stringify(publicKey)} should not verify`,
    );
  }
});

// --- Payload readers --------------------------------------------------------

test('reads the invoking user from both the guild and DM payload shapes', () => {
  assert.equal(interactionUserId({ id: '1', type: 2, member: { user: { id: 'guild-user' } } } as never), 'guild-user');
  assert.equal(interactionUserId({ id: '1', type: 2, user: { id: 'dm-user' } } as never), 'dm-user');
  assert.equal(interactionUserId({ id: '1', type: 2 } as never), null);
});

test('reads the command name and returns null when it is absent or not a string', () => {
  assert.equal(interactionCommandName({ id: '1', type: 2, data: { name: 'stats' } } as never), 'stats');
  assert.equal(interactionCommandName({ id: '1', type: 2, data: {} } as never), null);
  assert.equal(interactionCommandName({ id: '1', type: 2, data: { name: '' } } as never), null);
  assert.equal(interactionCommandName({ id: '1', type: 2 } as never), null);
});

test('readStringOption only accepts a STRING option with a string value', () => {
  const payload = {
    id: '1',
    type: 2,
    data: {
      name: 'announce',
      options: [
        { name: 'title', type: 3, value: 'Hello' },
        { name: 'count', type: 4, value: '5' },
      ],
    },
  } as never;
  assert.equal(readStringOption(payload, 'title'), 'Hello');
  // Type 4 is INTEGER; a numeric option must not be read as a string.
  assert.equal(readStringOption(payload, 'count'), null);
  assert.equal(readStringOption(payload, 'missing'), null);
  assert.equal(readStringOption({ id: '1', type: 2 } as never, 'title'), null);
});

// --- /announce validation ---------------------------------------------------

test('accepts a well-formed announce command', () => {
  const payload = commandPayload('announce', [
    stringOption('title', 'Maintenance tonight'),
    stringOption('message', 'The store will be read-only from 22:00 UTC.'),
    stringOption('url', '/publish'),
  ]);
  const result = validateAnnounce(payload as never);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value, {
    title: 'Maintenance tonight',
    message: 'The store will be read-only from 22:00 UTC.',
    actionUrl: '/publish',
  });
});

test('treats an absent url as no link rather than an empty string', () => {
  const payload = commandPayload('announce', [
    stringOption('title', 'Hello'),
    stringOption('message', 'World'),
  ]);
  const result = validateAnnounce(payload as never);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.actionUrl, null);
});

test('requires both title and message', () => {
  const noTitle = validateAnnounce(
    commandPayload('announce', [stringOption('message', 'body')]) as never,
  );
  assert.equal(noTitle.ok, false);

  const noMessage = validateAnnounce(
    commandPayload('announce', [stringOption('title', 'title')]) as never,
  );
  assert.equal(noMessage.ok, false);

  // Whitespace-only values are treated as missing.
  const blank = validateAnnounce(
    commandPayload('announce', [stringOption('title', '   '), stringOption('message', '  ')]) as never,
  );
  assert.equal(blank.ok, false);
});

test('rejects over-long title, message and url', () => {
  assert.equal(
    validateAnnounce(
      commandPayload('announce', [
        stringOption('title', 'x'.repeat(201)),
        stringOption('message', 'ok'),
      ]) as never,
    ).ok,
    false,
  );
  assert.equal(
    validateAnnounce(
      commandPayload('announce', [
        stringOption('title', 'ok'),
        stringOption('message', 'x'.repeat(1001)),
      ]) as never,
    ).ok,
    false,
  );
  assert.equal(
    validateAnnounce(
      commandPayload('announce', [
        stringOption('title', 'ok'),
        stringOption('message', 'ok'),
        stringOption('url', `https://example.com/${'x'.repeat(500)}`),
      ]) as never,
    ).ok,
    false,
  );
});

test('rejects an unsafe action url and accepts https and relative paths', () => {
  const withUrl = (url: string) =>
    validateAnnounce(
      commandPayload('announce', [
        stringOption('title', 'ok'),
        stringOption('message', 'ok'),
        stringOption('url', url),
      ]) as never,
    );

  assert.equal(withUrl('https://openrom-store.pages.dev/publish').ok, true);
  assert.equal(withUrl('/publish').ok, true);
  assert.equal(withUrl('javascript:alert(1)').ok, false);
  assert.equal(withUrl('data:text/html,<script>').ok, false);
  assert.equal(withUrl('http://insecure.example').ok, false);
  // Protocol-relative would inherit the page scheme; refused.
  assert.equal(withUrl('//evil.example').ok, false);
});

test('isValidActionUrl classifies schemes as documented', () => {
  assert.equal(isValidActionUrl('/publish'), true);
  assert.equal(isValidActionUrl('https://example.com'), true);
  assert.equal(isValidActionUrl('//example.com'), false);
  assert.equal(isValidActionUrl('javascript:alert(1)'), false);
  assert.equal(isValidActionUrl('ftp://example.com'), false);
  assert.equal(isValidActionUrl('not a url'), false);
});

// --- /verify validation -----------------------------------------------------

test('accepts a plausible publisher id and rejects malformed ones', () => {
  assert.equal(validateVerify(commandPayload('verify', [stringOption('publisher', 'm5dev')]) as never).ok, true);
  assert.equal(
    validateVerify(commandPayload('verify', [stringOption('publisher', 'claus-valca_2')]) as never).ok,
    true,
  );
  assert.equal(validateVerify(commandPayload('verify', []) as never).ok, false);
  assert.equal(
    validateVerify(commandPayload('verify', [stringOption('publisher', 'has space')]) as never).ok,
    false,
  );
  assert.equal(
    validateVerify(commandPayload('verify', [stringOption('publisher', '../etc')]) as never).ok,
    false,
  );
  assert.equal(
    validateVerify(commandPayload('verify', [stringOption('publisher', 'x'.repeat(65))]) as never).ok,
    false,
  );
});

// --- Database operations ----------------------------------------------------

test('broadcastAnnouncement fans out with a single INSERT ... SELECT over users', async () => {
  const calls: DbCall[] = [];
  const fake = fakeD1(() => ({ changes: 7 }), calls);
  const recipients = await broadcastAnnouncement(fake.db, {
    title: 'Hi',
    message: 'There',
    actionUrl: '/publish',
  });

  assert.equal(recipients, 7);
  const [call] = calls;
  assert.match(call.sql, /INSERT INTO user_notifications/);
  assert.match(call.sql, /SELECT\s+github_id,\s*'system'/);
  assert.match(call.sql, /FROM users/);
  // The values are bound, never interpolated into the statement.
  assert.deepEqual(call.bindings, ['Hi', 'There', '/publish']);
});

test('broadcastAnnouncement reports zero recipients when the store has no users', async () => {
  const fake = fakeD1(() => ({ changes: 0 }));
  assert.equal(
    await broadcastAnnouncement(fake.db, { title: 'a', message: 'b', actionUrl: null }),
    0,
  );
});

test('verifyPublisher updates the publisher and its listings in one batch', async () => {
  const calls: DbCall[] = [];
  const fake = fakeD1((sql) => ({ changes: /publishers/i.test(sql) ? 1 : 3 }), calls);

  const result = await verifyPublisher(fake.db, 'm5dev');

  assert.deepEqual(result, { publisherFound: true, pluginsUpdated: 3 });
  assert.equal(calls.length, 2, 'both statements must run');
  assert.match(calls[0].sql, /UPDATE publishers SET verified = 1 WHERE id = \?1/);
  assert.match(calls[1].sql, /UPDATE plugins SET publisher_verified = 1 WHERE publisher_id = \?1/);
  assert.deepEqual(calls[0].bindings, ['m5dev']);
  assert.deepEqual(calls[1].bindings, ['m5dev']);
});

test('verifyPublisher reports an unknown publisher rather than claiming success', async () => {
  const fake = fakeD1((sql) => ({ changes: /publishers/i.test(sql) ? 0 : 0 }));
  assert.deepEqual(await verifyPublisher(fake.db, 'nobody'), {
    publisherFound: false,
    pluginsUpdated: 0,
  });
});

test('collectStoreStats reads all four counts in one statement', async () => {
  const calls: DbCall[] = [];
  const fake = fakeD1(
    () => ({ first: { plugins: 5, downloads: 1234, publishers: 2, users: 40 } }),
    calls,
  );

  assert.deepEqual(await collectStoreStats(fake.db), {
    plugins: 5,
    downloads: 1234,
    publishers: 2,
    users: 40,
  });
  assert.equal(calls.length, 1);
  for (const column of ['plugins', 'downloads', 'publishers', 'users']) {
    assert.match(calls[0].sql, new RegExp(column));
  }
});

test('collectStoreStats falls back to zeroes for an empty catalog', async () => {
  const fake = fakeD1(() => ({ first: null }));
  assert.deepEqual(await collectStoreStats(fake.db), {
    plugins: 0,
    downloads: 0,
    publishers: 0,
    users: 0,
  });
});

test('countPublisherPlugins binds the publisher id and counts', async () => {
  const calls: DbCall[] = [];
  const fake = fakeD1(() => ({ first: { count: 4 } }), calls);
  assert.equal(await countPublisherPlugins(fake.db, 'm5dev'), 4);
  assert.match(calls[0].sql, /SELECT COUNT\(\*\) AS count FROM plugins WHERE publisher_id = \?1/);
  assert.deepEqual(calls[0].bindings, ['m5dev']);
});

// --- Embed builders ---------------------------------------------------------

test('the deletion alert carries the publisher, requester, reason and listing count', () => {
  const embed = deletionRequestEmbed({
    publisherId: 'm5dev',
    requestedBy: 'ClausValcaTD',
    reason: 'Consolidating into the main account.',
    activePlugins: 3,
  });

  assert.equal(embed.title, '🚨 Publisher Deletion Request: @m5dev');
  assert.deepEqual(
    embed.fields?.map((field) => field.name),
    ['Requested by', 'Active plugins', 'Reason'],
  );
  assert.equal(embed.fields?.[0].value, 'ClausValcaTD');
  assert.equal(embed.fields?.[1].value, '3');
  assert.equal(embed.fields?.[2].value, 'Consolidating into the main account.');
});

test('the deletion alert never renders an empty reason as a blank field', () => {
  const embed = deletionRequestEmbed({
    publisherId: 'p',
    requestedBy: 'u',
    reason: '',
    activePlugins: 0,
  });
  assert.equal(embed.fields?.[2].value, '_(none given)_');
});

// --- Outgoing webhook -------------------------------------------------------

test('sendDiscordWebhook posts JSON and reports success', async () => {
  const original = globalThis.fetch;
  const seen: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    const ok = await sendDiscordWebhook('https://discord.com/api/webhooks/x/y', {
      embeds: [deletionRequestEmbed({ publisherId: 'p', requestedBy: 'u', reason: 'r', activePlugins: 1 })],
    });
    assert.equal(ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].init?.method, 'POST');
    assert.match(String((seen[0].init?.headers as Record<string, string>)['Content-Type']), /application\/json/);
    assert.match(String(seen[0].init?.body), /Publisher Deletion Request/);
  } finally {
    globalThis.fetch = original;
  }
});

test('sendDiscordWebhook swallows a non-2xx response and a network failure', async () => {
  const original = globalThis.fetch;

  try {
    globalThis.fetch = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
    assert.equal(await sendDiscordWebhook('https://discord.com/api/webhooks/x/y', { content: 'hi' }), false);

    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    // Must not reject: a Discord outage cannot fail the action that triggered it.
    assert.equal(await sendDiscordWebhook('https://discord.com/api/webhooks/x/y', { content: 'hi' }), false);
  } finally {
    globalThis.fetch = original;
  }
});

// --- The endpoint -----------------------------------------------------------

test('rejects an unsigned request with 401', async () => {
  const request = new Request('https://openrom-store.pages.dev/api/discord/interactions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 1 }),
  });
  const response = (await POST({
    request,
    locals: { runtime: { env: { DISCORD_PUBLIC_KEY: PUBLIC_KEY_HEX, DISCORD_OWNER_USER_ID: OWNER_ID } } },
  } as never)) as Response;
  assert.equal(response.status, 401);
});

test('rejects a request whose body was altered after signing', async () => {
  const original = JSON.stringify({ type: 1 });
  const { signature, timestamp } = signBody(original);
  const tampered = JSON.stringify({ type: 2, data: { name: 'stats' } });

  const request = new Request('https://openrom-store.pages.dev/api/discord/interactions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature-ed25519': signature,
      'x-signature-timestamp': timestamp,
    },
    body: tampered,
  });
  const response = (await POST({
    request,
    locals: { runtime: { env: { DISCORD_PUBLIC_KEY: PUBLIC_KEY_HEX, DISCORD_OWNER_USER_ID: OWNER_ID } } },
  } as never)) as Response;
  assert.equal(response.status, 401);
});

test('rejects every request when the public key is not configured', async () => {
  const response = await callEndpoint({ type: 1 }, { env: { DISCORD_OWNER_USER_ID: OWNER_ID } });
  assert.equal(response.status, 401);
});

test('answers the PING handshake with a PONG', async () => {
  const response = await callEndpoint({ id: '1', type: INTERACTION_PING });
  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), { type: RESPONSE_PONG });
});

test('refuses a slash command from anyone but the configured owner', async () => {
  const payload = {
    id: '1',
    type: INTERACTION_APPLICATION_COMMAND,
    member: { user: { id: 'intruder' } },
    data: { name: 'stats' },
  };
  const response = await callEndpoint(payload);
  const body = await readJson(response);

  assert.equal(response.status, 200);
  assert.equal(body.type, RESPONSE_CHANNEL_MESSAGE);
  assert.match(String((body.data as Record<string, unknown>).content), /not authorized/i);
  // A denial is ephemeral so it does not clutter the channel.
  assert.equal((body.data as Record<string, unknown>).flags, FLAG_EPHEMERAL);
});

test('refuses to run commands when no owner is configured', async () => {
  const response = await callEndpoint(commandPayload('stats'), {
    env: { DISCORD_PUBLIC_KEY: PUBLIC_KEY_HEX },
  });
  const body = await readJson(response);
  assert.match(String((body.data as Record<string, unknown>).content), /not configured/i);
});

test('reports an unknown command without needing a database', async () => {
  // The name is rejected before any I/O, so this passes with no DB bound at all.
  const response = await callEndpoint(commandPayload('drop-tables'));
  const body = await readJson(response);
  assert.match(String((body.data as Record<string, unknown>).content), /Unknown command/);
  assert.equal((body.data as Record<string, unknown>).flags, FLAG_EPHEMERAL);
});

test('/stats replies with the live totals', async () => {
  const fake = fakeD1(() => ({ first: { plugins: 6, downloads: 9001, publishers: 3, users: 120 } }));
  const response = await callEndpoint(commandPayload('stats'), { db: fake.db });
  const body = await readJson(response);

  assert.equal(body.type, RESPONSE_CHANNEL_MESSAGE);
  const embeds = (body.data as { embeds: { title: string; fields: { name: string; value: string }[] }[] }).embeds;
  assert.equal(embeds[0].title, '📊 OpenROM Store — Live Stats');
  assert.deepEqual(
    embeds[0].fields.map((field) => `${field.name}=${field.value}`),
    ['Extensions=6', 'Downloads=9,001', 'Publishers=3', 'Users=120'],
  );
});

test('/stats reports an ephemeral error when the database is unavailable', async () => {
  const response = await callEndpoint(commandPayload('stats'), { env: { DISCORD_PUBLIC_KEY: PUBLIC_KEY_HEX, DISCORD_OWNER_USER_ID: OWNER_ID } });
  const body = await readJson(response);
  assert.match(String((body.data as Record<string, unknown>).content), /temporarily unavailable/i);
});

test('/announce broadcasts and confirms to the channel', async () => {
  const calls: DbCall[] = [];
  const fake = fakeD1(() => ({ changes: 42 }), calls);
  const response = await callEndpoint(
    commandPayload('announce', [
      stringOption('title', 'NKit2ISO is live'),
      stringOption('message', 'Restore NKit images to bit-exact ISO.'),
      stringOption('url', '/plugin/nkit2iso'),
    ]),
    { db: fake.db },
  );
  const body = await readJson(response);

  assert.match(String((body.data as Record<string, unknown>).content), /Broadcast sent to all store users/);
  const embed = (body.data as { embeds: { title: string; description: string }[] }).embeds[0];
  assert.match(embed.title, /Broadcast sent to all store users/);
  assert.match(embed.description, /42 registered users/);

  assert.match(calls[0].sql, /FROM users/);
  assert.deepEqual(calls[0].bindings, [
    'NKit2ISO is live',
    'Restore NKit images to bit-exact ISO.',
    '/plugin/nkit2iso',
  ]);
  // A confirmation is public, not ephemeral.
  assert.equal((body.data as Record<string, unknown>).flags, undefined);
});

test('/announce refuses invalid input without touching the database', async () => {
  const calls: DbCall[] = [];
  const fake = fakeD1(() => ({ changes: 1 }), calls);
  const response = await callEndpoint(
    commandPayload('announce', [stringOption('title', 'only a title')]),
    { db: fake.db },
  );
  const body = await readJson(response);

  assert.equal((body.data as Record<string, unknown>).flags, FLAG_EPHEMERAL);
  assert.equal(calls.length, 0, 'nothing should be written for an invalid command');
});

test('/announce reports an ephemeral error when the insert fails', async () => {
  const fake = fakeD1(() => {
    throw new Error('D1_ERROR');
  });
  const response = await callEndpoint(
    commandPayload('announce', [stringOption('title', 't'), stringOption('message', 'm')]),
    { db: fake.db },
  );
  const body = await readJson(response);
  assert.equal((body.data as Record<string, unknown>).flags, FLAG_EPHEMERAL);
  assert.match(String((body.data as Record<string, unknown>).content), /could not be sent/i);
});

test('/verify marks the publisher and its listings verified', async () => {
  const calls: DbCall[] = [];
  const fake = fakeD1((sql) => ({ changes: /publishers/i.test(sql) ? 1 : 2 }), calls);
  const response = await callEndpoint(
    commandPayload('verify', [stringOption('publisher', 'm5dev')]),
    { db: fake.db },
  );
  const body = await readJson(response);

  assert.match(String((body.data as Record<string, unknown>).content), /`@m5dev` is now officially verified/);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /UPDATE publishers/);
  assert.match(calls[1].sql, /UPDATE plugins/);
});

test('/verify reports an unknown publisher rather than a false success', async () => {
  const fake = fakeD1(() => ({ changes: 0 }));
  const response = await callEndpoint(
    commandPayload('verify', [stringOption('publisher', 'ghost')]),
    { db: fake.db },
  );
  const body = await readJson(response);
  const data = body.data as Record<string, unknown>;

  assert.match(String(data.content), /No publisher found/);
  assert.equal(data.flags, FLAG_EPHEMERAL);
});

test('/verify posts an operator alert to the admin webhook when one is configured', async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (url: string) => {
    seen.push(String(url));
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    const fake = fakeD1((sql) => ({ changes: /publishers/i.test(sql) ? 1 : 1 }));
    await callEndpoint(commandPayload('verify', [stringOption('publisher', 'm5dev')]), {
      db: fake.db,
      env: {
        DISCORD_PUBLIC_KEY: PUBLIC_KEY_HEX,
        DISCORD_OWNER_USER_ID: OWNER_ID,
        DISCORD_ADMIN_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/2',
      },
    });
    assert.deepEqual(seen, ['https://discord.com/api/webhooks/1/2']);
  } finally {
    globalThis.fetch = original;
  }
});

test('a failing admin webhook does not break the /verify reply', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('discord down');
  }) as typeof fetch;

  try {
    const fake = fakeD1((sql) => ({ changes: /publishers/i.test(sql) ? 1 : 1 }));
    const response = await callEndpoint(commandPayload('verify', [stringOption('publisher', 'm5dev')]), {
      db: fake.db,
      env: {
        DISCORD_PUBLIC_KEY: PUBLIC_KEY_HEX,
        DISCORD_OWNER_USER_ID: OWNER_ID,
        DISCORD_ADMIN_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/2',
      },
    });
    const body = await readJson(response);
    assert.match(String((body.data as Record<string, unknown>).content), /is now officially verified/);
  } finally {
    globalThis.fetch = original;
  }
});
