import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  countUnread,
  createNotification,
  markAllRead,
  markInviteNotificationsRead,
  parseNotificationData,
  toNotification,
  type NotificationRow,
} from '../src/lib/notifications.ts';
import { fakeD1 } from './helpers/fake-d1.ts';

function row(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: 1,
    user_github_id: '1',
    type: 'system',
    title: 'Hello',
    message: 'World',
    action_url: null,
    data_json: null,
    is_read: 0,
    created_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

// --- Mapping ----------------------------------------------------------------

test('toNotification normalizes a row and defaults an unknown type to system', () => {
  const notification = toNotification(row({ type: 'team_invite', is_read: 1 }));
  assert.equal(notification.type, 'team_invite');
  assert.equal(notification.isRead, true);
  assert.equal(toNotification(row({ type: 'not_a_real_type' })).type, 'system');
});

test('parseNotificationData tolerates malformed and non-object JSON', () => {
  assert.deepEqual(parseNotificationData('{"publisher_id":"m5dev"}'), { publisher_id: 'm5dev' });
  assert.equal(parseNotificationData(null), null);
  assert.equal(parseNotificationData('not json'), null);
  assert.equal(parseNotificationData('[1,2,3]'), null);
  assert.equal(parseNotificationData('"a string"'), null);
});

test('toNotification exposes invite context from data_json', () => {
  const notification = toNotification(
    row({ type: 'team_invite', data_json: '{"publisher_id":"m5dev","role":"viewer"}' }),
  );
  assert.equal(notification.data?.publisher_id, 'm5dev');
  assert.equal(notification.data?.role, 'viewer');
});

// --- Unread counter ---------------------------------------------------------

test('countUnread returns the count, and zero when the row is absent', async () => {
  const { db } = fakeD1(() => ({ first: { unread: 3 } }));
  assert.equal(await countUnread(db, '1'), 3);

  const empty = fakeD1(() => ({ first: null }));
  assert.equal(await countUnread(empty.db, '1'), 0);
});

test('countUnread scopes the query to one user and the unread flag', async () => {
  const { db, last } = fakeD1(() => ({ first: { unread: 0 } }));
  await countUnread(db, '42');
  assert.match(last().sql, /is_read = 0/);
  assert.deepEqual(last().bindings, ['42']);
});

test('markAllRead reports how many rows changed', async () => {
  const { db, last } = fakeD1(() => ({ changes: 5 }));
  assert.equal(await markAllRead(db, '7'), 5);
  assert.deepEqual(last().bindings, ['7']);
});

// --- Creation ---------------------------------------------------------------

test('createNotification binds the user, type and JSON-encoded data', async () => {
  const { db, last } = fakeD1(() => ({ changes: 1 }));
  await createNotification(db, {
    userGithubId: '2',
    type: 'team_invite',
    title: 'Invited',
    message: 'You were invited.',
    actionUrl: '/dashboard/publisher/m5dev',
    data: { publisher_id: 'm5dev', role: 'contributor' },
  });

  const call = last();
  assert.deepEqual(call.bindings, [
    '2',
    'team_invite',
    'Invited',
    'You were invited.',
    '/dashboard/publisher/m5dev',
    '{"publisher_id":"m5dev","role":"contributor"}',
  ]);
});

test('createNotification never throws into its caller', async () => {
  const db = {
    prepare: () => {
      throw new Error('D1 is down');
    },
  } as unknown as D1Database;

  // The whole point: a failed inbox write must not fail the action that caused it.
  await assert.doesNotReject(() =>
    createNotification(db, { userGithubId: '1', type: 'system', title: 'a', message: 'b' }),
  );
});

// --- Marking an invite read -------------------------------------------------

test('markInviteNotificationsRead matches the publisher inside data_json', async () => {
  const { db, last } = fakeD1(() => ({ changes: 1 }));
  await markInviteNotificationsRead(db, '2', 'm5dev');

  const call = last();
  assert.match(call.sql, /json_extract\(data_json, '\$\.publisher_id'\) = \?2/);
  assert.deepEqual(call.bindings, ['2', 'm5dev']);
});

test('markInviteNotificationsRead swallows a database error', async () => {
  const db = {
    prepare: () => {
      throw new Error('no such function: json_extract');
    },
  } as unknown as D1Database;

  await assert.doesNotReject(() => markInviteNotificationsRead(db, '2', 'm5dev'));
});
