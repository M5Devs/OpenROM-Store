/**
 * Version-string and release-date helpers for the multi-version history engine.
 *
 * These are deliberately dependency-free and pure: the storefront renders release
 * tables on the server and the same comparisons are exercised in tests, so there
 * is nothing here that needs a D1 binding or a browser.
 */

/**
 * Compare two dotted version strings the way a human reads them.
 *
 * Returns a negative number when `a` precedes `b`, `0` when they are equivalent,
 * and a positive number when `a` follows `b`. Numeric segments are compared as
 * numbers (`1.10.0` is *newer* than `1.9.0`, which a lexicographic sort gets
 * wrong); non-numeric segments fall back to a locale-independent string compare.
 *
 * A pre-release suffix (`2.0.0-rc.1`) sorts *before* the bare release (`2.0.0`),
 * matching semver's rule that a pre-release is never the latest stable.
 */
export function compareVersions(a: string, b: string): number {
  const [coreA, preA = ''] = splitVersion(a);
  const [coreB, preB = ''] = splitVersion(b);

  const coreLength = Math.max(coreA.length, coreB.length);
  for (let i = 0; i < coreLength; i += 1) {
    const diff = compareSegment(coreA[i] ?? '0', coreB[i] ?? '0');
    if (diff !== 0) return diff;
  }

  // Identical core: a version without a pre-release suffix is the newer one.
  if (preA === preB) return 0;
  if (preA === '') return 1;
  if (preB === '') return -1;
  return comparePreRelease(preA, preB);
}

/**
 * True when `candidate` is a strictly newer release than `current`. Used to tag
 * the newest row in the history table without trusting insertion order.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

/**
 * Render a stored timestamp as a short, stable release date — e.g.
 * `2026-11-08 15:13:37` becomes `Nov 8, 2026`.
 *
 * D1 hands back `CURRENT_TIMESTAMP` values as `YYYY-MM-DD HH:MM:SS` in UTC. That
 * string is parsed explicitly rather than with `new Date(string)`, because the
 * latter treats a bare datetime as *local* time in some engines and would shift
 * the rendered day depending on where the server runs. Anything unrecognised is
 * returned untouched so a hand-edited row still shows something.
 */
export function formatReleaseDate(value: string | null | undefined): string {
  if (!value) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/.exec(value.trim());
  if (!match) return value;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || !month || !day) return value;

  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return value;

  const monthName = MONTHS[date.getUTCMonth()];
  return `${monthName} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

function splitVersion(version: string): [string[], string] {
  const trimmed = version.trim();
  const dash = trimmed.indexOf('-');
  if (dash === -1) return [trimmed.split('.'), ''];
  return [trimmed.slice(0, dash).split('.'), trimmed.slice(dash + 1)];
}

function compareSegment(a: string, b: string): number {
  const numA = Number(a);
  const numB = Number(b);
  const numeric = a !== '' && b !== '' && !Number.isNaN(numA) && !Number.isNaN(numB);
  if (numeric) return numA - numB;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePreRelease(a: string, b: string): number {
  const partsA = a.split('.');
  const partsB = b.split('.');
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i += 1) {
    const left = partsA[i];
    const right = partsB[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const diff = compareSegment(left, right);
    if (diff !== 0) return diff;
  }
  return 0;
}
