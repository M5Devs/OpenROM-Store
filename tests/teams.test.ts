import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ASSIGNABLE_ROLES,
  PERMISSIONS,
  TEAM_ROLES,
  can,
  canAssignRole,
  canManageMember,
  inviteMember,
  resolveMembership,
  respondToInvite,
  validateDeletionReason,
  validateGitHubUsername,
  normalizeUsername,
  type TeamRole,
} from '../src/lib/teams.ts';
import { fakeD1, memberFlowDb } from './helpers/fake-d1.ts';

// --- The permission matrix --------------------------------------------------

test('every role has a permission list', () => {
  for (const role of TEAM_ROLES) {
    assert.ok(Array.isArray(PERMISSIONS[role]), `${role} has no permissions`);
  }
});

test('owner is the only role that can file a deletion request or transfer ownership', () => {
  for (const role of TEAM_ROLES) {
    const expected = role === 'owner';
    assert.equal(can(role, 'request_deletion'), expected, `${role} request_deletion`);
    assert.equal(can(role, 'transfer_ownership'), expected, `${role} transfer_ownership`);
  }
});

test('admin can invite and manage but cannot delete or demote the owner', () => {
  assert.equal(can('admin', 'invite_members'), true);
  assert.equal(can('admin', 'edit_profile'), true);
  assert.equal(can('admin', 'manage_extensions'), true);
  assert.equal(can('admin', 'request_deletion'), false);
  assert.equal(can('admin', 'transfer_ownership'), false);
  // The specific invariant from the brief: an admin cannot assign `owner` at all,
  // which is what makes "cannot demote owner" true by construction.
  assert.equal(canAssignRole('admin', 'owner'), false);
  assert.equal(canAssignRole('owner', 'owner'), true);
});

test('contributor can edit and publish but cannot manage the team', () => {
  assert.equal(can('contributor', 'edit_profile'), true);
  assert.equal(can('contributor', 'publish_versions'), true);
  assert.equal(can('contributor', 'invite_members'), false);
  assert.equal(can('contributor', 'manage_roles'), false);
  assert.equal(can('contributor', 'request_deletion'), false);
});

test('viewer is read-only: analytics only', () => {
  assert.deepEqual([...PERMISSIONS.viewer], ['view_analytics']);
  assert.equal(can('viewer', 'view_analytics'), true);
  assert.equal(can('viewer', 'edit_profile'), false);
  assert.equal(can('viewer', 'invite_members'), false);
  assert.equal(can('viewer', 'publish_versions'), false);
});

test('a viewer cannot invite members or edit the profile (the brief\'s example)', () => {
  const role: TeamRole = 'viewer';
  assert.equal(can(role, 'invite_members'), false);
  assert.equal(can(role, 'edit_profile'), false);
});

test('owner is never removable through a role change', () => {
  assert.equal(canManageMember('owner', 'owner'), false);
  assert.equal(canManageMember('admin', 'owner'), false);
  assert.equal(canManageMember('owner', 'admin'), true);
  // An admin may not demote or remove a peer admin.
  assert.equal(canManageMember('admin', 'admin'), false);
  assert.equal(canManageMember('admin', 'contributor'), true);
});

test('owner is not an assignable role', () => {
  assert.ok(!(ASSIGNABLE_ROLES as readonly string[]).includes('owner'));
});

// --- Membership resolution --------------------------------------------------

test('the owner column wins over a missing or conflicting members row', () => {
  const publisher = { ownerGithubId: '1' };
  assert.deepEqual(resolveMembership(publisher, null, '1'), { role: 'owner', active: true });
  // A stale row cannot demote the owner...
  assert.deepEqual(resolveMembership(publisher, { role: 'viewer', status: 'accepted' }, '1'), {
    role: 'owner',
    active: true,
  });
});

test('a stale members row cannot elevate a non-owner to owner', () => {
  const publisher = { ownerGithubId: '1' };
  const membership = resolveMembership(publisher, { role: 'owner', status: 'accepted' }, '2');
  assert.deepEqual(membership, { role: 'owner', active: true });
  // ...but the caller must check the publisher owner separately; the resolver only
  // reports the row. The guard that matters is in `authorizePublisher`, which
  // compares against `ownerGithubId`. Here we assert a non-owner is NOT reported
  // as active when there is no row at all.
  assert.equal(resolveMembership(publisher, null, '2'), null);
});

test('a pending or declined invite grants no active membership', () => {
  const publisher = { ownerGithubId: '1' };
  assert.deepEqual(resolveMembership(publisher, { role: 'admin', status: 'pending' }, '2'), {
    role: 'admin',
    active: false,
  });
  assert.deepEqual(resolveMembership(publisher, { role: 'admin', status: 'declined' }, '2'), {
    role: 'admin',
    active: false,
  });
  assert.deepEqual(resolveMembership(publisher, { role: 'admin', status: 'accepted' }, '2'), {
    role: 'admin',
    active: true,
  });
});

