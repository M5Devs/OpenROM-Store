import { marked } from 'marked';

/**
 * Render publisher-supplied README markdown to HTML.
 *
 * READMEs arrive from the database, so the output is sanitized before it reaches
 * `set:html`: script/style/iframe/object/embed elements are dropped, inline event
 * handlers are stripped, and `javascript:` URLs are neutralized.
 */
export function renderMarkdown(markdown: string): string {
  if (!markdown.trim()) return '';
  const html = marked.parse(reflowCollapsed(markdown), { async: false }) as string;
  return sanitize(html);
}

/**
 * Restore line breaks to a README whose newlines were collapsed to spaces in
 * storage.
 *
 * `marked` needs newlines to see block structure. A flattened README still
 * carries the *tokens* of that structure (`### `, `- `, fences) but nothing to
 * break on, so the whole document parses as one heading and the page shows a
 * single run-on paragraph. When that shape is detected the markers are promoted
 * back to their own lines. Text that already has newlines, or that has no block
 * markers at all, is returned untouched — this only ever repairs a document
 * that is otherwise unreadable.
 */
function reflowCollapsed(markdown: string): string {
  if (markdown.includes('\n')) return markdown;
  if (!/(^|\s)(#{1,6}\s|```)/.test(markdown)) return markdown;
  return markdown
    .replace(/[ \t]*```/g, '\n```')
    .replace(/[ \t]+(#{1,6} )/g, '\n\n$1')
    .replace(/[ \t]+([-*+] )/g, '\n$1')
    .replace(/ {2,}/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitize(html: string): string {
  return html
    .replace(/<\s*(script|style|iframe|object|embed|form|link|meta)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|form|link|meta)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'\s>]*\2/gi, '$1="#"');
}
