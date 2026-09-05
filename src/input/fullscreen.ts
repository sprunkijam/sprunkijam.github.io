/**
 * TAP TO JAM used to call requestFullscreen in every browser.
 * Desktop and laptop browsers treat that as an invasive jump, and on Windows
 * Chrome the sudden canvas realloc is the same path as Maximize (tab freeze).
 * Keep the kick only for phones / tablets (iPhone Home Screen / immersion).
 */

export interface HandheldHints {
  /** navigator.userAgentData.mobile when Client Hints exist. */
  uaDataMobile?: boolean | null;
  maxTouchPoints?: number;
  pointerCoarse?: boolean;
  pointerFine?: boolean;
  hoverNone?: boolean;
  hoverHover?: boolean;
  /** min(innerWidth, innerHeight) in CSS pixels. */
  shortSide?: number;
  ua?: string;
  platform?: string;
}

function mediaMatches(query: string): boolean | undefined {
  if (typeof matchMedia !== "function") return undefined;
  try {
    return matchMedia(query).matches;
  } catch {
    return undefined;
  }
}

function liveHandheldHints(): HandheldHints {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const uaData =
    nav && "userAgentData" in nav
      ? (nav as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData
      : undefined;
  const innerW = typeof window !== "undefined" ? window.innerWidth : 0;
  const innerH = typeof window !== "undefined" ? window.innerHeight : 0;
  return {
    uaDataMobile: uaData?.mobile ?? null,
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    pointerCoarse: mediaMatches("(pointer: coarse)"),
    pointerFine: mediaMatches("(pointer: fine)"),
    hoverNone: mediaMatches("(hover: none)"),
    hoverHover: mediaMatches("(hover: hover)"),
    shortSide: Math.min(innerW, innerH),
    ua: nav?.userAgent ?? "",
    platform: nav?.platform ?? "",
  };
}

/**
 * Phones and tablets only. Touchscreen laptops still have a fine primary pointer
 * and hover, so they must not look like a phone.
 */
export function isHandheldDevice(hints: HandheldHints): boolean {
  if (hints.uaDataMobile === true) return true;

  const ua = (hints.ua ?? "").toLowerCase();
  const navPlatform = hints.platform ?? "";
  const maxTouch = hints.maxTouchPoints ?? 0;
  const iPadDesktop = navPlatform === "MacIntel" && maxTouch > 1;
  const isIos = /iphone|ipad|ipod/.test(ua) || iPadDesktop;
  if (isIos) return true;

  // Primary desktop pointing (mouse / trackpad), including touchscreen laptops.
  if (hints.pointerFine === true && hints.hoverHover === true) return false;

  const isAndroid = /android/.test(ua);
  if (hints.uaDataMobile === false && !isAndroid) return false;

  if (isAndroid) return true;

  // Desktop / laptop OS tokens. iPadOS desktop-class already returned above.
  if (/\bwindows nt\b|\bmacintosh\b|\bmac os x\b|\bcros\b|\bx11\b/.test(ua)) return false;

  const shortSide = hints.shortSide ?? 0;
  const coarsePhoneOrTablet =
    (hints.pointerCoarse === true || maxTouch > 0) &&
    hints.hoverNone === true &&
    shortSide > 0 &&
    shortSide <= 1024;
  return coarsePhoneOrTablet;
}

/** True only on phones/tablets — never on desktop or laptop browsers. */
export function shouldKickFullscreen(hints?: HandheldHints): boolean {
  return isHandheldDevice(hints ?? liveHandheldHints());
}

type FullscreenEl = HTMLElement & {
  webkitRequestFullscreen?: () => void | Promise<void>;
  webkitRequestFullScreen?: () => void | Promise<void>;
};

/**
 * Best-effort fullscreen in the same user-gesture turn as TAP TO JAM.
 * No-ops on desktop/laptop. iOS WebKit often rejects Fullscreen API —
 * never block jam start. Add-to-Home-Screen is the reliable iPhone path.
 */
export function kickFullscreen(hints?: HandheldHints): boolean {
  if (!shouldKickFullscreen(hints)) return false;
  try {
    const el = document.documentElement as FullscreenEl;
    const req =
      el.requestFullscreen?.bind(el) ??
      el.webkitRequestFullscreen?.bind(el) ??
      el.webkitRequestFullScreen?.bind(el);
    if (!req) return false;
    const result = req();
    if (result && typeof (result as Promise<void>).then === "function") {
      void (result as Promise<void>).catch(() => {
        /* ignore — common on iOS WebKit */
      });
    }
    return true;
  } catch {
    return false;
  }
}
