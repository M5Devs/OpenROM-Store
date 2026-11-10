-- Migration 0011 — publisher teams (RBAC), daily analytics, and the in-app inbox.
--
-- Four tables turn a single-owner storefront into a collaborative one:
--
--   publisher_members          who may act on a publisher, and with what role
--   plugin_analytics           per-day views/downloads, so the dashboard can show
--                              a conversion rate instead of a lifetime total
--   user_notifications         the inbox behind the navbar bell
--   publisher_deletion_requests  a governance record: a publisher is never deleted
--                              outright, an owner files a request for review
--
-- Identity is the numeric `github_id` everywhere, matching `publishers.owner_github_id`
-- and the rest of the schema: a user may rename their GitHub handle, so the id —
-- never the username — is what a membership or notification is keyed on.
--
-- Roles are ordered by capability: owner > admin > contributor > viewer. The
-- permission matrix itself lives in src/lib/teams.ts (PERMISSIONS), not in the
-- database, so it is unit-testable without D1.
--
-- Re-running is safe: every statement is CREATE ... IF NOT EXISTS, the owner
-- backfill is an INSERT OR IGNORE, and the index uses IF NOT EXISTS.

-- 1. Team membership and invitations.
CREATE TABLE IF NOT EXISTS publisher_members (
  publisher_id          TEXT NOT NULL,
  user_github_id        TEXT NOT NULL,
  role                  TEXT CHECK(role IN ('owner', 'admin', 'contributor', 'viewer')) DEFAULT 'contributor',
  status                TEXT CHECK(status IN ('pending', 'accepted', 'declined')) DEFAULT 'pending',
  invited_by_github_id  TEXT NOT NULL,
  created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (publisher_id, user_github_id),
  FOREIGN KEY (publisher_id) REFERENCES publishers(id)
);

-- The inbox and the members list are both read per-user, so index that direction.
CREATE INDEX IF NOT EXISTS idx_publisher_members_user ON publisher_members (user_github_id, status);

-- 2. Daily analytics. One row per plugin per day; the tracking hooks upsert into
--    it, so a busy day is a single UPDATE rather than an ever-growing log.
CREATE TABLE IF NOT EXISTS plugin_analytics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id  TEXT NOT NULL,
  date       DATE DEFAULT (CURRENT_DATE),
  views      INTEGER DEFAULT 0,
  downloads  INTEGER DEFAULT 0,
  UNIQUE(plugin_id, date),
  FOREIGN KEY (plugin_id) REFERENCES plugins(id)
);

-- The dashboard reads a publisher's whole date range at once.
CREATE INDEX IF NOT EXISTS idx_plugin_analytics_date ON plugin_analytics (date);

-- 3. In-app notifications / inbox.
CREATE TABLE IF NOT EXISTS user_notifications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_github_id  TEXT NOT NULL,
  type            TEXT NOT NULL, -- 'team_invite' | 'admin_alert' | 'plugin_approved' | 'system'
  title           TEXT NOT NULL,
  message         TEXT NOT NULL,
  action_url      TEXT,
  data_json       TEXT,          -- e.g. {"publisher_id": "m5dev", "role": "contributor"}
  is_read         BOOLEAN DEFAULT 0,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- The bell polls unread-count + newest-first for one user, which is exactly this index.
CREATE INDEX IF NOT EXISTS idx_user_notifications ON user_notifications(user_github_id, is_read);

-- 4. Publisher deletion governance. Deleting a publisher is destructive and
--    irreversible (its listings and download URLs disappear), so it is a request
--    an owner files and an operator reviews — never a single click.
CREATE TABLE IF NOT EXISTS publisher_deletion_requests (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  publisher_id           TEXT NOT NULL,
  requested_by_github_id TEXT NOT NULL,
  reason                 TEXT NOT NULL,
  status                 TEXT CHECK(status IN ('pending', 'approved', 'rejected')) DEFAULT 'pending',
  created_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (publisher_id) REFERENCES publishers(id)
);

-- 5. Backfill: make the existing owner of every publisher an explicit `owner`
--    member. Membership is otherwise derived (an owner is an owner because the
--    `publishers` row says so), but without this row the team list would show an
--    empty team for every publisher that predates this migration. INSERT OR IGNORE
--    keeps a re-run from clobbering a role that was changed after the fact.
INSERT OR IGNORE INTO publisher_members
  (publisher_id, user_github_id, role, status, invited_by_github_id)
SELECT id, owner_github_id, 'owner', 'accepted', owner_github_id
  FROM publishers;
