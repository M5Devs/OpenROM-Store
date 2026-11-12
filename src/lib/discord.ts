/**
 * Serverless Discord interactions: request verification, the interaction
 * vocabulary, and the three admin command handlers.
 *
 * Discord delivers every interaction as an HTTPS POST and expects an answer
 * within three seconds, so there is no gateway connection to keep alive. The
 * trade-off is that the endpoint is public: anyone can POST to it. Two things
 * make that safe, and both live here.
 *
 *   1. Every request is signed. Discord signs `timestamp + body` with the
 *      application's Ed25519 private key and sends the signature and timestamp as
 *      headers. We verify against the matching public key, which means the raw
 *      body must be verified *before* it is parsed — re-serialising JSON changes
 *      the bytes and the signature would no longer match.
 *   2. A valid signature only proves the request came from Discord, not that the
 *      person who ran the command is allowed to. Every command is additionally
 *      gated on `DISCORD_OWNER_USER_ID`.
 *
 * Signature verification uses Web Crypto, which the Workers runtime and Node both
 * implement, so the same code runs in production and in the unit tests.
 */

// --- Interaction vocabulary -------------------------------------------------

/** `interaction.type`: Discord's endpoint-registration handshake. */
export const INTERACTION_PING = 1;
/** `interaction.type`: a slash command invocation. */
export const INTERACTION_APPLICATION_COMMAND = 2;

/** `response.type`: answer a PING. */
export const RESPONSE_PONG = 1;
/** `response.type`: post a message into the channel. */
export const RESPONSE_CHANNEL_MESSAGE = 4;

/** `data.flags`: only the invoking user sees the message. */
export const FLAG_EPHEMERAL = 64;

/** Discord's STRING option type, the only kind these commands accept. */
export const OPTION_TYPE_STRING = 3;

export interface DiscordInteractionOption {
  name: string;
  type: number;
  value?: unknown;
}

export interface DiscordUser {
  id: string;
  username?: string;
  global_name?: string | null;
}

export interface DiscordInteraction {
  id: string;
  type: number;
  /** Present for guild commands; `member.user` is the invoking user. */
  member?: { user?: DiscordUser };
  /** Present for DM commands. */
  user?: DiscordUser;
  data?: {
    name?: string;
    options?: DiscordInteractionOption[];
  };
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  timestamp?: string;
}

export interface DiscordMessageData {
  content?: string;
  embeds?: DiscordEmbed[];
  flags?: number;
}

export interface DiscordInteractionResponse {
  type: number;
  data?: DiscordMessageData;
}

// --- Hex and signature verification -----------------------------------------

/**
 * Decode a hex string, or return `null` when it is not valid hex.
 *
 * Discord sends the signature as 128 hex characters. A malformed header must be
 * rejected as a failed verification, not thrown as a crash, so the decode is
 * total: it never throws and never returns a partial buffer.
 */
export function hexToBytes(hex: unknown): Uint8Array | null {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    const pair = hex.slice(i * 2, i * 2 + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(pair)) return null;
    bytes[i] = Number.parseInt(pair, 16);
  }
  return bytes;
}

export interface VerifyDiscordSignatureInput {
  /** The application's Ed25519 public key, 64 hex characters. */
  publicKey: string;
  /** The `X-Signature-Ed25519` header. */
  signature: string | null | undefined;
  /** The `X-Signature-Timestamp` header. */
  timestamp: string | null | undefined;
  /** The raw request body, exactly as received. */
  body: string;
}

/**
 * Verify a Discord request signature.
 *
 * Returns `false` — never throws — for a missing header, a malformed key or
 * signature, or a signature that simply does not match. The caller only has to
 * decide what to do with a boolean.
 */
export async function verifyDiscordSignature(input: VerifyDiscordSignatureInput): Promise<boolean> {
  const keyBytes = hexToBytes(input.publicKey);
  const signatureBytes = hexToBytes(input.signature);
  if (!keyBytes || !signatureBytes) return false;
  if (typeof input.timestamp !== 'string' || input.timestamp.length === 0) return false;

  try {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'Ed25519' }, false, [
      'verify',
    ]);
    const message = new TextEncoder().encode(input.timestamp + input.body);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, signatureBytes, message);
  } catch {
    // An unparsable public key or an unsupported curve lands here. Treat it as a
    // failed verification rather than a 500, so a misconfigured key cannot be
    // used to probe the endpoint.
    return false;
  }
}

// --- Response builders ------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** Answer the registration PING. Discord shows a green tick when this is correct. */
export function pongResponse(): Response {
  return json({ type: RESPONSE_PONG } satisfies DiscordInteractionResponse);
}

/** Post a message to the channel, optionally with embeds. */
export function messageResponse(
  content: string,
  embeds: DiscordEmbed[] = [],
  ephemeral = false,
): Response {
  const data: DiscordMessageData = { content };
  if (embeds.length > 0) data.embeds = embeds;
  if (ephemeral) data.flags = FLAG_EPHEMERAL;
  return json({ type: RESPONSE_CHANNEL_MESSAGE, data } satisfies DiscordInteractionResponse);
}

