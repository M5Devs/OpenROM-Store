-- Migration 0014 — update the NKit plugin to 3.2.1.
--
-- NKit was first registered by migration 0005 at 3.2.0. This bumps the listing
-- to the current upstream release and adds the matching `plugin_versions` ledger
-- row, so the version selector can reach it. Nothing here is a schema change.
--
-- ── About the artifact ────────────────────────────────────────────────────
-- The bundle is Nanook's official v3.2.1 CLI release binaries, repackaged
-- unmodified (MIT, Nanook). Published to SourceForge at:
--
--   https://downloads.sourceforge.net/project/openrom-plugins/m5dev/nkit/3.2.1/nkit-3.2.1.orplug
--
-- The `sha256` below is the digest of that exact archive, and it is
-- reproducible: `scripts/package_orplug.py` writes a deterministic ZIP (sorted
-- entries, fixed 1980 epoch, fixed modes), so rebuilding from the same staged
-- binaries yields the same hash.
--
-- ── What changed since 3.2.0 ──────────────────────────────────────────────
-- Upstream 3.2.1 adds NKDS fast/sequential shard compaction, fixes 7z archive
-- reads and GC/Wii NKDS verify zero-fill gaps, and fixes Linux/macOS config
-- handling in system mode. It also flips the Wii U default output to `wux/wua`.
--
-- ── Why min_core_version moves to 4.0.0 ───────────────────────────────────
-- 0005 declared 3.9.0. That was true of the format, but not of the routes: the
-- NKit and Wii U conversion routes were handled natively by core until v4.0.0,
-- which decoupled them and handed them to community extensions. Before 4.0.0
-- this plugin's routes are already served by the built-in converter, so 4.0.0
-- is the first core release where installing it actually does anything. The
-- sibling nkit2iso listing (0013) declares the same floor.
--
-- Re-running is safe: the upsert updates every column *except* `downloads`
-- (never resetting a live counter), and the ledger row uses INSERT OR IGNORE
-- against UNIQUE(plugin_id, version).

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

-- 1. The plugin listing — the mutable pointer to the current release.
INSERT INTO plugins
  (id, name, version, min_core_version, publisher_id, publisher_name, publisher_verified,
   category, description, readme_markdown, routes_json, platforms_json,
   download_url, sha256, icon, downloads)
VALUES
  (
    'nkit',
    'NKit',
    '3.2.1',
    '4.0.0',
    'm5dev',
    'M5 Dev',
    1,
    'Nintendo',
    'Nintendo GameCube, Wii, and Wii U disc restoration, WUA, and compression suite.',
    '### NKit

Lossless Nintendo GameCube, Wii, and Wii U disc image toolkit. Converted images
expand back to a bit-for-bit copy of the source disc.

- **Restoration** — rebuild a full, byte-identical disc image from an NKit image
- **NKit conversion** — shrink to `.nkit.iso` losslessly, including relocated DOLs
- **WUA** — Wii U archive output, image and index formats configurable independently
- **ZArchive** — parallel per-block ZStd compression for WUA output
- **Verification** — check images against checksums, DAT files, and NKit scans

#### Usage

```bash
nkit convert --input game.iso --output game.wua
```

`--output` names a **directory**; NKit derives the output filename from the
input. Run `nkit --help` for the full task list, which also covers `expand`,
`extract`, `fix`, `scan`, `verify`, `dedupe`, and `ogmr`.

#### What changed in 3.2.1

- **Added** — NKDS fast compact (index-only), sequential shard compaction with
  progress tracking, large-block-index compaction fix, UI pending-CRC display
- **Fixed** — 7z archive read corruption, GC/Wii NKDS verify zero-fill gaps,
  multi-part dat name parsing, Linux/macOS config in system mode
- **Changed** — Wii U default conversion format is now `wux/wua`; dependencies
  updated (Avalonia 12.1.5, GrindCore 0.10.0)

The bundled executables are the upstream CLI release binaries, unmodified. On
Linux NKit needs `libicu` present; Windows and macOS need no extra runtime.

Created by **Nanook** and maintained upstream at
<https://github.com/Nanook/NKit>. This is an OpenROM community repackage.
Licensed under the MIT License.',
    '["ISO -> WUA","WUD -> Loadiine","WUX -> WUA","RVZ -> ISO","GCZ -> ISO"]',
    '["Windows","Linux","macOS"]',
    'https://downloads.sourceforge.net/project/openrom-plugins/m5dev/nkit/3.2.1/nkit-3.2.1.orplug',
    '937da76da72361aec132bb890881eda217cfdcac442fb928a288652020e4006f',
    'gamepad',
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

-- 2. The release ledger row, so the version selector can reach 3.2.1.
INSERT OR IGNORE INTO plugin_versions
  (plugin_id, version, min_core_version, download_url, sha256)
VALUES
  (
    'nkit',
    '3.2.1',
    '4.0.0',
    'https://downloads.sourceforge.net/project/openrom-plugins/m5dev/nkit/3.2.1/nkit-3.2.1.orplug',
    '937da76da72361aec132bb890881eda217cfdcac442fb928a288652020e4006f'
  );
