-- Migration 0015 — repair the NKit README and complete its version history.
--
-- Two data-only fixes for the `nkit` listing.
--
-- 1. README. Production ended up storing it with every newline flattened to a
--    single space, so `marked` parsed the whole document as one giant
--    `### NKit ...` heading and the plugin page rendered a single run-on
--    paragraph under "Overview". The text below is the exact content shipped by
--    migration 0014, but its newlines are rebuilt with char(10) instead of being
--    typed literally. A lossy apply path — a shell or console paste that
--    collapses line breaks — therefore cannot flatten it again, because there
--    are no literal newlines in the statement to lose.
--
-- 2. Version history. 3.2.0 was registered by migration 0005, before the
--    `plugin_versions` ledger existed (0010), so it never got a ledger row and
--    the page reported a single release with no version selector. This backfills
--    it. 3.2.0 predates the current manifest schema (its platform keys are
--    `*_x86_64` and its `args` are strings, both of which the core parser drops),
--    so it is recorded as history rather than recommended for install.
--
-- Re-running is safe: the UPDATE assigns a constant, and the ledger row uses
-- INSERT OR IGNORE against UNIQUE(plugin_id, version).

UPDATE plugins
   SET readme_markdown =
         '### NKit' || char(10) ||
         '' || char(10) ||
         'Lossless Nintendo GameCube, Wii, and Wii U disc image toolkit. Converted images' || char(10) ||
         'expand back to a bit-for-bit copy of the source disc.' || char(10) ||
         '' || char(10) ||
         '- **Restoration** — rebuild a full, byte-identical disc image from an NKit image' || char(10) ||
         '- **NKit conversion** — shrink to `.nkit.iso` losslessly, including relocated DOLs' || char(10) ||
         '- **WUA** — Wii U archive output, image and index formats configurable independently' || char(10) ||
         '- **ZArchive** — parallel per-block ZStd compression for WUA output' || char(10) ||
         '- **Verification** — check images against checksums, DAT files, and NKit scans' || char(10) ||
         '' || char(10) ||
         '#### Usage' || char(10) ||
         '' || char(10) ||
         '```bash' || char(10) ||
         'nkit convert --input game.iso --output game.wua' || char(10) ||
         '```' || char(10) ||
         '' || char(10) ||
         '`--output` names a **directory**; NKit derives the output filename from the' || char(10) ||
         'input. Run `nkit --help` for the full task list, which also covers `expand`,' || char(10) ||
         '`extract`, `fix`, `scan`, `verify`, `dedupe`, and `ogmr`.' || char(10) ||
         '' || char(10) ||
         '#### What changed in 3.2.1' || char(10) ||
         '' || char(10) ||
         '- **Added** — NKDS fast compact (index-only), sequential shard compaction with' || char(10) ||
         '  progress tracking, large-block-index compaction fix, UI pending-CRC display' || char(10) ||
         '- **Fixed** — 7z archive read corruption, GC/Wii NKDS verify zero-fill gaps,' || char(10) ||
         '  multi-part dat name parsing, Linux/macOS config in system mode' || char(10) ||
         '- **Changed** — Wii U default conversion format is now `wux/wua`; dependencies' || char(10) ||
         '  updated (Avalonia 12.1.5, GrindCore 0.10.0)' || char(10) ||
         '' || char(10) ||
         'The bundled executables are the upstream CLI release binaries, unmodified. On' || char(10) ||
         'Linux NKit needs `libicu` present; Windows and macOS need no extra runtime.' || char(10) ||
         '' || char(10) ||
         'Created by **Nanook** and maintained upstream at' || char(10) ||
         '<https://github.com/Nanook/NKit>. This is an OpenROM community repackage.' || char(10) ||
         'Licensed under the MIT License.'
 WHERE id = 'nkit';

-- Backfill the 3.2.0 release so the version selector and history table list the
-- full published sequence. `created_at` is the day the 3.2.0 listing went live.
INSERT OR IGNORE INTO plugin_versions
  (plugin_id, version, min_core_version, download_url, sha256, created_at)
VALUES
  (
    'nkit',
    '3.2.0',
    '3.9.0',
    'https://downloads.sourceforge.net/project/openrom-plugins/m5dev/nkit/3.2.0/nkit-3.2.0.orplug',
    'bd62db8e7ab61075e08424f5fe22ed0bdc2d73f9bf3ba5a11cd7ef7af2e8f717',
    '2026-11-04 13:18:55'
  );
