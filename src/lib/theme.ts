/**
 * Themes are OpenROM UI skins. They are ordinary `plugins` rows whose
 * `category` is `Themes`; the `.orskin` payload is a JSON palette, so the
 * columns that normally describe conversion tooling are reused:
 *
 *   routes_json    -> the theme's colour palette, an array of hex strings
 *   platforms_json -> ["All Platforms"]
 *
 * Palette values arrive from D1, so they are untrusted input. Every colour is
 * validated before it reaches a template, otherwise a crafted palette could
 * break out of a `style` attribute.
 */

export const THEME_CATEGORY = 'Themes';

/** Themes are not tied to one OS. */
export const THEME_PLATFORM = 'All Platforms';

/** #rgb, #rgba, #rrggbb and #rrggbbaa. Nothing else may reach a style. */
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value.trim());
}

export function isTheme(category: string | null | undefined): boolean {
  return category === THEME_CATEGORY;
}

export interface ThemePaletteEntry {
  role: string;
  hex: string;
}

function parseHexToRgb(hex: string): [number, number, number] | null {
  if (!isHexColor(hex)) return null;
  let value = hex.trim().slice(1);
  if (value.length === 3 || value.length === 4) {
    value = value
      .slice(0, 3)
      .split('')
      .map((c) => c + c)
      .join('');
  } else {
    value = value.slice(0, 6);
  }
  const num = Number.parseInt(value, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

/**
 * Map a palette onto named roles by position. Invalid entries are dropped, so
 * the result is always safe to render; a palette shorter than the role list
 * repeats its last valid colour rather than producing an empty swatch.
 */
export function themePalette(routes: string[] | null | undefined): ThemePaletteEntry[] {
  const colors = (routes ?? []).filter(isHexColor);
  if (colors.length === 0) return [];
  const at = (index: number) => colors[index] ?? colors[colors.length - 1];
  return [
    { role: 'Background', hex: at(0) },
    { role: 'Surface', hex: at(1) },
    { role: 'Accent', hex: at(2) },
    { role: 'Text', hex: at(colors.length - 1) },
  ];
}

/** The valid colours to show in the card swatch bar, in order. */
export function themeSwatches(routes: string[] | null | undefined, limit = 5): string[] {
  return (routes ?? []).filter(isHexColor).slice(0, limit);
}

/**
 * Readable text colour for a background, by relative luminance. Used so the
 * mockup preview stays legible whatever palette a theme ships.
 */
export function contrastText(hex: string): string {
  const rgb = parseHexToRgb(hex);
  if (!rgb) return '#ffffff';
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.45 ? '#0b0b0f' : '#ffffff';
}

/** The deep link OpenROM uses to apply a theme. */
export function themeApplyUri(id: string): string {
  return `openrom://theme/${id}`;
}

/** The file name a theme downloads as. */
export function orskinFileName(id: string): string {
  return `${id}.orskin`;
}

/**
 * A screenshot URL is only allowed to be a root-relative path or an https URL.
 * That keeps the gallery from being pointed at `javascript:` or a `data:` blob
 * via the database, and stops a stored value from reaching the DOM unchecked.
 * A fragment is stripped and the URL is normalised by `new URL`, so the value
 * handed to `<img src>` is never the raw stored string.
 */
export function sanitizeScreenshotUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw === '') return null;
  // Scheme-relative (`//host/x`) is neither a root-relative path nor an https
  // URL, so it is refused rather than silently resolved against a host.
  if (raw.startsWith('//')) return null;
  try {
    const base = 'https://openrom.invalid';
    const url = new URL(raw, base);
    if (url.origin === base) {
      if (!raw.startsWith('/')) return null; // relative without a leading slash
    } else if (url.protocol !== 'https:') {
      return null; // absolute URLs must be https
    }
    url.hash = '';
    return url.origin === base ? `${url.pathname}${url.search}` : url.href;
  } catch {
    return null;
  }
}

/**
 * The validated screenshot URLs for a listing, in order. Invalid entries are
 * dropped rather than throwing, so a single bad row never breaks the page.
 */
export function themeScreenshots(screenshots: string[] | null | undefined): string[] {
  return (screenshots ?? [])
    .map(sanitizeScreenshotUrl)
    .filter((url): url is string => url !== null);
}

/** True when a listing should render the screenshot showcase. */
export function hasScreenshots(screenshots: string[] | null | undefined): boolean {
  return themeScreenshots(screenshots).length > 0;
}
