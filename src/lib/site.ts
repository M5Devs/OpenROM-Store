/** Shared storefront constants and presentation helpers. */

export const SITE = {
  name: 'OpenROM Marketplace',
  tagline: 'Extensions for the OpenROM preservation toolchain',
  description:
    'Community-built extensions for OpenROM — conversion, verification, and patching tools for retro-gaming preservation.',
  github: 'https://github.com/M5Devs/OpenROM-Plugins-Store',
  discord: 'https://discord.gg/FYEjpcFYXc',
  /** In-store creator guide. Replaced the old external CONTRIBUTING.md link. */
  publish: '/publish',
} as const;

/** Shown when the catalog is genuinely empty — never replaced with fake rows. */
export const EMPTY_STATE = {
  title: 'No community extensions published yet',
  body: 'Be the first to build for OpenROM!',
  cta: 'Read the submission guide',
} as const;

export const PLATFORM_ICONS: Record<string, string> = {
  Windows: 'monitor',
  Linux: 'terminal',
  macOS: 'apple',
  Android: 'smartphone',
  'All Platforms': 'layers',
};

/**
 * A leading emoji for the categories that have one. Themes is the only
 * special-cased label today; everything else renders its raw category name.
 */
export const CATEGORY_LABELS: Record<string, string> = {
  Themes: '🎨 Themes',
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

/** Stable display order; unknown categories are appended alphabetically. */
export const CATEGORY_ORDER = [
  'Nintendo',
  'PlayStation',
  'Sega',
  'Xbox',
  'Patchers',
  'Utility',
  'Themes',
];

export function orderCategories(categories: string[]): string[] {
  const unique = [...new Set(categories)];
  return unique.sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a);
    const ib = CATEGORY_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
}

/** Up to two initials for an avatar fallback, e.g. "Claus Valca" -> "CV". */
export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export interface SocialLink {
  key: 'website' | 'github' | 'discord' | 'twitter';
  label: string;
  href: string;
  icon: string;
}

/** The social pills shown on a publisher profile, in a stable order. */
export function socialLinksFor(source: {
  websiteUrl?: string;
  githubUrl?: string;
  discordUrl?: string;
  twitterUrl?: string;
}): SocialLink[] {
  const candidates: Array<SocialLink | null> = [
    source.websiteUrl
      ? { key: 'website', label: 'Website', href: source.websiteUrl, icon: 'globe' }
      : null,
    source.githubUrl
      ? { key: 'github', label: 'GitHub', href: source.githubUrl, icon: 'github' }
      : null,
    source.discordUrl
      ? { key: 'discord', label: 'Discord', href: source.discordUrl, icon: 'message-circle' }
      : null,
    source.twitterUrl
      ? { key: 'twitter', label: 'Twitter / X', href: source.twitterUrl, icon: 'twitter' }
      : null,
  ];
  return candidates.filter((link): link is SocialLink => link !== null);
}
