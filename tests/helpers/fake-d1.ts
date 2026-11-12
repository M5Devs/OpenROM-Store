/**
 * Minimal D1 stand-in for the unit tests.
 *
 * D1 is an external boundary, so it is faked here; the code under test is the real
 * `src/lib` code. Every statement records its SQL and bound values, so a test can
 * assert on how a query is built — most importantly that user input is *bound*,
 * never spliced into the statement text.
 */

export interface DbCall {
  sql: string;
  bindings: unknown[];
}

export interface DbResult {
  results?: unknown[];
  first?: unknown;
  changes?: number;
}

/** Decides what a statement returns, given its SQL and bindings. */
export type DbResolver = (sql: string, bindings: unknown[]) => DbResult;

export interface FakeDb {
  db: D1Database;
  calls: DbCall[];
  /** The most recent statement, for terse assertions. */
  last(): DbCall;
}

export function fakeD1(resolve: DbResolver = () => ({}), calls: DbCall[] = []): FakeDb {
  function statement(sql: string, bindings: unknown[]) {
    /** Record and resolve without choosing a result shape, for `batch`. */
    const exec = async () => {
      calls.push({ sql, bindings });
      return { meta: { changes: resolve(sql, bindings).changes ?? 0 } };
    };
    return {
      bind: (...values: unknown[]) => statement(sql, values),
      all: async () => {
        calls.push({ sql, bindings });
        return { results: resolve(sql, bindings).results ?? [] };
      },
      first: async () => {
        calls.push({ sql, bindings });
        return resolve(sql, bindings).first ?? null;
      },
      run: exec,
      // `db.batch` receives the statement objects and runs each one; the fake
      // keeps the same contract so batched writes are observable like any other.
      _exec: exec,
    };
  }
  const db = {
    prepare: (sql: string) => statement(sql, []),
    batch: async (statements: { _exec: () => Promise<unknown> }[]) =>
      Promise.all(statements.map((entry) => entry._exec())),
  } as unknown as D1Database;
  return {
    db,
    calls,
    last: () => calls[calls.length - 1],
  };
}

/**
 * A stateful double for the invitation flow.
 *
 * `inviteMember` and `respondToInvite` are the two statements whose *semantics*
 * matter (the pending guard, the user-scoped predicate), so this emulates exactly
 * those two rather than returning canned rows. Any other statement throws, so a
 * new query cannot silently slip past the fake.
 */
export interface MemberState {
  publisher_id: string;
  user_github_id: string;
  role: string;
  status: string;
  invited_by_github_id: string;
  created_at: string;
  updated_at: string;
}

export function memberFlowDb(initial: MemberState[] = []): FakeDb & { rows: MemberState[] } {
  const rows = [...initial];

  const db = fakeD1((sql, bindings) => {
    if (/INSERT INTO publisher_members/i.test(sql)) {
      const [publisherId, userGithubId, role, invitedBy] = bindings as string[];
      const existing = rows.find(
        (row) => row.publisher_id === publisherId && row.user_github_id === userGithubId,
      );
      if (existing) {
        existing.role = role;
        existing.status = 'pending';
        existing.invited_by_github_id = invitedBy;
        return { first: { ...existing } };
      }
      const created: MemberState = {
        publisher_id: publisherId,
        user_github_id: userGithubId,
        role,
        status: 'pending',
        invited_by_github_id: invitedBy,
        created_at: '2026-01-01 00:00:00',
        updated_at: '2026-01-01 00:00:00',
      };
      rows.push(created);
      return { first: { ...created } };
    }

    if (/UPDATE publisher_members/i.test(sql)) {
      const [status, publisherId, userGithubId] = bindings as string[];
      // The real statement only transitions a `pending` row.
      const row = rows.find(
        (entry) =>
          entry.publisher_id === publisherId &&
          entry.user_github_id === userGithubId &&
          entry.status === 'pending',
      );
      if (!row) return { first: null };
      row.status = status;
      return { first: { ...row } };
    }

    throw new Error(`memberFlowDb does not implement: ${sql}`);
  }) as FakeDb & { rows: MemberState[] };

  return Object.assign(db, { rows });
}
