import type { APIRoute } from 'astro';
import { getDB } from '../../../lib/db.ts';
import {
  INTERACTION_APPLICATION_COMMAND,
  INTERACTION_PING,
  announceConfirmationEmbed,
  broadcastAnnouncement,
  collectStoreStats,
  ephemeralResponse,
  interactionCommandName,
  interactionUserId,
  messageResponse,
  pongResponse,
  sendDiscordWebhook,
  statsEmbed,
  unauthorizedResponse,
  validateAnnounce,
  validateVerify,
  verifyConfirmationEmbed,
  verifyDiscordSignature,
  verifyPublisher,
  type DiscordInteraction,
} from '../../../lib/discord.ts';

export const prerender = false;

/**
 * Discord's HTTP interactions endpoint.
 *
 * Discord POSTs every interaction here and expects a JSON response within three
 * seconds — no gateway connection, no long-running process. Register the URL in
 * the Developer Portal; Discord immediately sends a PING that this route answers
 * with a PONG, which is how the endpoint is verified.
 *
 * Security is in two layers. The signature proves the request came from Discord;
 * the owner check proves the *person* may run the command. A valid signature is
 * not authorization, so both are enforced.
 *
 * The raw body is read as text and verified before it is parsed. Re-serialising
 * the JSON would change the bytes and invalidate the signature, so the text form
 * is the only one that can be verified.
 */
export const POST: APIRoute = async (context) => {
  const env = context.locals.runtime?.env;
  const publicKey = env?.DISCORD_PUBLIC_KEY;
  if (!publicKey) {
    console.error('DISCORD_PUBLIC_KEY is not configured; rejecting interaction');
    return unauthorizedResponse();
  }

  // Read once, verify the exact bytes, then parse.
  const rawBody = await context.request.text();

  const signatureValid = await verifyDiscordSignature({
    publicKey,
    signature: context.request.headers.get('x-signature-ed25519'),
    timestamp: context.request.headers.get('x-signature-timestamp'),
    body: rawBody,
  });
  if (!signatureValid) return unauthorizedResponse();

  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(rawBody) as DiscordInteraction;
  } catch {
    // Signed, but not JSON. Discord never sends this; treat it as a bad request.
    return new Response('invalid interaction payload', { status: 400 });
  }

  // Endpoint registration handshake. Must be answered before anything else.
  if (interaction?.type === INTERACTION_PING) return pongResponse();

  if (interaction?.type !== INTERACTION_APPLICATION_COMMAND) {
    return ephemeralResponse('Unsupported interaction type.');
  }

  // --- Authorization: signature is not permission --------------------------
  const ownerUserId = env?.DISCORD_OWNER_USER_ID;
  if (!ownerUserId) {
    console.error('DISCORD_OWNER_USER_ID is not configured; refusing to run commands');
    return ephemeralResponse('The bot is not configured for any operator.');
  }
  if (interactionUserId(interaction) !== ownerUserId) {
    return ephemeralResponse('⛔ You are not authorized to use this command.');
  }

  const command = interactionCommandName(interaction);
  if (!command || !KNOWN_COMMANDS.has(command)) {
    return ephemeralResponse(`Unknown command: \`${command ?? '(none)'}\`.`);
  }

  let db: D1Database;
  try {
    db = getDB(context.locals);
  } catch (error) {
    console.error('D1 binding unavailable', error);
    return ephemeralResponse('The store database is temporarily unavailable.');
  }

  switch (command) {
    case 'announce':
      return handleAnnounce(db, interaction);
    case 'verify':
      return handleVerify(db, interaction, env?.DISCORD_ADMIN_WEBHOOK_URL);
    default:
      return handleStats(db);
  }
};

/** The commands this endpoint implements, so an unknown name fails before any I/O. */
const KNOWN_COMMANDS = new Set(['announce', 'verify', 'stats']);

/**
 * `/announce` — broadcast an in-app notification to every registered user.
 *
 * One `INSERT ... SELECT` fans out across the whole `users` table, so the cost
 * does not grow with a read-then-loop and the write cannot stop halfway.
 */
async function handleAnnounce(db: D1Database, interaction: DiscordInteraction): Promise<Response> {
  const validation = validateAnnounce(interaction);
  if (!validation.ok) return ephemeralResponse(validation.error);

  try {
    const recipients = await broadcastAnnouncement(db, validation.value);
    return messageResponse('📢 Broadcast sent to all store users!', [
      announceConfirmationEmbed(recipients),
    ]);
  } catch (error) {
    console.error('Failed to broadcast announcement', error);
    return ephemeralResponse('The broadcast could not be sent. Nothing was delivered.');
  }
}

/** `/verify` — mark a publisher verified, and every listing they own with them. */
async function handleVerify(
  db: D1Database,
  interaction: DiscordInteraction,
  adminWebhookUrl: string | undefined,
): Promise<Response> {
  const validation = validateVerify(interaction);
  if (!validation.ok) return ephemeralResponse(validation.error);

  const { publisherId } = validation.value;

  try {
    const result = await verifyPublisher(db, publisherId);

    // No row matched: say so rather than reporting a verification that never
    // happened. The operator most likely mistyped the slug.
    if (!result.publisherFound) {
      return ephemeralResponse(`No publisher found with the id \`${publisherId}\`.`);
    }

    if (adminWebhookUrl) {
      await sendDiscordWebhook(adminWebhookUrl, {
        embeds: [verifyConfirmationEmbed(publisherId, result.pluginsUpdated)],
      });
    }

    return messageResponse(`💙 Publisher \`@${publisherId}\` is now officially verified!`, [
      verifyConfirmationEmbed(publisherId, result.pluginsUpdated),
    ]);
  } catch (error) {
    console.error(`Failed to verify publisher "${publisherId}"`, error);
    return ephemeralResponse('The publisher could not be verified.');
  }
}

/** `/stats` — catalog totals, read live from D1. */
async function handleStats(db: D1Database): Promise<Response> {
  try {
    const stats = await collectStoreStats(db);
    return messageResponse('📊 OpenROM Store — Live Stats', [statsEmbed(stats)]);
  } catch (error) {
    console.error('Failed to collect store stats', error);
    return ephemeralResponse('The stats are temporarily unavailable.');
  }
}
