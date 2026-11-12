/**
 * D1 access layer for GitHub accounts.
 *
 * `github_id` is the stable identity key: a user may rename their GitHub handle,
 * but the numeric id never changes, so it — not the username — anchors every
 * foreign key. The username is refreshed on each login.
 *
 * `name` and `avatar_url` are also refreshed on each login *unless* the user has
 * saved a custom profile (`profile_customized = 1`), in which case their own values
 * win. Without that guard a custom avatar would be wiped by the next sign-in.
 */

import type { SessionUser } from './session.ts';

export interface UserRow {
  id: number;
  github_id: string;
  github_username: string;
  name: string | null;
  avatar_url: string | null;
  created_at: string;
  profile_customized: number;
}

export interface User {
  githubId: string;
  githubUsername: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface GitHubProfile {
  id: number | string;
  login: string;
  name?: string | null;
  avatar_url?: string | null;
}

export function toUser(row: UserRow): User {
  return {
    githubId: row.github_id,
    githubUsername: row.github_username,
    name: row.name,
    avatarUrl: row.avatar_url,
  };
}

/**
 * The public-facing profile. A user who has customized their profile keeps their
 * own display name and avatar; everyone else falls back to the GitHub values that
 * the session cookie carries.
 *
 * The custom avatar lives only in D1 — it can be a base64 data URL far larger than
 * the ~4 KB cookie limit — so pages read it from the database rather than the session.
 */
export interface UserProfile {
  githubId: string;
  githubUsername: string;
  name: string;
  avatarUrl: string;
  customized: boolean;
}

export function toUserProfile(
  session: Pick<SessionUser, 'githubId' | 'githubUsername' | 'name' | 'avatarUrl'>,
  row: UserRow | null,
): UserProfile {
  const customized = Boolean(row?.profile_customized);
  // An empty custom value is treated as "unset" and falls back to GitHub.
  const customName = customized && row?.name ? row.name : null;
  const customAvatar = customized && row?.avatar_url ? row.avatar_url : null;
  return {
    githubId: session.githubId,
    githubUsername: session.githubUsername,
    name: customName ?? session.name ?? session.githubUsername,
    avatarUrl: customAvatar ?? session.avatarUrl ?? '',
    customized,
  };
}

export async function getUserProfile(
  db: D1Database,
  session: Pick<SessionUser, 'githubId' | 'githubUsername' | 'name' | 'avatarUrl'>,
): Promise<UserProfile> {
  const row = await getUserByGithubId(db, session.githubId);
  return toUserProfile(session, row);
}

/**
 * Insert the account, or refresh its mutable fields if it already exists. A user
 * who has customized their profile keeps their own `name`/`avatar_url`.
 */
export async function upsertUser(db: D1Database, profile: GitHubProfile): Promise<UserRow> {
  const githubId = String(profile.id);
  const row = await db
    .prepare(
      `INSERT INTO users (github_id, github_username, name, avatar_url)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (github_id) DO UPDATE SET
         github_username = excluded.github_username,
         name            = CASE WHEN users.profile_customized = 1
                                THEN users.name ELSE excluded.name END,
         avatar_url      = CASE WHEN users.profile_customized = 1
                                THEN users.avatar_url ELSE excluded.avatar_url END
       RETURNING *`,
    )
    .bind(githubId, profile.login, profile.name ?? null, profile.avatar_url ?? null)
    .first<UserRow>();

  if (!row) {
    throw new Error('Failed to persist GitHub user record.');
  }
  return row;
}

/**
 * The session cookie carries the *GitHub* identity only.
 *
 * An uploaded avatar is far larger than the ~4 KB cookie limit, so custom profile
 * values live in D1 and are overlaid at render time by `toUserProfile`. Building the
 * cookie from the GitHub profile — never from the stored row, which may hold a
 * multi-megabyte data URL — keeps the cookie small and keeps the GitHub fallback
 * intact for a user who has cleared their custom avatar.
 */
export function sessionUserFromGitHubProfile(profile: GitHubProfile): {
  githubId: string;
  githubUsername: string;
  name: string | null;
  avatarUrl: string | null;
} {
  return {
    githubId: String(profile.id),
    githubUsername: profile.login,
    name: profile.name ?? null,
    avatarUrl: profile.avatar_url ?? null,
  };
}

export async function getUserByGithubId(
  db: D1Database,
  githubId: string,
): Promise<UserRow | null> {
  return db
    .prepare('SELECT * FROM users WHERE github_id = ?')
    .bind(githubId)
    .first<UserRow>();
}

export interface UserProfileInput {
  name: string;
  /** Empty string falls back to the GitHub avatar. */
  avatarUrl: string;
}

/**
 * Save a user's custom profile and mark it customized so future logins stop
 * overwriting it. Only the user's own row can be touched — the `github_id`
 * predicate is the authorization boundary.
 */
export async function updateUserProfile(
  db: D1Database,
  githubId: string,
  input: UserProfileInput,
): Promise<UserRow | null> {
  const row = await db
    .prepare(
      `UPDATE users
          SET name = ?1,
              avatar_url = ?2,
              profile_customized = 1
        WHERE github_id = ?3
        RETURNING *`,
    )
    .bind(input.name, input.avatarUrl === '' ? null : input.avatarUrl, githubId)
    .first<UserRow>();

  return row ?? null;
}
