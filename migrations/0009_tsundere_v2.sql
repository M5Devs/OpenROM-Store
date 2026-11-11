-- Migration 0009 — upgrade the anime-tsundere theme to the `.orskin` v2 spec (2.0.0).
--
-- A theme is an ordinary `plugins` row with `category = 'Themes'` (see migration
-- 0006). This is a *data* migration that re-points the listing at the rebuilt
-- v2.0.0 bundle and records the new digest. There is no schema change: the v2
-- manifest's font/icon/dropzone flags and the `ui` block live inside the
-- `.orskin` archive itself, so the marketplace only needs version, download URL
-- and checksum to advertise the new release.
--
-- The v1.0.0 archive is left untouched on SourceForge so existing installs keep
-- resolving; only the listing is moved forward to 2.0.0.
--
--   v2.0.0 bundle: https://downloads.sourceforge.net/project/openrom-skins/m5dev/anime-tsundere/2.0.0/anime-tsundere-2.0.0.orskin
--
-- The gallery screenshot is hosted next to the bundle on SourceForge rather than
-- committed to this repository, so the storefront carries no image binaries:
--   v2.0.0 preview: .../anime-tsundere/2.0.0/preview.png
-- (the same PNG that ships inside the `.orskin`). `public/images/previews/` is
-- gitignored — add a preview to FRS, not to git.
--
-- The `sha256` below is the digest of that exact archive. It is reproducible:
-- `scripts/package_orskin.py` writes a deterministic ZIP (sorted entries, fixed
-- 1980 ZIP epoch timestamp, fixed 0644 member mode), so rebuilding from the same
-- staged assets yields the same hash. The staged assets are the v1.0.0
-- wallpaper/preview plus the v2 deluxe additions (Silkscreen `font.ttf`,
-- illustrated `dropzone.png`, and seven 24x24 tinted navigation icons).
--
-- The bundled `preview.png` was re-captured with OpenROM 4.1.0 — the first
-- release whose engine actually loads the v2 assets — so the storefront
-- screenshot shows the live Silkscreen type, the tinted sidebar icons, and the
-- dropzone illustration instead of the earlier mock-up. Re-packing the same
-- staged files reproduces the digest below byte for byte.
--
-- Re-running is safe and never resets a live download counter: the upsert updates
-- every column *except* `downloads`, so the real count survives re-application.
--
-- `publisher_id` is what the storefront joins on (see PLUGIN_SOURCE in
-- src/lib/db.ts). The M5 Dev publisher row is created by migration 0005, so the
-- INSERT OR IGNORE here is a no-op when that has already run.

INSERT OR IGNORE INTO users (github_id, github_username, name, avatar_url) VALUES
  (
    '193546948',
    'ClausValcaTD',
    'Claus Valca',
    'https://avatars.githubusercontent.com/u/193546948?v=4'
  );

INSERT OR IGNORE INTO publishers (id, name, owner_github_id, verified) VALUES
  ('m5dev', 'M5 Dev', '193546948', 1);

INSERT INTO plugins
  (id, name, version, min_core_version, publisher_id, publisher_name, publisher_verified,
   category, description, readme_markdown, routes_json, platforms_json,
   download_url, sha256, icon, screenshots_json, downloads)
VALUES
  (
    'anime-tsundere',
    'Tsundere Baka Edition 🌸',
    '2.0.0',
    '4.0.0',
    'm5dev',
    'M5 Dev',
    1,
    'Themes',
    'Deluxe anime tsundere skin with a custom pixel font, tinted icons, and an illustrated dropzone.',
    '### Tsundere Baka Edition 🌸 — v2.0.0

> "It-it''s not like I wanted to compress your ROMs or anything, b-baka!"

The deluxe **`.orskin` v2** edition: pastel pink accents, a soft violet canvas, a
custom pixel font, hand-tinted navigation icons, and an illustrated drop target.

#### What''s new in v2.0.0

| Feature | Detail |
| --- | --- |
| Custom font | `font.ttf` — **Silkscreen** (SIL OFL 1.1), a clean 8-bit pixel typeface |
| Custom icons | `icons/*.png` — 24×24 tinted PNGs (home, patcher, tools, dreamcast, plugins, settings, about) |
| Custom dropzone | `dropzone.png` — illustrated drop target in the tsundere palette |
| Rounded corners | `borderRadius` 16 → 18 |
| Wallpaper | `wallpaperOpacity` 0.22 → 0.28, `wallpaperBlur` 3.0 → 2.0 |

#### Palette

| Role | Hex |
| --- | --- |
| Background | `#120e1f` |
| Surface | `#1a142e` |
| Card | `#241c3f` |
| Accent | `#ff4d8d` |
| Accent (secondary) | `#70d6ff` |
| Text | `#ffffff` |
| Text (muted) | `#a599c2` |
| Border | `#3d2f66` |

#### Install

Apply straight from the store with **Apply in OpenROM**, or download the `.orskin`
and import it from *Settings → Appearance → Import…*. Requires OpenROM Core
**4.0.0** or newer for the custom font, icon, and dropzone hooks.

#### Credits

- Wallpaper: *Painted Tsundere* by ryunosuke00, via Wikimedia Commons (public domain).
- Font: **Silkscreen** by Jason Kottke, The Silkscreen Project Authors — SIL Open Font License 1.1.
- Icons & dropzone: original artwork for this skin, M5 Dev.',
    '["#120e1f", "#1a142e", "#ff4d8d", "#70d6ff", "#ffffff"]',
    '["All Platforms"]',
    'https://downloads.sourceforge.net/project/openrom-skins/m5dev/anime-tsundere/2.0.0/anime-tsundere-2.0.0.orskin',
    'b756958cb75a9a914e6f22e49b51327bd82b994bd7b0eac3099ba9a400873ec7',
    'palette',
    '["https://downloads.sourceforge.net/project/openrom-skins/m5dev/anime-tsundere/2.0.0/preview.png"]',
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
  icon               = excluded.icon,
  screenshots_json   = excluded.screenshots_json;
