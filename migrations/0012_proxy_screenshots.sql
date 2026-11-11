-- Migration 0012 — serve theme previews through the edge image proxy.
--
-- SourceForge FRS hands every asset back as `application/octet-stream` with
-- `Content-Disposition: attachment`, so pointing an `<img src>` straight at the
-- FRS URL makes the browser download the file instead of showing it. Migration
-- 0009 stored exactly that URL, which is why the gallery never painted.
--
-- `/api/img` (src/pages/api/img.ts) is the fix: it fetches the same asset at the
-- edge, strips the attachment header, labels it with the MIME type its own bytes
-- prove, and caches it for 30 days. The listing now points at the proxy, and
-- `path` is relative to the FRS project root, so no host or scheme is ever taken
-- from the database.
--
-- This only rewrites the one row whose preview is known to be an image served by
-- FRS; a listing whose `screenshots_json` is still empty is left alone. Re-running
-- is safe — the UPDATE is idempotent, and a row already pointing at `/api/img` is
-- rewritten to the same value.

UPDATE plugins
   SET screenshots_json = '["/api/img?path=m5dev/anime-tsundere/2.0.0/preview.png"]'
 WHERE id = 'anime-tsundere';
