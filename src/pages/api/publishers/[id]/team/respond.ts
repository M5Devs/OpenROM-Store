import type { APIRoute } from 'astro';
import { getDB } from '../../../../../lib/db';
import { getSessionUser, jsonResponse } from '../../../../../lib/auth';
import { getPublisher, validatePublisherId } from '../../../../../lib/publishers';
import { getMember, respondToInvite } from '../../../../../lib/teams';
import { markInviteNotificationsRead } from '../../../../../lib/notifications';

export const prerender = false;

/**
 * Accept or decline your own pending invitation.
 *
 * This is deliberately not gated on a publisher capability: the caller is the
 * *invitee*, and a pending invitation grants nothing until it is accepted. The
 * authorization boundary is that the row must belong to the session's GitHub id —
 * `respondToInvite` enforces that with its `user_github_id` predicate, and only a
 * `pending` row transitions, so a replayed request is a no-op.
 */
export const POST: APIRoute = async (context) => {
  const id = context.params.id ?? '';
  const idError = validatePublisherId(id);
  if (idError) return jsonResponse({ error: idError }, 400);

  const session = await getSessionUser(context);
  if (!session) return jsonResponse({ error: 'Authentication required.' }, 401);

  let body: { action?: unknown };
  try {
    body = await context.request.json();
  } catch {
    return jsonResponse({ error: 'Expected a JSON body.' }, 400);
  }

  const action = body.action;
  if (action !== 'accept' && action !== 'decline') {
    return jsonResponse({ error: 'Action must be "accept" or "decline".' }, 400);
  }
  const status = action === 'accept' ? 'accepted' : 'declined';

  let db: D1Database;
  try {
    db = getDB(context.locals);
  } catch (error) {
    console.error('D1 binding unavailable', error);
    return jsonResponse({ error: 'The publisher directory is temporarily unavailable.' }, 503);
  }

  let publisher;
  let member;
  try {
    publisher = await getPublisher(db, id);
    member = publisher ? await getMember(db, id, session.githubId) : null;
  } catch (error) {
    console.error(`Failed to load invitation for "${id}"`, error);
    return jsonResponse({ error: 'The publisher directory is temporarily unavailable.' }, 503);
  }

  if (!publisher) return jsonResponse({ error: `Publisher "${id}" was not found.` }, 404);
  if (!member) {
    return jsonResponse({ error: 'You have no invitation for this publisher.' }, 404);
  }
  if (member.status !== 'pending') {
    return jsonResponse({ error: `This invitation was already ${member.status}.` }, 409);
  }

  let updated;
  try {
    updated = await respondToInvite(db, id, session.githubId, status);
  } catch (error) {
    console.error(`Failed to ${action} invitation for "${id}"`, error);
    return jsonResponse({ error: 'Could not update the invitation.' }, 500);
  }
  if (!updated) {
    // Lost a race with another request that already resolved it.
    return jsonResponse({ error: 'This invitation is no longer pending.' }, 409);
  }

  // Answering the invitation clears it from the bell.
  await markInviteNotificationsRead(db, session.githubId, id);

  return jsonResponse({ member: updated });
};
