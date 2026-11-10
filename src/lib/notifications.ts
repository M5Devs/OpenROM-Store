/**
 * The in-app inbox: notification rows, the unread counter, and the helper that
 * creates them.
 *
 * A notification is addressed to one numeric GitHub id. The `data_json` column
 * carries the machine-readable context an action needs — for a `team_invite` that
 * is `{ publisher_id, role }` — so the Accept/Decline buttons in the dropdown know
 * which invitation they are answering without a second lookup.
 *
 * `title` and `message` are rendered as text, never as HTML, so nothing here needs
 * escaping at the storage layer.
 */

export const NOTIFICATION_TYPES = [
  'team_invite',
  'admin_alert',
  'plugin_approved',
  'system',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface NotificationRow {
  id: number;
  user_github_id: string;
  type: string;
  title: string;
  message: string;
  action_url: string | null;
  data_json: string | null;
  is_read: number;
  created_at: string;
}

export interface AppNotification {
  id: number;
  type: NotificationType;
  title: string;
  message: string;
  actionUrl: string | null;
  data: Record<string, unknown> | null;
  isRead: boolean;
  createdAt: string;
}

/** How many notifications the dropdown fetches. Enough to be useful, bounded so
 *  the payload stays small; older ones remain in the table. */
export const INBOX_PAGE_SIZE = 50;

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

/**
 * Parse `data_json` defensively: a malformed or non-object value becomes `null`
 * rather than throwing, so one bad row cannot break the whole inbox.
 */
export function parseNotificationData(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function toNotification(row: NotificationRow): AppNotification {
  return {
    id: row.id,
    type: isNotificationType(row.type) ? row.type : 'system',
    title: row.title,
    message: row.message,
    actionUrl: row.action_url,
    data: parseNotificationData(row.data_json),
    isRead: Boolean(row.is_read),
    createdAt: row.created_at,
  };
}

export interface CreateNotificationInput {
  userGithubId: string;
  type: NotificationType;
  title: string;
  message: string;
  actionUrl?: string | null;
  data?: Record<string, unknown> | null;
}

/**
 * Insert a notification. This never throws into a caller's happy path — a failed
 * inbox write must not fail the action that caused it (an invitation is still valid
 * even if its notification could not be stored), so errors are logged and swallowed.
 */
export async function createNotification(
  db: D1Database,
  input: CreateNotificationInput,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO user_notifications
           (user_github_id, type, title, message, action_url, data_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(
        input.userGithubId,
        input.type,
        input.title,
        input.message,
        input.actionUrl ?? null,
        input.data ? JSON.stringify(input.data) : null,
      )
      .run();
  } catch (error) {
    console.error('Failed to create notification', error);
  }
}

/** Newest first, bounded. */
export async function listNotifications(
  db: D1Database,
  githubId: string,
  limit = INBOX_PAGE_SIZE,
): Promise<AppNotification[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM user_notifications
        WHERE user_github_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .bind(githubId, limit)
    .all<NotificationRow>();
  return (results ?? []).map(toNotification);
}

export async function countUnread(db: D1Database, githubId: string): Promise<number> {
  const row = await db
    .prepare(
      'SELECT COUNT(*) AS unread FROM user_notifications WHERE user_github_id = ? AND is_read = 0',
    )
    .bind(githubId)
    .first<{ unread: number }>();
  return row?.unread ?? 0;
}

/** Mark every unread notification for one user as read. Returns rows changed. */
export async function markAllRead(db: D1Database, githubId: string): Promise<number> {
  const result = await db
    .prepare('UPDATE user_notifications SET is_read = 1 WHERE user_github_id = ? AND is_read = 0')
    .bind(githubId)
    .run();
  return result.meta?.changes ?? 0;
}

/**
 * Mark the notification(s) tied to one invitation as read. Called when a user
 * answers an invitation, so the bell stops flagging it. Matched on the
 * `publisher_id` inside `data_json` rather than the row id, because the inbox may
 * hold more than one notification for the same invitation (a re-invite).
 */
export async function markInviteNotificationsRead(
  db: D1Database,
  githubId: string,
  publisherId: string,
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE user_notifications
            SET is_read = 1
          WHERE user_github_id = ?1
            AND type = 'team_invite'
            AND is_read = 0
            AND json_extract(data_json, '$.publisher_id') = ?2`,
      )
      .bind(githubId, publisherId)
      .run();
  } catch (error) {
    console.error('Failed to mark invite notifications read', error);
  }
}
