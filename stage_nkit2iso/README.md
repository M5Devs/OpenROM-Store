# nkit2iso — staging

Build inputs for the `nkit2iso-0.1.0.orplug` bundle published to SourceForge at
`/home/frs/project/openrom-plugins/m5dev/nkit2iso/0.1.0/`.

## Why the binaries are not committed

The upstream repository (`github.com/DonMikone/nkit2iso`) has been deleted from
GitHub, and its release assets (`nkit2iso_0.1.0_*.tar.gz`, `..._windows_amd64.zip`)
now 404. The source is still preserved on the Go module proxy, and the binaries
in this bundle were compiled from it with the project's own release settings.

`bin/` is gitignored: these are build outputs, not source. The manifest and
LICENSE are committed so the bundle contents stay reviewable.

## Reproducing the bundle

```bash
# 1. Fetch the preserved source (the only release that ever existed).
curl -LO https://proxy.golang.org/github.com/!don!mikone/nkit2iso/@v/v0.1.0.zip
unzip v0.1.0.zip && cd 'github.com/DonMikone/nkit2iso@v0.1.0'

# 2. Cross-compile. Matches upstream .goreleaser.yaml: static (CGO off),
#    stripped, and the version stamped into main.version.
export CGO_ENABLED=0
LDF="-s -w -X main.version=0.1.0"
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$LDF" -o nkit2iso.exe .
GOOS=linux   GOARCH=amd64 go build -trimpath -ldflags "$LDF" -o nkit2iso .
GOOS=darwin  GOARCH=amd64 go build -trimpath -ldflags "$LDF" -o nkit2iso-darwin-amd64 .
GOOS=darwin  GOARCH=arm64 go build -trimpath -ldflags "$LDF" -o nkit2iso-darwin-arm64 .
```

The two macOS slices are merged into one universal binary (upstream's goreleaser
config does the same via `universal_binaries`). No `lipo` is available in the
build sandbox, so the fat Mach-O is written directly — see the fat-header layout
in `<mach-o/fat.h>`: big-endian magic `0xcafebabe`, one 20-byte `fat_arch` per
slice, x86_64 at a 4 KiB boundary and arm64 at 16 KiB.

Stage the result as:

```
LICENSE
bin/windows/x64/nkit2iso.exe
bin/linux/x64/nkit2iso
bin/macos/nkit2iso          # universal
plugin.json
```

then `python3 ../scripts/package_orplug.py . nkit2iso-0.1.0.orplug`. The packer
is deterministic, so this yields the digest recorded in migration `0013`:

```
dbc08553389e6eeccbe8dcc4870a9a6a5c8b5cfbcb1ba1855a60a23b9b512959
```
