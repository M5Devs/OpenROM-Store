/**
 * Publisher teams: the role model, the permission matrix, and D1 access for
 * membership, invitations, and deletion requests.
 *
 * Identity is the numeric GitHub id — the same key `publishers.owner_github_id`
 * uses — because a username can be renamed. The display username is only ever used
 * to *look up* that id (see resolveInvitee).
 *
 * Ownership is derived, not stored twice: a publisher's `owner_github_id` column is
 * the source of truth for who owns it, and `resolveMembership` treats a matching
 * user as `owner` even if the `publisher_members` row is missing or stale. The
 * membership table exists to grant *additional* roles and to record the audit trail
 * (who invited whom, and when they accepted).
 */

import { getPublisher, toPublisher, type Publisher, type PublisherRow } from './publishers.ts';

export const TEAM_ROLES = ['owner', 'admin', 'contributor', 'viewer'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/** The roles an owner/admin may hand out. `owner` is excluded — see below. */
export const ASSIGNABLE_ROLES = ['admin', 'contributor', 'viewer'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const INVITE_STATUSES = ['pending', 'accepted', 'declined'] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

/**
 * The permission matrix. Capabilities are named after the action, not the route, so
 * a new endpoint declares the capability it needs instead of re-deriving the rules.
 *
 * `transfer_ownership` and `request_deletion` are owner-only. `manage_roles` is
 * admin-and-up, but is never used to grant or revoke `owner` — see `canAssignRole`.
 */
export const PERMISSIONS = {
  owner: [
    'view_analytics',
    'edit_profile',
    'manage_extensions',
    'publish_versions',
    'invite_members',
    'manage_roles',
    'remove_members',
    'request_deletion',
    'transfer_ownership',
  ],
  admin: [
    'view_analytics',
    'edit_profile',
    'manage_extensions',
    'publish_versions',
    'invite_members',
    'manage_roles',
    'remove_members',
  ],
  contributor: ['view_analytics', 'edit_profile', 'manage_extensions', 'publish_versions'],
  viewer: ['view_analytics'],
} as const satisfies Record<TeamRole, readonly string[]>;

export type Capability = (typeof PERMISSIONS)[TeamRole][number];

export function can(role: TeamRole, capability: Capability): boolean {
  return (PERMISSIONS[role] as readonly string[]).includes(capability);
}

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === 'string' && (TEAM_ROLES as readonly string[]).includes(value);
}

export function isAssignableRole(value: unknown): value is AssignableRole {
  return typeof value === 'string' && (ASSIGNABLE_ROLES as readonly string[]).includes(value);
}

/**
 * Whether `actorRole` may grant `targetRole`.
 *
 * The invariant the brief calls out — an admin "cannot demote owner" — is enforced
 * here: only an owner may create another owner, and nobody may use the invite path
 * to mint one (ownership moves via transfer, not invitation). An admin therefore
 * cannot touch the owner's role at all, because they cannot assign `owner`.
 */
export function canAssignRole(actorRole: TeamRole, targetRole: TeamRole): boolean {
  if (targetRole === 'owner') return actorRole === 'owner';
  return can(actorRole, 'manage_roles');
}

/** Whether `actorRole` may change or remove a member who currently holds `currentRole`. */
export function canManageMember(actorRole: TeamRole, currentRole: TeamRole): boolean {
  if (currentRole === 'owner') return false; // ownership is never revoked by a role change
  if (actorRole === 'owner') return true;
  if (actorRole !== 'admin') return false;
  return currentRole !== 'admin'; // an admin may not demote or remove a peer admin
}

// --- Rows -------------------------------------------------------------------

export interface MemberRow {
  publisher_id: string;
  user_github_id: string;
  role: string;
  status: string;
  invited_by_github_id: string;
  created_at: string;
  updated_at: string;
}

export interface TeamMember {
  publisherId: string;
  userGithubId: string;
  role: TeamRole;
  status: InviteStatus;
  invitedByGithubId: string;
  createdAt: string;
  updatedAt: string;
}

/** The acting user's relationship to a publisher. */
export interface Membership {
  role: TeamRole;
  /** False while an invitation is still `pending` or was `declined`. */
  active: boolean;
}

function asRole(value: string): TeamRole {
  return isTeamRole(value) ? value : 'viewer';
}

function asStatus(value: string): InviteStatus {
  return (INVITE_STATUSES as readonly string[]).includes(value)
    ? (value as InviteStatus)
    : 'pending';
}

export function toTeamMember(row: MemberRow): TeamMember {
  return {
    publisherId: row.publisher_id,
    userGithubId: row.user_github_id,
    role: asRole(row.role),
    status: asStatus(row.status),
    invitedByGithubId: row.invited_by_github_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- Membership resolution --------------------------------------------------

/**
 * Resolve a user's effective membership.
 *
 * The owner column wins outright: if `publisher.owner_github_id` matches, the user
 * is an active owner regardless of what the members table says. This keeps the
 * owner's access working even if the backfill in migration 0011 was never applied,
 * and means a stale or malicious members row can never *elevate* someone to owner.
 */
export function resolveMembership(
  publisher: Pick<Publisher, 'ownerGithubId'>,
  member: Pick<MemberRow, 'role' | 'status'> | null,
  githubId: string,
): Membership | null {
  if (publisher.ownerGithubId === githubId) {
    return { role: 'owner', active: true };
  }
  if (!member) return null;
  const status = asStatus(member.status);
  return { role: asRole(member.role), active: status === 'accepted' };
}

// --- D1 access --------------------------------------------------------------

export async function getMember(
  db: D1Database,
  publisherId: string,
  githubId: string,
): Promise<MemberRow | null> {
  return db
    .prepare('SELECT * FROM publisher_members WHERE publisher_id = ? AND user_github_id = ?')
    .bind(publisherId, githubId)
    .first<MemberRow>();
}

/** A publisher the user can act on, with the role they hold and the invite state. */
export interface PublisherAccess {
  publisher: Publisher;
  role: TeamRole;
  status: InviteStatus;
}

/**
 * Every publisher a user has an accepted membership in. The dashboard uses this to
 * show collaborators the publishers they can help with, alongside the ones they own.
 */
export async function listAccessiblePublishers(
  db: D1Database,
  githubId: string,
): Promise<PublisherAccess[]> {
  const { results } = await db
    .prepare(
      `SELECT p.*, m.role AS member_role, m.status AS member_status
         FROM publisher_members m
         JOIN publishers p ON p.id = m.publisher_id
        WHERE m.user_github_id = ?
        ORDER BY p.created_at DESC`,
    )
    .bind(githubId)
    .all<PublisherRow & { member_role: string; member_status: string }>();

  return (results ?? []).map((row) => ({
    publisher: toPublisher(row),
    role: asRole(row.member_role),
    status: asStatus(row.member_status),
  }));
}

export async function listMembers(db: D1Database, publisherId: string): Promise<TeamMember[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM publisher_members
        WHERE publisher_id = ?
        ORDER BY CASE role
                   WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
                   WHEN 'contributor' THEN 2 ELSE 3 END,
                 created_at ASC`,
    )
    .bind(publisherId)
    .all<MemberRow>();
  return (results ?? []).map(toTeamMember);
}

/** A user's own memberships — the invitations they can act on. */
export async function listMembershipsForUser(
  db: D1Database,
  githubId: string,
): Promise<TeamMember[]> {
  const { results } = await db
    .prepare('SELECT * FROM publisher_members WHERE user_github_id = ? ORDER BY created_at DESC')
    .bind(githubId)
    .all<MemberRow>();
  return (results ?? []).map(toTeamMember);
}

/** A member plus the display fields the team roster shows. */
export interface TeamMemberView extends TeamMember {
  githubUsername: string;
  name: string | null;
  avatarUrl: string | null;
}

interface MemberViewRow extends MemberRow {
  github_username: string | null;
  name: string | null;
  avatar_url: string | null;
}

/**
 * The team roster with each member's GitHub identity. A member who has never signed
 * in has no `users` row, so the join is a LEFT JOIN and the username falls back to
 * the id — a row must never disappear from the roster just because it cannot be
 * decorated.
 */
export async function listTeam(db: D1Database, publisherId: string): Promise<TeamMemberView[]> {
  const { results } = await db
    .prepare(
      `SELECT m.*, u.github_username, u.name, u.avatar_url
         FROM publisher_members m
         LEFT JOIN users u ON u.github_id = m.user_github_id
        WHERE m.publisher_id = ?
        ORDER BY CASE m.role
                   WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
                   WHEN 'contributor' THEN 2 ELSE 3 END,
                 m.created_at ASC`,
    )
    .bind(publisherId)
    .all<MemberViewRow>();
  return (results ?? []).map((row) => ({
    ...toTeamMember(row),
    githubUsername: row.github_username ?? row.user_github_id,
    name: row.name ?? null,
    avatarUrl: row.avatar_url ?? null,
  }));
}

export interface InviteInput {
  publisherId: string;
  userGithubId: string;
  role: AssignableRole;
  invitedByGithubId: string;
}

/**
 * Create or re-arm an invitation.
 *
 * `ON CONFLICT` re-inviting an existing row resets it to `pending` with the new
 * role — which is what an owner means by "invite them again" after a decline — but
 * it will not silently flip a *self-invited owner* row, because `invited_by` is
 * rewritten alongside it and the role is constrained to the assignable set by the
 * caller. `updated_at` is bumped so the audit trail shows the re-invite.
 */
export async function inviteMember(db: D1Database, input: InviteInput): Promise<MemberRow> {
  const row = await db
    .prepare(
      `INSERT INTO publisher_members
         (publisher_id, user_github_id, role, status, invited_by_github_id)
       VALUES (?1, ?2, ?3, 'pending', ?4)
       ON CONFLICT (publisher_id, user_github_id) DO UPDATE SET
         role                 = excluded.role,
         status               = 'pending',
         invited_by_github_id = excluded.invited_by_github_id,
         updated_at           = CURRENT_TIMESTAMP
       RETURNING *`,
    )
    .bind(input.publisherId, input.userGithubId, input.role, input.invitedByGithubId)
    .first<MemberRow>();

  if (!row) throw new Error('Failed to create the invitation.');
  return row;
}

/**
 * Accept or decline a pending invitation for one specific user.
 *
 * The `user_github_id` predicate is the authorization boundary: a user can only
 * respond to their own invitation. Only a `pending` row transitions, so a replayed
 * request cannot flip an already-accepted membership to declined.
 */
export async function respondToInvite(
  db: D1Database,
  publisherId: string,
  githubId: string,
  status: Extract<InviteStatus, 'accepted' | 'declined'>,
): Promise<MemberRow | null> {
  const row = await db
    .prepare(
      `UPDATE publisher_members
          SET status = ?1, updated_at = CURRENT_TIMESTAMP
        WHERE publisher_id = ?2 AND user_github_id = ?3 AND status = 'pending'
        RETURNING *`,
    )
    .bind(status, publisherId, githubId)
    .first<MemberRow>();
  return row ?? null;
}

export async function setMemberRole(
  db: D1Database,
  publisherId: string,
  githubId: string,
  role: AssignableRole,
): Promise<MemberRow | null> {
  const row = await db
    .prepare(
      `UPDATE publisher_members
          SET role = ?1, updated_at = CURRENT_TIMESTAMP
        WHERE publisher_id = ?2 AND user_github_id = ?3
        RETURNING *`,
    )
    .bind(role, publisherId, githubId)
    .first<MemberRow>();
  return row ?? null;
}

/**
 * Remove a member. `role <> 'owner'` is a second guard behind the permission check:
 * the owner's membership row is never deleted by this path.
 */
export async function removeMember(
  db: D1Database,
  publisherId: string,
  githubId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `DELETE FROM publisher_members
        WHERE publisher_id = ? AND user_github_id = ? AND role <> 'owner'
        RETURNING user_github_id`,
    )
    .bind(publisherId, githubId)
    .first<{ user_github_id: string }>();
  return row !== null;
}

// --- Deletion governance ----------------------------------------------------

export interface DeletionRequestRow {
  id: number;
  publisher_id: string;
  requested_by_github_id: string;
  reason: string;
  status: string;
  created_at: string;
}

export interface DeletionRequest {
  id: number;
  publisherId: string;
  requestedByGithubId: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

export function toDeletionRequest(row: DeletionRequestRow): DeletionRequest {
  const status =
    row.status === 'approved' || row.status === 'rejected' ? row.status : 'pending';
  return {
    id: row.id,
    publisherId: row.publisher_id,
    requestedByGithubId: row.requested_by_github_id,
    reason: row.reason,
    status,
    createdAt: row.created_at,
  };
}

export const DELETION_REASON_MIN = 10;
export const DELETION_REASON_MAX = 1000;

export function validateDeletionReason(value: unknown): string | null {
  if (typeof value !== 'string') return 'A reason is required.';
  const reason = value.trim();
  if (reason.length < DELETION_REASON_MIN) {
    return `Please give at least ${DELETION_REASON_MIN} characters of reason.`;
  }
  if (reason.length > DELETION_REASON_MAX) {
    return `Reason must be ${DELETION_REASON_MAX} characters or fewer.`;
  }
  return null;
}

/** The open request for a publisher, if any — drives the dashboard banner. */
export async function getPendingDeletionRequest(
  db: D1Database,
  publisherId: string,
): Promise<DeletionRequest | null> {
  const row = await db
    .prepare(
      `SELECT * FROM publisher_deletion_requests
        WHERE publisher_id = ? AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(publisherId)
    .first<DeletionRequestRow>();
  return row ? toDeletionRequest(row) : null;
}

export async function createDeletionRequest(
  db: D1Database,
  publisherId: string,
  requestedByGithubId: string,
  reason: string,
): Promise<DeletionRequest> {
  const row = await db
    .prepare(
      `INSERT INTO publisher_deletion_requests
         (publisher_id, requested_by_github_id, reason, status)
       VALUES (?1, ?2, ?3, 'pending')
       RETURNING *`,
    )
    .bind(publisherId, requestedByGithubId, reason)
    .first<DeletionRequestRow>();

  if (!row) throw new Error('Failed to record the deletion request.');
  return toDeletionRequest(row);
}

// --- Invitee resolution -----------------------------------------------------

export const GITHUB_USERNAME_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

export function validateGitHubUsername(value: unknown): string | null {
  if (typeof value !== 'string') return 'A GitHub username is required.';
  const username = value.trim().replace(/^@/, '');
  if (username.length === 0) return 'A GitHub username is required.';
  if (username.length > 39) return 'That is not a valid GitHub username.';
  if (!GITHUB_USERNAME_PATTERN.test(username)) return 'That is not a valid GitHub username.';
  return null;
}

/** Normalize a username for a case-insensitive lookup (`@Foo` -> `foo`). */
export function normalizeUsername(value: string): string {
  return value.trim().replace(/^@/, '').toLowerCase();
}

export interface Invitee {
  githubId: string;
  githubUsername: string;
}

/**
 * Look up the invitee by GitHub username, case-insensitively.
 *
 * Only accounts that have signed in to the marketplace can be found: a
 * `publisher_members` row is keyed on `github_id`, and resolving a username to an id
 * would otherwise mean calling the GitHub API on every invite. A user who has never
 * signed in simply does not exist here yet — the caller reports that plainly rather
 * than writing a row keyed on a username that may later be renamed.
 */
export async function findUserByUsername(
  db: D1Database,
  username: string,
): Promise<Invitee | null> {
  const row = await db
    .prepare(
      'SELECT github_id, github_username FROM users WHERE lower(github_username) = ? LIMIT 1',
    )
    .bind(normalizeUsername(username))
    .first<{ github_id: string; github_username: string }>();
  return row ? { githubId: row.github_id, githubUsername: row.github_username } : null;
}

// --- Authorization ----------------------------------------------------------

export type AccessResult =
  | { status: 'ok'; publisher: Publisher; membership: Membership }
  | { status: 'not-found' }
  | { status: 'error'; error: unknown }
  | { status: 'forbidden'; membership: Membership | null };

/**
 * Resolve a publisher and the caller's membership in one step, so every team
 * endpoint enforces the same rule and a missing table is reported as an outage
 * rather than a 404 (the failure mode a bare `getPublisher` would hide).
 *
 * `requireCapability` is the whole authorization policy: the caller names the
 * capability it needs and this decides. Keeping it here — not scattered across
 * route files — is what makes the permission matrix testable.
 */
export async function authorizePublisher(
  db: D1Database,
  publisherId: string,
  githubId: string,
  requireCapability: Capability,
): Promise<AccessResult> {
  let publisher: Publisher | null;
  let member: MemberRow | null;
  try {
    publisher = await getPublisher(db, publisherId);
    member = publisher ? await getMember(db, publisherId, githubId) : null;
  } catch (error) {
    return { status: 'error', error };
  }

  if (!publisher) return { status: 'not-found' };

  const membership = resolveMembership(publisher, member, githubId);
  // An inactive membership (pending/declined invite) grants nothing.
  if (!membership || !membership.active || !can(membership.role, requireCapability)) {
    return { status: 'forbidden', membership };
  }
  return { status: 'ok', publisher, membership };
}

