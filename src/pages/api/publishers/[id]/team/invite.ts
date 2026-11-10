import type { APIRoute } from 'astro';
import { getDB } from '../../../../../lib/db';
import { getSessionUser, jsonResponse } from '../../../../../lib/auth';
import { validatePublisherId } from '../../../../../lib/publishers';
import {
  authorizePublisher,
  findUserByUsername,
  inviteMember,
  isAssignableRole,
  validateGitHubUsername,
} from '../../../../../lib/teams';
import { createNotification } from '../../../../../lib/notifications';

export const prerender = false;

/**
 * Invite a GitHub user to a publisher team.
 *
 * Requires the `invite_members` capability (owner or admin). The invitee is looked
 * up by username and stored by numeric id; the role is constrained to the
 * assignable set, so `owner` can never be granted here — ownership moves only via
 * an explicit transfer.
 */
export const POST: APIRoute = async (context) => {
  const id = context.params.id ?? '';
  const idError = validatePublisherId(id);
  if (idError) return jsonResponse({ error: idError }, 400);

  const session = await getSessionUser(context);
  if (!session) return jsonResponse({ error: 'Authentication required.' }, 401);

  let body: { username?: unknown; role?: unknown };
  try {
    body = await context.request.json();
  } catch {
    return jsonResponse({ error: 'Expected a JSON body.' }, 400);
  }

  const usernameError = validateGitHubUsername(body.username);
  if (usernameError) return jsonResponse({ error: usernameError }, 400);
  if (!isAssignableRole(body.role)) {
    return jsonResponse({ error: 'Role must be admin, contributor, or viewer.' }, 400);
  }
  const role = body.role;

  let db: D1Database;
  try {
    db = getDB(context.locals);
  } catch (error) {
    console.error('D1 binding unavailable', error);
    return jsonResponse({ error: 'The publisher directory is temporarily unavailable.' }, 503);
  }

  const access = await authorizePublisher(db, id, session.githubId, 'invite_members');
  if (access.status === 'error') {
    console.error(`Failed to authorize invite for "${id}"`, access.error);
    return jsonResponse({ error: 'The publisher directory is temporarily unavailable.' }, 503);
  }
  if (access.status === 'not-found') {
    return jsonResponse({ error: `Publisher "${id}" was not found.` }, 404);
  }
  if (access.status === 'forbidden') {
    return jsonResponse({ error: 'You do not have permission to invite members.' }, 403);
  }

  const invitee = await findUserByUsername(db, body.username as string);
  if (!invitee) {
    // Only accounts that have signed in can be addressed, because membership is
    // keyed on the immutable numeric id.
    return jsonResponse(
      {
        error:
          'No marketplace account matches that GitHub username. Ask them to sign in once, then invite again.',
      },
      404,
    );
  }

  if (invitee.githubId === session.githubId) {
    return jsonResponse({ error: 'You are already on this team.' }, 409);
  }

  let member;
  try {
    member = await inviteMember(db, {
      publisherId: id,
      userGithubId: invitee.githubId,
      role,
      invitedByGithubId: session.githubId,
    });
  } catch (error) {
    console.error(`Failed to invite "${invitee.githubUsername}" to "${id}"`, error);
    return jsonResponse({ error: 'Could not create the invitation.' }, 500);
  }

  await createNotification(db, {
    userGithubId: invitee.githubId,
    type: 'team_invite',
    title: `You were invited to join ${access.publisher.name}`,
    message: `${session.githubUsername} invited you to join "${access.publisher.name}" as ${role}.`,
    actionUrl: `/dashboard/publisher/${id}`,
    data: { publisher_id: id, role, invited_by: session.githubUsername },
  });

  return jsonResponse({ member }, 201);
};
