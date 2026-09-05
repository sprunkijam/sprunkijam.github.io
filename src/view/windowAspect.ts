/**
 * Landscape vs portrait for title + stage photos.
 *
 * Always use the browser window / host CSS box (innerWidth×innerHeight or
 * the stage host). Never `screen.orientation` and never CSS
 * `@media (orientation: …)` — those follow the monitor, so a tall window on
 * a landscape display keeps the wrong JPEG.
 */

import { artUrl } from "../publicUrl";

export type PhotoOrient = "portrait" | "landscape";

export function photoOrientForBox(w: number, h: number): PhotoOrient {
  return h > w ? "portrait" : "landscape";
}

export function windowBoxSize(): { w: number; h: number } {
  const w = typeof window !== "undefined" ? window.innerWidth || 0 : 0;
  const h = typeof window !== "undefined" ? window.innerHeight || 0 : 0;
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

/** Window-box picker. Host CSS box wins when the caller has one (tests / frozen GPU). */
export function photoOrientForHost(host?: { w: number; h: number } | null): PhotoOrient {
  if (host && host.w > 0 && host.h > 0) return photoOrientForBox(host.w, host.h);
  return photoOrientForBox(windowBoxSize().w, windowBoxSize().h);
}

export function applyWindowOrientAttr(
  orient: PhotoOrient = photoOrientForHost(),
  el: HTMLElement | null = typeof document !== "undefined" ? document.documentElement : null,
): PhotoOrient {
  if (el && el.dataset.windowOrient !== orient) el.dataset.windowOrient = orient;
  if (typeof document !== "undefined" && document.body && document.body.dataset.windowOrient !== orient) {
    document.body.dataset.windowOrient = orient;
  }
  return orient;
}

/**
 * Title-gate CSS heroes. Full 6000×4000 / 2600×5400 masters stay in /art for
 * archival; the gate must never paint those — Windows Edge/Chrome re-rasterizes
 * object-fit cover of a 24MP bitmap on every resize into a multi-GB spiral.
 * Title masters are ≤4000 on the long edge (~10.7MP), scaled from the 6000px sources.
 */
export const TITLE_ART = {
  ring: {
    landscape: artUrl("intro-ring-landscape-title.jpeg"),
    portrait: artUrl("intro-ring-portrait-title.jpeg"),
    fallback: artUrl("intro-ring-title.jpeg"),
  },
  dark: {
    landscape: artUrl("intro-black-vineria-landscape-title.jpeg"),
    portrait: artUrl("intro-black-vineria-portrait-title.jpeg"),
    fallback: artUrl("intro-black-vineria-title.jpeg"),
  },
} as const;

export type TitleArtKind = keyof typeof TITLE_ART;

export function titleArtUrl(kind: TitleArtKind, orient: PhotoOrient): string {
  return TITLE_ART[kind][orient];
}

export function titleArtFallback(kind: TitleArtKind): string {
  return TITLE_ART[kind].fallback;
}

/** Intrinsic JPEG box used as width/height hints so object-fit cover has the right ratio. */
export const TITLE_ART_SIZE: Record<PhotoOrient, { w: number; h: number }> = {
  landscape: { w: 4000, h: 2666 },
  portrait: { w: 1926, h: 4000 },
};

export function bindWindowAspect(onChange: (orient: PhotoOrient) => void): () => void {
  let last = applyWindowOrientAttr();
  onChange(last);
  const apply = (): void => {
    const next = applyWindowOrientAttr();
    // Same orientation: do nothing. Re-firing on every resize used to poke
    // <img width/height> and keep Edge compositing 24MP title bitmaps.
    if (next === last) return;
    last = next;
    onChange(next);
  };
  const onResize = (): void => {
    window.requestAnimationFrame(apply);
  };
  window.addEventListener("resize", onResize);
  return () => {
    window.removeEventListener("resize", onResize);
  };
}
