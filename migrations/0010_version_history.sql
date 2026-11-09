-- Migration 0010 — multi-version support: an append-only release ledger.
--
-- Until now a plugin row was the whole story: one `version`, one `download_url`,
-- one `sha256`. That is enough to advertise the *latest* release, but it silently
-- erases history — once 0009 moved `anime-tsundere` from 1.0.0 to 2.0.0, the v1
-- bundle became unreachable from the store even though it is still served by
-- SourceForge and still installed by users.
--
-- `plugin_versions` fixes that. The `plugins` row stays the mutable pointer to the
-- current release (so every existing query and component keeps working untouched);
-- `plugin_versions` is the immutable ledger of every published artifact, keyed by
-- (plugin_id, version). It is append-only: new releases are INSERTed, never
-- UPDATE'd, so a digest recorded here can always be trusted.
--
-- The UNIQUE(plugin_id, version) constraint is what makes re-running this file a
-- no-op — the seeds below use INSERT OR IGNORE, so applying the migration twice
-- leaves exactly two rows.
--
-- `min_core_version` mirrors the column on `plugins` and defaults to 3.9.0 so a
-- release that predates the min-core concept still declares something sane.
--
-- The v1.0.0 archive is deliberately still listed: it is what users on older
-- OpenROM Core builds can install, and the storefront's version selector exists
-- precisely so they can reach it.

CREATE TABLE IF NOT EXISTS plugin_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  min_core_version TEXT DEFAULT '3.9.0',
  download_url TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (plugin_id) REFERENCES plugins(id),
  UNIQUE(plugin_id, version)
);

-- Seed the two published releases of the anime-tsundere theme. Each lives in its
-- own SourceForge directory so older installs keep resolving.
--
--   v1.0.0 -> .../anime-tsundere/1.0.0/anime-tsundere-1.0.0.orskin
--   v2.0.0 -> .../anime-tsundere/2.0.0/anime-tsundere-2.0.0.orskin
--
-- Both digests are reproducible: `scripts/package_orskin.py` writes a
-- deterministic ZIP (sorted entries, fixed 1980 epoch, fixed 0644 mode), so
-- rebuilding from the same staged assets yields the same SHA-256.
INSERT OR IGNORE INTO plugin_versions
  (plugin_id, version, min_core_version, download_url, sha256)
VALUES
  (
    'anime-tsundere',
    '1.0.0',
    '3.9.0',
    'https://downloads.sourceforge.net/project/openrom-skins/m5dev/anime-tsundere/1.0.0/anime-tsundere-1.0.0.orskin',
    'c838db55e2696c11c1a3d2fe6e6e24550dd956ce721ece0087868cd0d615f496'
  ),
  (
    'anime-tsundere',
    '2.0.0',
    '4.0.0',
    'https://downloads.sourceforge.net/project/openrom-skins/m5dev/anime-tsundere/2.0.0/anime-tsundere-2.0.0.orskin',
    '45f4830ae52da3890d6e2fa01ef1a213619dab72b8795b4d7954667f8744cac4'
  );