/** A message only the invoker can see — used for denials and validation errors. */
export function ephemeralResponse(content: string): Response {
  return messageResponse(content, [], true);
}

/** Reject a request that failed signature verification. */
export function unauthorizedResponse(): Response {
  return new Response('invalid request signature', { status: 401 });
}

// --- Reading the invocation -------------------------------------------------

/** The invoking user, wherever Discord put them (guild vs. DM payload shape). */
export function interactionUserId(interaction: DiscordInteraction): string | null {
  return interaction.member?.user?.id ?? interaction.user?.id ?? null;
}

/** The command name, or `null` for a malformed payload. */
export function interactionCommandName(interaction: DiscordInteraction): string | null {
  const name = interaction.data?.name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

/** Read a STRING option by name. Returns `null` when absent or not a string. */
export function readStringOption(
  interaction: DiscordInteraction,
  name: string,
): string | null {
  const options = interaction.data?.options;
  if (!Array.isArray(options)) return null;
  const option = options.find((entry) => entry?.name === name);
  if (!option || option.type !== OPTION_TYPE_STRING) return null;
  return typeof option.value === 'string' ? option.value : null;
}

// --- Command input validation -----------------------------------------------

/** Bounds chosen to stay legible in the in-app inbox dropdown and in an embed. */
export const ANNOUNCE_TITLE_MAX = 200;
export const ANNOUNCE_MESSAGE_MAX = 1000;
export const ANNOUNCE_URL_MAX = 500;
export const PUBLISHER_ID_MAX = 64;

/**
 * A notification `action_url` is rendered as a link by the storefront, so it must
 * be either site-relative or https. Anything else (`javascript:`, `data:`, a bare
 * `http:`) is refused rather than stored and rendered later.
 */
export function isValidActionUrl(url: string): boolean {
  if (url.startsWith('/')) return !url.startsWith('//');
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

export interface AnnounceInput {
  title: string;
  message: string;
  actionUrl: string | null;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Validate the `/announce` options. Discord lets an option be optional, so the
 * required ones are checked here rather than assumed present.
 */
export function validateAnnounce(interaction: DiscordInteraction): ValidationResult<AnnounceInput> {
  const title = readStringOption(interaction, 'title')?.trim() ?? '';
  const message = readStringOption(interaction, 'message')?.trim() ?? '';
  const rawUrl = readStringOption(interaction, 'url')?.trim() ?? '';

  if (!title) return { ok: false, error: '`title` is required.' };
  if (title.length > ANNOUNCE_TITLE_MAX) {
    return { ok: false, error: `\`title\` must be at most ${ANNOUNCE_TITLE_MAX} characters.` };
  }
  if (!message) return { ok: false, error: '`message` is required.' };
  if (message.length > ANNOUNCE_MESSAGE_MAX) {
    return { ok: false, error: `\`message\` must be at most ${ANNOUNCE_MESSAGE_MAX} characters.` };
  }
  if (rawUrl && rawUrl.length > ANNOUNCE_URL_MAX) {
    return { ok: false, error: `\`url\` must be at most ${ANNOUNCE_URL_MAX} characters.` };
  }
  if (rawUrl && !isValidActionUrl(rawUrl)) {
    return { ok: false, error: '`url` must be an https URL or a site-relative path.' };
  }

  return { ok: true, value: { title, message, actionUrl: rawUrl || null } };
}

/** Validate the `/verify` option. */
export function validateVerify(
  interaction: DiscordInteraction,
): ValidationResult<{ publisherId: string }> {
  const publisherId = readStringOption(interaction, 'publisher')?.trim() ?? '';
  if (!publisherId) return { ok: false, error: '`publisher` is required.' };
  if (publisherId.length > PUBLISHER_ID_MAX) {
    return { ok: false, error: `\`publisher\` must be at most ${PUBLISHER_ID_MAX} characters.` };
  }
  // Publisher ids are URL path segments on the storefront; keep them to the shape
  // the router can actually serve rather than storing something unreachable.
  if (!/^[a-zA-Z0-9_-]+$/.test(publisherId)) {
    return {
      ok: false,
      error: '`publisher` may contain only letters, digits, hyphens and underscores.',
    };
  }
  return { ok: true, value: { publisherId } };
}

// --- Database operations ----------------------------------------------------

/**
 * Broadcast one notification to every registered user.
 *
 * A single `INSERT ... SELECT` rather than a read-then-loop: the database does the
 * fan-out, so a store with ten thousand users is still one statement and cannot
 * be interrupted halfway through. Returns the number of rows written.
 */
export async function broadcastAnnouncement(db: D1Database, input: AnnounceInput): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO user_notifications (user_github_id, type, title, message, action_url)
       SELECT github_id, 'system', ?1, ?2, ?3 FROM users`,
    )
    .bind(input.title, input.message, input.actionUrl)
    .run();
  return result.meta?.changes ?? 0;
}

export interface VerifyPublisherResult {
  /** False when no publisher has that id — the command reports it instead of lying. */
  publisherFound: boolean;
  /** How many of the publisher's listings were marked verified. */
  pluginsUpdated: number;
}

/**
 * Mark a publisher verified, and every listing they own along with it.
 *
 * The two writes are one batch so a publisher can never be verified while their
 * listings still show the unverified badge.
 */
export async function verifyPublisher(
  db: D1Database,
  publisherId: string,
): Promise<VerifyPublisherResult> {
  const [publisherResult, pluginsResult] = await db.batch([
    db.prepare('UPDATE publishers SET verified = 1 WHERE id = ?1').bind(publisherId),
    db.prepare('UPDATE plugins SET publisher_verified = 1 WHERE publisher_id = ?1').bind(publisherId),
  ]);

  return {
    publisherFound: (publisherResult.meta?.changes ?? 0) > 0,
    pluginsUpdated: pluginsResult.meta?.changes ?? 0,
  };
}

export interface StoreStats {
  plugins: number;
  downloads: number;
  publishers: number;
  users: number;
}

/** The four counts the `/stats` card shows, in one round trip. */
export async function collectStoreStats(db: D1Database): Promise<StoreStats> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*)              FROM plugins)    AS plugins,
         (SELECT COALESCE(SUM(downloads), 0) FROM plugins) AS downloads,
         (SELECT COUNT(*)              FROM publishers) AS publishers,
         (SELECT COUNT(*)              FROM users)      AS users`,
    )
    .first<StoreStats>();
  return {
    plugins: row?.plugins ?? 0,
    downloads: row?.downloads ?? 0,
    publishers: row?.publishers ?? 0,
    users: row?.users ?? 0,
  };
}

/** How many listings a publisher currently owns — the deletion alert's last field. */
export async function countPublisherPlugins(db: D1Database, publisherId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS count FROM plugins WHERE publisher_id = ?1')
    .bind(publisherId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

// --- Embed builders ---------------------------------------------------------

/** Discord embed colours, as the 24-bit integers the API expects. */
export const EMBED_COLOR_BRAND = 0x22d3ee; // cyan-400
export const EMBED_COLOR_SUCCESS = 0x22c55e; // green-500
export const EMBED_COLOR_DANGER = 0xef4444; // red-500

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : plural}`;
}

export function announceConfirmationEmbed(recipients: number): DiscordEmbed {
  return {
    title: '📢 Broadcast sent to all store users!',
    description: `Delivered to ${pluralize(recipients, 'registered user')}.`,
    color: EMBED_COLOR_BRAND,
  };
}

export function verifyConfirmationEmbed(publisherId: string, pluginsUpdated: number): DiscordEmbed {
  return {
    title: `💙 Publisher @${publisherId} is now officially verified!`,
    description: `${pluralize(pluginsUpdated, 'listing')} marked verified.`,
    color: EMBED_COLOR_SUCCESS,
  };
}

export function statsEmbed(stats: StoreStats): DiscordEmbed {
  return {
    title: '📊 OpenROM Store — Live Stats',
    color: EMBED_COLOR_BRAND,
    fields: [
      { name: 'Extensions', value: stats.plugins.toLocaleString('en-US'), inline: true },
      { name: 'Downloads', value: stats.downloads.toLocaleString('en-US'), inline: true },
      { name: 'Publishers', value: stats.publishers.toLocaleString('en-US'), inline: true },
      { name: 'Users', value: stats.users.toLocaleString('en-US'), inline: true },
    ],
    timestamp: new Date().toISOString(),
  };
}

export interface DeletionRequestAlert {
  publisherId: string;
  /** GitHub id of the owner who filed the request. */
  requestedBy: string;
  reason: string;
  /** How many listings would disappear if the request were approved. */
  activePlugins: number;
}

export function deletionRequestEmbed(alert: DeletionRequestAlert): DiscordEmbed {
  return {
    title: `🚨 Publisher Deletion Request: @${alert.publisherId}`,
    color: EMBED_COLOR_DANGER,
    fields: [
      { name: 'Requested by', value: alert.requestedBy, inline: true },
      { name: 'Active plugins', value: String(alert.activePlugins), inline: true },
      { name: 'Reason', value: alert.reason || '_(none given)_' },
    ],
    timestamp: new Date().toISOString(),
  };
}

// --- Outgoing webhook -------------------------------------------------------

export interface DiscordWebhookPayload {
  content?: string;
  embeds?: DiscordEmbed[];
}

/**
 * Post a message to a Discord channel webhook.
 *
 * Deliberately best-effort: the alert is a courtesy on top of an action that has
 * already been recorded, so a Discord outage must never surface as a failed
 * deletion request. Errors are logged and swallowed, matching how
 * `createNotification` treats the in-app inbox.
 */
export async function sendDiscordWebhook(
  url: string,
  payload: DiscordWebhookPayload,
): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      console.error(`Discord webhook responded ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Failed to dispatch Discord webhook', error);
    return false;
  }
}
