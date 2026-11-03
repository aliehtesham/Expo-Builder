'use strict';
// Download-source registry for the Android SDK repository. dl.google.com is
// blocked outright in some countries; a full mirror serves the exact same
// manifest XML (repository2-*.xml) and the package zips it names, so switching
// the base URL is enough — every relative archive URL resolves against the
// base that served the manifest, and each zip is SHA-1-verified against the
// manifest checksums either way.
// Pure Node — used by the Electron main process. The active source is a
// module-level setting; main.ts persists it in userData/download-source.json.
//
// Mirrors listed here are verified against the real repository: the manifest
// AND a large package zip (the NDK) must download with 200 before a provider
// is added — a dead option in the selector is worse than no option.

export interface MirrorProvider {
  /** Stable id persisted in download-source.json / used by the renderer. */
  id: string;
  /** UI label. */
  label: string;
  /** Where the mirror lives ("Global" / "China") — shown next to the label. */
  region: string;
  /** Repository base URL, trailing slash included. */
  base: string;
  /** Host portion of base (labels, log lines). */
  host: string;
  /** One-line hint shown under the source selector. */
  note: string;
}

export const DEFAULT_SOURCE_ID = 'google';
export const CUSTOM_SOURCE_ID = 'custom';

export const MIRRORS: MirrorProvider[] = [
  {
    id: 'google',
    label: 'Google (official)',
    region: 'Global',
    base: 'https://dl.google.com/android/repository/',
    host: 'dl.google.com',
    note: "Google's official repository — the default.",
  },
  {
    id: 'tencent',
    label: 'Tencent Cloud',
    region: 'China',
    base: 'https://mirrors.cloud.tencent.com/AndroidSDK/',
    host: 'mirrors.cloud.tencent.com',
    note: 'Full mirror of the Android SDK repository in China — works without a VPN.',
  },
];

export function mirrorById(id: string): MirrorProvider | null {
  return MIRRORS.find((m) => m.id === id) || null;
}

let activeId = DEFAULT_SOURCE_ID;
/** Base URL of the user's own mirror/proxy — set when the custom source is on. */
let customBase: string | null = null;

/**
 * Validate + normalize a custom base URL: absolute http(s), no query/hash
 * (those would break relative archive resolution), trailing slash ensured.
 * Returns null when the input is unusable.
 */
export function normalizeCustomBase(raw: string): string | null {
  const s = String(raw || '').trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.search || u.hash) return null;
    const clean = u.toString();
    return clean.endsWith('/') ? clean : `${clean}/`;
  } catch {
    return null;
  }
}

/** Switch to the custom source with a validated base; null when invalid. */
export function setCustomBase(raw: string): MirrorProvider | null {
  const base = normalizeCustomBase(raw);
  if (!base) return null;
  customBase = base;
  activeId = CUSTOM_SOURCE_ID;
  return activeMirror();
}

/** The custom base currently configured, if any (persisted by main.ts). */
export function activeCustomBase(): string | null {
  return customBase;
}

/** The source downloads currently go through (never null — falls back to default). */
export function activeMirror(): MirrorProvider {
  if (activeId === CUSTOM_SOURCE_ID && customBase) {
    return {
      id: CUSTOM_SOURCE_ID,
      label: 'Custom source',
      region: 'Custom',
      base: customBase,
      host: new URL(customBase).host,
      note: 'Your own mirror or proxy — any base URL that serves repository2-3.xml.',
    };
  }
  return mirrorById(activeId) || mirrorById(DEFAULT_SOURCE_ID)!;
}

/** Switch the active source; unknown ids fall back to the default. */
export function setActiveMirror(id: string): MirrorProvider {
  activeId = mirrorById(id) ? id : DEFAULT_SOURCE_ID;
  return activeMirror();
}

/**
 * Manifest fetch order: the selected source first (all manifest schemas), then
 * the official Google one (newest schema only) as a last resort, so a stale or
 * down mirror costs at most one extra timeout, not three.
 */
export function mirrorFallbacks(): MirrorProvider[] {
  const primary = activeMirror();
  return primary.id === DEFAULT_SOURCE_ID ? [primary] : [primary, mirrorById(DEFAULT_SOURCE_ID)!];
}