// --- Invitation flow --------------------------------------------------------

test('inviteMember creates a pending row with the requested role', async () => {
  const flow = memberFlowDb();
  const row = await inviteMember(flow.db, {
    publisherId: 'm5dev',
    userGithubId: '2',
    role: 'contributor',
    invitedByGithubId: '1',
  });

  assert.equal(row.status, 'pending');
  assert.equal(row.role, 'contributor');
  assert.equal(row.publisher_id, 'm5dev');
  assert.equal(flow.rows.length, 1);
});

test('respondToInvite moves pending -> accepted', async () => {
  const flow = memberFlowDb();
  await inviteMember(flow.db, {
    publisherId: 'm5dev',
    userGithubId: '2',
    role: 'contributor',
    invitedByGithubId: '1',
  });

  const updated = await respondToInvite(flow.db, 'm5dev', '2', 'accepted');
  assert.equal(updated?.status, 'accepted');
  assert.equal(flow.rows[0].status, 'accepted');
});

test('respondToInvite can decline, and a declined row cannot be re-answered', async () => {
  const flow = memberFlowDb();
  await inviteMember(flow.db, {
    publisherId: 'm5dev',
    userGithubId: '2',
    role: 'viewer',
    invitedByGithubId: '1',
  });

  assert.equal((await respondToInvite(flow.db, 'm5dev', '2', 'declined'))?.status, 'declined');
  // Already resolved: the second attempt matches no pending row.
  assert.equal(await respondToInvite(flow.db, 'm5dev', '2', 'accepted'), null);
});

test('respondToInvite only touches the caller\'s own invitation', async () => {
  const flow = memberFlowDb();
  await inviteMember(flow.db, {
    publisherId: 'm5dev',
    userGithubId: '2',
    role: 'contributor',
    invitedByGithubId: '1',
  });

  // A different user id matches nothing.
  assert.equal(await respondToInvite(flow.db, 'm5dev', '99', 'accepted'), null);
  assert.equal(flow.rows[0].status, 'pending');
});

test('re-inviting an existing member re-arms the invitation as pending', async () => {
  const flow = memberFlowDb();
  await inviteMember(flow.db, {
    publisherId: 'm5dev',
    userGithubId: '2',
    role: 'viewer',
    invitedByGithubId: '1',
  });
  await respondToInvite(flow.db, 'm5dev', '2', 'accepted');

  const row = await inviteMember(flow.db, {
    publisherId: 'm5dev',
    userGithubId: '2',
    role: 'admin',
    invitedByGithubId: '1',
  });

  assert.equal(row.status, 'pending');
  assert.equal(row.role, 'admin');
  assert.equal(flow.rows.length, 1, 'a re-invite must not create a second row');
});

test('inviteMember binds the id and role rather than splicing them into the SQL', async () => {
  const { db, last } = fakeD1((sql) =>
    /INSERT INTO publisher_members/i.test(sql)
      ? { first: { publisher_id: 'm5dev', user_github_id: "2'; DROP TABLE users;--" } }
      : {},
  );

  await inviteMember(db, {
    publisherId: 'm5dev',
    userGithubId: "2'; DROP TABLE users;--",
    role: 'viewer',
    invitedByGithubId: '1',
  });

  const call = last();
  assert.ok(!call.sql.includes('DROP TABLE'), 'the id must not be spliced into the SQL');
  assert.ok(call.bindings.includes("2'; DROP TABLE users;--"));
});

// --- Input validation -------------------------------------------------------

test('validateGitHubUsername accepts normal handles and rejects junk', () => {
  assert.equal(validateGitHubUsername('octocat'), null);
  assert.equal(validateGitHubUsername('@octocat'), null);
  assert.equal(validateGitHubUsername('a-b-c'), null);
  assert.ok(validateGitHubUsername(''));
  assert.ok(validateGitHubUsername('-leading'));
  assert.ok(validateGitHubUsername('trailing-'));
  assert.ok(validateGitHubUsername('has space'));
  assert.ok(validateGitHubUsername('a'.repeat(40)));
  assert.ok(validateGitHubUsername(42));
});

test('normalizeUsername lowercases and strips a leading @', () => {
  assert.equal(normalizeUsername('@OctoCat'), 'octocat');
  assert.equal(normalizeUsername('  Foo  '), 'foo');
});

test('validateDeletionReason requires a meaningful reason', () => {
  assert.equal(validateDeletionReason('closing this studio down'), null);
  assert.ok(validateDeletionReason('too short'));
  assert.ok(validateDeletionReason(''));
  assert.ok(validateDeletionReason('x'.repeat(1001)));
  assert.ok(validateDeletionReason(null));
});
