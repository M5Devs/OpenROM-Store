#!/usr/bin/env python3
"""Package a staged theme directory into a deterministic `.orskin` archive.

An `.orskin` is a ZIP whose entries sit at the archive root, so `skin.json` is
the first thing a reader sees and the manifest's relative paths (`font.ttf`,
`icons/home.png`, `dropzone.png`) resolve against the archive root.

The archive is built deterministically — entries are sorted and every member
gets a fixed timestamp — so re-packaging the same staged files yields the same
SHA-256. That is what makes the checksum recorded in D1 independently
reproducible by anyone who rebuilds from the same inputs.

Usage:
    python3 scripts/package_orskin.py <stage_dir> <output.orskin>
"""

from __future__ import annotations

import hashlib
import os
import sys
import zipfile

# Fixed timestamp for every entry (1980-01-01, the ZIP epoch) so the output does
# not depend on when the files were created.
ZIP_DATE = (1980, 1, 1, 0, 0, 0)


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def build(stage_dir: str, out_path: str) -> str:
    if not os.path.isdir(stage_dir):
        sys.exit(f"stage directory not found: {stage_dir}")

    entries: list[tuple[str, str]] = []
    for root, _dirs, files in os.walk(stage_dir):
        for name in files:
            full = os.path.join(root, name)
            rel = os.path.relpath(full, stage_dir).replace(os.sep, "/")
            entries.append((rel, full))
    entries.sort(key=lambda e: e[0])

    if not any(rel == "skin.json" for rel, _ in entries):
        sys.exit("stage directory has no skin.json at its root")

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel, full in entries:
            info = zipfile.ZipInfo(rel, date_time=ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            # Keep a stable, readable mode for every member; the skin ships no
            # executables, so the archive does not depend on the stage dir's umask.
            info.external_attr = 0o644 << 16
            with open(full, "rb") as src, zf.open(info, "w") as dst:
                for chunk in iter(lambda: src.read(1024 * 1024), b""):
                    dst.write(chunk)

    return sha256_file(out_path)


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    stage_dir, out_path = sys.argv[1], sys.argv[2]
    digest = build(stage_dir, out_path)
    size = os.path.getsize(out_path)
    print(f"packaged : {out_path}")
    print(f"size     : {size} bytes")
    print(f"sha256   : {digest}")


if __name__ == "__main__":
    main()
