import type { APIRoute } from 'astro';
import { getDB } from '../../../../lib/db';
import { getSessionUser, jsonResponse } from '../../../../lib/auth';
import { validatePublisherId } from '../../../../lib/publishers';
import {
  authorizePublisher,
  createDeletionRequest,
  getPendingDeletionRequest,
  validateDeletionReason,
} from '../../../../lib/teams';

export const prerender = false;

/**
 * File a publisher deletion request.
 *
 * Owner-only, and intentionally *not* a delete: removing a publisher is
 * irreversible (its listings and their download URLs disappear), so an owner
 * records a reason here and an operator reviews it. The dashboard surfaces a
 * pending banner from `getPendingDeletionRequest`.
 */
export const POST: APIRoute = async (context) => {
  const id = context.params.id ?? '';
  const idError = validatePublisherId(id);
  if (idError) return jsonResponse({ error: idError }, 400);

  const session = await getSessionUser(context);
  if (!session) return jsonResponse({ error: 'Authentication required.' }, 401);

  let body: { reason?: unknown };
  try {
    body = await context.request.json();
  } catch {
    return jsonResponse({ error: 'Expected a JSON body.' }, 400);
  }

  const reasonError = validateDeletionReason(body.reason);
  if (reasonError) return jsonResponse({ error: reasonError }, 400);

  let db: D1Database;
  try {
    db = getDB(context.locals);
  } catch (error) {
    console.error('D1 binding unavailable', error);
    return jsonResponse({ error: 'The publisher directory is temporarily unavailable.' }, 503);
  }

  const access = await authorizePublisher(db, id, session.githubId, 'request_deletion');
  if (access.status === 'error') {
    console.error(`Failed to authorize deletion request for "${id}"`, access.error);
    return jsonResponse({ error: 'The publisher directory is temporarily unavailable.' }, 503);
  }
  if (access.status === 'not-found') {
    return jsonResponse({ error: `Publisher "${id}" was not found.` }, 404);
  }
  if (access.status === 'forbidden') {
    return jsonResponse({ error: 'Only the publisher owner may request deletion.' }, 403);
  }

  let request;
  try {
    const existing = await getPendingDeletionRequest(db, id);
    if (existing) {
      return jsonResponse({ request: existing }, 200);
    }
    request = await createDeletionRequest(db, id, session.githubId, (body.reason as string).trim());
  } catch (error) {
    console.error(`Failed to record deletion request for "${id}"`, error);
    return jsonResponse({ error: 'Could not record the deletion request.' }, 500);
  }

  return jsonResponse({ request }, 201);
};
