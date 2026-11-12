-- Migration 0013 — register the NKit2ISO plugin and announce the release.
--
-- Two things ship together here, and both are data, not schema:
--
--   1. The `nkit2iso` listing, plus its `plugin_versions` ledger row so the
--      version selector can reach the release.
--   2. Two in-app announcements broadcast to every registered user: the launch
--      of the /publish creator guide, and the new plugin release.
--
-- Why the /publish announcement is seeded from SQL rather than left to a
-- one-off script: the guide is a static route, so there is no runtime moment
-- that "discovers" it. Announcing it here means the message is versioned with
-- the change that introduced it, and re-applying the migration is a no-op.
--
-- ── About the artifact ────────────────────────────────────────────────────
-- The upstream GitHub repository (DonMikone/nkit2iso) has been deleted. The
-- source is permanently preserved on the Go module proxy at v0.1.0, and the
-- binaries in this bundle were built from that exact source with the project's
-- own release settings (`CGO_ENABLED=0`, `-ldflags "-s -w -X main.version=0.1.0"`):
--
--     windows_x64 : GOOS=windows GOARCH=amd64
--     linux_x64   : GOOS=linux   GOARCH=amd64
--     macos_x64   : GOOS=darwin  GOARCH=amd64
--     macos_arm64 : GOOS=darwin  GOARCH=arm64
--
-- The two macOS slices are merged into one universal binary, matching upstream's
-- goreleaser config. The version is 0.1.0 — the only release that ever existed,
-- and the version stamped into the binary by `main.version`.
--
-- The `sha256` below is the digest of the .orplug archive, and it is
-- reproducible: `scripts/package_orplug.py` writes a deterministic ZIP, so
-- rebuilding from the same staged binaries yields the same hash.
--
-- Re-running is safe: the plugin upsert updates every column *except*
-- `downloads` (never resetting a live counter), the ledger row uses
-- INSERT OR IGNORE against UNIQUE(plugin_id, version), and each announcement is
-- guarded so a second apply cannot post a duplicate.

-- The M5 Dev publisher identity, owned by the existing M5Devs account. Both
-- statements are no-ops when the user or publisher already exists.
INSERT OR IGNORE INTO users (github_id, github_username, name, avatar_url) VALUES
  (
    '193546948',
    'ClausValcaTD',
    'Claus Valca',
    'https://avatars.githubusercontent.com/u/193546948?v=4'
  );

INSERT OR IGNORE INTO publishers (id, name, owner_github_id, verified) VALUES
  ('m5dev', 'M5 Dev', '193546948', 1);

-- 1. The plugin listing (the mutable pointer to the current release).
INSERT INTO plugins
  (id, name, version, min_core_version, publisher_id, publisher_name, publisher_verified,
   category, description, readme_markdown, routes_json, platforms_json,
   download_url, sha256, icon, downloads)
VALUES
  (
    'nkit2iso',
    'NKit2ISO',
    '0.1.0',
    '4.0.0',
    'm5dev',
    'M5 Dev',
    1,
    'Nintendo',
    'Fast, dependency-free Go utility to restore GameCube and Wii NKit images (.nkit.iso / .nkit.gcz) to bit-exact Redump-verified ISOs.',
    '### NKit2ISO

A single, dependency-free static binary that restores shrunk NKit images back to
plain, bit-exact `.iso` files that emulators (Dolphin, Nintendont, …) can boot.

- **GameCube and Wii** — both supported and byte-exact, single- and multi-partition
- **NKit v01 restore** — replays the preserved data and regenerates the removed junk padding
- **Wii aware** — rebuilds the H0–H3 hash tree and re-encrypts each cluster with the title key
- **GCZ input** — `.nkit.gcz` is decompressed on the fly, one block at a time
- **Verified** — the result is CRC32-checked against the NKit header, so a clean exit is redump-verified 1:1

#### Usage

```bash
nkit2iso -i "Mario Kart - Double Dash!! (USA).nkit.iso"
nkit2iso -i game.nkit.iso -o game.iso
```

The exit code is `0` only when the reconstructed ISO matches the CRC32 stored in
the NKit header; any mismatch exits non-zero and the partial output is removed.

#### A note on this release

The upstream project (DonMikone/nkit2iso) was authored by **DonMikone** as an
independent, clean-room Go reimplementation of the NKit algorithms created by
**Nanook**. Its repository has since been removed from GitHub, but the source is
preserved on the Go module proxy and this bundle was built from it. Licensed
under the MIT License. This tool converts disc images you already own; it does
not include or distribute any game data.',
    '["NKIT.ISO -> ISO","NKIT.GCZ -> ISO"]',
    '["Windows","Linux","macOS"]',
    'https://downloads.sourceforge.net/project/openrom-plugins/m5dev/nkit2iso/0.1.0/nkit2iso-0.1.0.orplug',
    'dbc08553389e6eeccbe8dcc4870a9a6a5c8b5cfbcb1ba1855a60a23b9b512959',
    'disc',
    0
  )
ON CONFLICT (id) DO UPDATE SET
  name               = excluded.name,
  version            = excluded.version,
  min_core_version   = excluded.min_core_version,
  publisher_id       = excluded.publisher_id,
  publisher_name     = excluded.publisher_name,
  publisher_verified = excluded.publisher_verified,
  category           = excluded.category,
  description        = excluded.description,
  readme_markdown    = excluded.readme_markdown,
  routes_json        = excluded.routes_json,
  platforms_json     = excluded.platforms_json,
  download_url       = excluded.download_url,
  sha256             = excluded.sha256,
  icon               = excluded.icon;

-- 2. The release ledger row, so the version selector can reach 0.1.0.
INSERT OR IGNORE INTO plugin_versions
  (plugin_id, version, min_core_version, download_url, sha256)
VALUES
  (
    'nkit2iso',
    '0.1.0',
    '4.0.0',
    'https://downloads.sourceforge.net/project/openrom-plugins/m5dev/nkit2iso/0.1.0/nkit2iso-0.1.0.orplug',
    'dbc08553389e6eeccbe8dcc4870a9a6a5c8b5cfbcb1ba1855a60a23b9b512959'
  );

-- 3. Announcement — the creator guide is live.
--
-- `user_notifications` has no unique key on (type, title), so a plain INSERT
-- would post a duplicate on every re-apply. The NOT EXISTS guard makes the
-- broadcast idempotent without changing the schema: it fires only when no
-- notification with this exact title already exists for the user.
INSERT INTO user_notifications (user_github_id, type, title, message, action_url)
SELECT github_id,
       'system',
       '🚀 Creator Publishing Guide is Live!',
       'You can now publish your own .orplug extensions and .orskin themes. Check out our new guide and connect with us on Discord!',
       '/publish'
  FROM users
 WHERE NOT EXISTS (
   SELECT 1 FROM user_notifications n
    WHERE n.user_github_id = users.github_id
      AND n.title = '🚀 Creator Publishing Guide is Live!'
 );

-- 4. Announcement — the NKit2ISO release.
INSERT INTO user_notifications (user_github_id, type, title, message, action_url)
SELECT github_id,
       'plugin_approved',
       '📦 New Plugin: NKit2ISO v0.1.0 Released!',
       'A fast, dependency-free Go utility that restores GameCube and Wii NKit images to 1:1 Redump-verified ISOs is now available.',
       '/plugin/nkit2iso'
  FROM users
 WHERE NOT EXISTS (
   SELECT 1 FROM user_notifications n
    WHERE n.user_github_id = users.github_id
      AND n.title = '📦 New Plugin: NKit2ISO v0.1.0 Released!'
 );
