# NKit

NKit is a lossless Nintendo GameCube, Wii, and Wii U disc image toolkit. It
converts, restores, verifies, and compresses disc images while keeping the
original data byte-identical, so a converted image can always be expanded back
to a bit-for-bit copy of the source disc.

This is the **community-packaged** OpenROM plugin build of NKit. It bundles
Nanook's official standalone CLI executables, unmodified.

- **Upstream:** https://github.com/Nanook/NKit
- **Original author:** Nanook
- **Version:** 3.2.1
- **License:** MIT (see `LICENSE`)

## What it does

NKit handles the GameCube/Wii/Wii U disc formats used by preservation and
emulation workflows:

- **Restoration** — rebuild a full, byte-identical disc image from an NKit image.
- **NKit conversion** — shrink a disc to `.nkit.iso` losslessly, including
  relocated DOLs and custom disc layouts.
- **WUA** — Wii U archive output, with image and index formats configurable
  independently (`image=wux` with `index=app`, `wua`, or `loadiine`).
- **ZArchive** — parallel per-block ZStd compression for WUA output.
- **Verification** — check images against checksums, DAT files, and NKit scans.

### Supported routes

| From | To |
| --- | --- |
| ISO | WUA |
| WUD | Loadiine |
| WUX | WUA |
| RVZ | ISO |
| GCZ | ISO |

## Platforms

| Platform | Executable |
| --- | --- |
| Windows x64 | `bin/windows/x86_64/nkit.exe` |
| Linux x64 | `bin/linux/x86_64/nkit` |
| macOS arm64 (Apple Silicon) | `bin/macos/arm64/nkit` |
| macOS x64 (Intel) | `bin/macos/x86_64/nkit` |

## Usage

```bash
nkit convert --input game.iso --output game.wua
```

`--output` names a **directory**; NKit derives the output filename from the
input. Run `nkit --help` for the full task list, which also covers `expand`,
`extract`, `fix`, `fixextract`, `scan`, `verify`, `dedupe`, and `ogmr`.

## What changed in 3.2.1

- **Added** — NKDS fast compact (index-only), sequential shard compaction with
  progress tracking, large-block-index compaction fix, UI pending-CRC display.
- **Fixed** — 7z archive read corruption, GameCube/Wii NKDS verify zero-fill
  gaps, multi-part dat name parsing, and Linux/macOS config in system mode.
- **Changed** — Wii U default conversion format is now `wux/wua`; dependencies
  updated (Avalonia 12.1.5, GrindCore 0.10.0).

## Notes on this build

- The bundled executables are the upstream CLI release binaries, taken as-is from
  the `v3.2.1` release assets. Their SHA-256 digests are recorded in
  `plugin.json` and verified on install.
- The upstream CLI is a self-contained .NET application. On Linux it needs
  `libicu` present (or `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1`); Windows and
  macOS need no extra runtime.
- Only the `nkit` CLI is bundled. The upstream archive also ships a `nkds`
  DataStore CLI and a per-platform `nkit.yaml`/`defaults/` seed; neither is
  included. NKit runs in *system* mode without a local config and creates its own
  configuration on first run, which is why it is not duplicated per platform.
- Upstream 3.2.1 fixed Linux/macOS config handling in system mode, so the
  no-local-config path is the supported one for this bundle.

## Credits

NKit was created by **Nanook** and is maintained upstream at
<https://github.com/Nanook/NKit>. This plugin is an OpenROM community
repackage; it does not modify the binaries. All credit for NKit belongs to its
original author.
