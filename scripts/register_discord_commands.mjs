#!/usr/bin/env node
/**
 * Register the store's slash commands with Discord.
 *
 * Run once after creating the application, and again whenever a command's name,
 * description or options change. Discord owns the command list, so this is a
 * push, not a sync: each call overwrites the definition of any command whose name
 * already exists, and leaves the others alone.
 *
 * Usage:
 *
 *   DISCORD_BOT_TOKEN=... DISCORD_APPLICATION_ID=... \
 *     node scripts/register_discord_commands.mjs
 *
 * Add `DISCORD_GUILD_ID` to register into a single server. Guild commands appear
 * instantly, which is what you want while iterating; global commands can take up
 * to an hour to propagate but work in every server the app is installed in. Use
 * the guild form first, then re-run without it to publish globally.
 *
 * No dependencies — the Discord API is a plain JSON REST API and Node has fetch.
 */

const API = 'https://discord.com/api/v10';

/** Discord's option type ids. */
const OPTION_TYPE_STRING = 3;

/**
 * The three operator commands.
 *
 * `description` is capped at 100 characters by Discord; `name` must be lowercase
 * and 1-32 characters. `required` is set explicitly because Discord treats a
 * missing `required` as optional.
 */
export const COMMANDS = [
  {
    name: 'announce',
    description: 'Broadcast an in-app notification to every registered store user',
    options: [
      {
        type: OPTION_TYPE_STRING,
        name: 'title',
        description: 'Notification title (max 200 characters)',
        required: true,
        max_length: 200,
      },
      {
        type: OPTION_TYPE_STRING,
        name: 'message',
        description: 'Notification body (max 1000 characters)',
        required: true,
        max_length: 1000,
      },
      {
        type: OPTION_TYPE_STRING,
        name: 'url',
        description: 'Optional link the notification opens (https URL or /path)',
        required: false,
        max_length: 500,
      },
    ],
  },
  {
    name: 'verify',
    description: 'Mark a publisher as verified, along with all of their listings',
    options: [
      {
        type: OPTION_TYPE_STRING,
        name: 'publisher',
        description: 'The publisher id (the slug in their profile URL)',
        required: true,
        max_length: 64,
      },
    ],
  },
  {
    name: 'stats',
    description: 'Show live catalog totals: extensions, downloads, publishers, users',
    options: [],
  },
];

/** Resolve configuration from the environment, failing loudly when incomplete. */
export function readConfig(env = process.env) {
  const token = env.DISCORD_BOT_TOKEN;
  const applicationId = env.DISCORD_APPLICATION_ID;
  const guildId = env.DISCORD_GUILD_ID || null;

  const missing = [];
  if (!token) missing.push('DISCORD_BOT_TOKEN');
  if (!applicationId) missing.push('DISCORD_APPLICATION_ID');
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }

  return { token, applicationId, guildId };
}

/**
 * The registration URL. Global commands live under `/applications/<id>/commands`;
 * guild-scoped ones add `/guilds/<id>` in the middle.
 */
export function commandsUrl(applicationId, guildId) {
  const base = `${API}/applications/${applicationId}`;
  return guildId ? `${base}/guilds/${guildId}/commands` : `${base}/commands`;
}

async function registerCommand(config, command) {
  const response = await fetch(commandsUrl(config.applicationId, config.guildId), {
    method: 'POST',
    headers: {
      Authorization: `Bot ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Failed to register /${command.name}: HTTP ${response.status} ${text}`);
  }

  let registered;
  try {
    registered = JSON.parse(text);
  } catch {
    throw new Error(`Unexpected non-JSON response for /${command.name}: ${text}`);
  }
  return registered;
}

async function main() {
  const config = readConfig();
  const scope = config.guildId ? `guild ${config.guildId}` : 'globally';

  console.log(`Registering ${COMMANDS.length} commands ${scope}…`);

  for (const command of COMMANDS) {
    const registered = await registerCommand(config, command);
    console.log(`  ✓ /${registered.name} (id ${registered.id})`);
  }

  console.log(
    config.guildId
      ? '\nDone. Guild commands are available immediately.'
      : '\nDone. Global commands may take up to an hour to appear in every server.',
  );
}

// Only run when invoked directly, so the exports above stay importable from tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
