/**
 * Server-side session helpers shared by pages and API routes.
 *
 * The session cookie is HttpOnly, so only the server can read it — `Navbar` and
 * `/dashboard` resolve the current user through `getSessionUser` rather than any
 * client-side state.
 *
 * Cookies written here are appended to the response by Astro (the Cloudflare
 * adapter copies `cookies.set`/`cookies.delete` onto the handler's response), so
 * endpoints must return a plain `context.redirect(...)` and never re-emit the
 * `Set-Cookie` header themselves — doing so would duplicate it.
 */

import type { AstroCookies } from 'astro';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, verifySessionToken, type SessionPayload } from './session.ts';

/** The subset of the Astro context the session helpers actually need. */
export interface SessionContext {
  cookies: AstroCookies;
  locals: App.Locals;
}

export async function getSessionUser(context: SessionContext): Promise<SessionPayload | null> {
  const token = context.cookies.get(SESSION_COOKIE)?.value;
  return verifySessionToken(token, context.locals.runtime?.env);
}

export function setSessionCookie(
  cookies: AstroCookies,
  token: string,
  secure: boolean,
): void {
  cookies.set(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(cookies: AstroCookies): void {
  cookies.delete(SESSION_COOKIE, { path: '/' });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
