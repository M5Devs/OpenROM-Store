import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('../scripts/package_orskin.py', import.meta.url).pathname;

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Build a throwaway stage dir with a manifest, an icon and a font. */
function makeStage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orskin-stage-'));
  writeFileSync(join(dir, 'skin.json'), JSON.stringify({ id: 'anime-tsundere', version: '2.0.0' }));
  writeFileSync(join(dir, 'font.ttf'), Buffer.from([0x00, 0x01, 0x00, 0x00]));
  mkdirSync(join(dir, 'icons'), { recursive: true });
  writeFileSync(join(dir, 'icons', 'home.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return dir;
}

function pack(stage: string, out: string): void {
  execFileSync('python3', [SCRIPT, stage, out], { stdio: 'pipe' });
}

// --- Packaging ---------------------------------------------------------------

test('produces a byte-identical .orskin archive across runs', () => {
  const stage = makeStage();
  const tmp = mkdtempSync(join(tmpdir(), 'orskin-out-'));
  try {
    const a = join(tmp, 'a.orskin');
    const b = join(tmp, 'b.orskin');
    pack(stage, a);
    pack(stage, b);
    assert.equal(sha256(a), sha256(b), 'same input must yield the same digest');
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('keeps skin.json at the archive root', () => {
  const stage = makeStage();
  const tmp = mkdtempSync(join(tmpdir(), 'orskin-out-'));
  const out = join(tmp, 'x.orskin');
  try {
    pack(stage, out);
    const listing = execFileSync('python3', [
      '-c',
      `import zipfile,sys;print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))`,
      out,
    ])
      .toString()
      .trim()
      .split('\n');
    assert.ok(listing.includes('skin.json'), 'manifest must be at the root');
    assert.ok(listing.includes('icons/home.png'), 'nested icons keep their path');
    assert.ok(listing.includes('font.ttf'), 'the custom font ships at the root');
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('refuses a stage directory without skin.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orskin-bad-'));
  const tmp = mkdtempSync(join(tmpdir(), 'orskin-out-'));
  try {
    assert.throws(() => pack(dir, join(tmp, 'x.orskin')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
});
