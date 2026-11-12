/// <reference types="astro/client" />

interface Env {
  DB: D1Database;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;

  /** Discord application public key (hex) — verifies interaction signatures. */
  DISCORD_PUBLIC_KEY?: string;
  /** Discord user id allowed to run admin slash commands. */
  DISCORD_OWNER_USER_ID?: string;
  /** Channel webhook the admin alerts are posted to. */
  DISCORD_ADMIN_WEBHOOK_URL?: string;
}

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {}
}
