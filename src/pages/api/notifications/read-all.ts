import type { APIRoute } from 'astro';
import { getDB } from '../../../lib/db';
import { getSessionUser, jsonResponse } from '../../../lib/auth';
import { countUnread, markAllRead } from '../../../lib/notifications';

export const prerender = false;

/**
 * Mark every notification in the signed-in user's inbox as read. Scoped to the
 * session's GitHub id, so it can only ever clear the caller's own badge.
 */
export const POST: APIRoute = async (context) => {
  const session = await getSessionUser(context);
  if (!session) return jsonResponse({ error: 'Authentication required.' }, 401);

  try {
    const db = getDB(context.locals);
    const marked = await markAllRead(db, session.githubId);
    const unread = await countUnread(db, session.githubId);
    return jsonResponse({ marked, unread });
  } catch (error) {
    console.error('Failed to mark notifications read', error);
    return jsonResponse({ error: 'Your inbox is temporarily unavailable.' }, 503);
  }
};
