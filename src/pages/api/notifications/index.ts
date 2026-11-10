import type { APIRoute } from 'astro';
import { getDB } from '../../../lib/db';
import { getSessionUser, jsonResponse } from '../../../lib/auth';
import { countUnread, listNotifications } from '../../../lib/notifications';

export const prerender = false;

/**
 * The signed-in user's inbox: notifications newest-first plus the unread count the
 * bell badge shows. Scoped to the session's GitHub id, so one user can never read
 * another's inbox.
 */
export const GET: APIRoute = async (context) => {
  const session = await getSessionUser(context);
  if (!session) return jsonResponse({ error: 'Authentication required.' }, 401);

  try {
    const db = getDB(context.locals);
    const [notifications, unread] = await Promise.all([
      listNotifications(db, session.githubId),
      countUnread(db, session.githubId),
    ]);
    return jsonResponse({ notifications, unread });
  } catch (error) {
    console.error('Failed to load notifications', error);
    return jsonResponse({ error: 'Your inbox is temporarily unavailable.' }, 503);
  }
};
