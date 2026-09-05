/**
 * Desktop resize: a live WebGL canvas in the compositor during a window-drag
 * storm hangs Chrome/Edge (ANGLE backbuffer + CSS flex). The surviving path:
 *
 * - Size the frozen GPU box from the real host CSS / window box at boot — never
 *   a monitor-ish guess that then letterboxes into a phone-sized pane
 * - Freeze the GPU buffer after boot (no observer-driven `renderer.resize`)
 * - Lock canvas CSS to `--gpu-css-*` and letterbox via `#stage-present` scale
 * - On desktop resize, detach the live canvas first, show one cached JPEG,
 *   remount after idle. Coalesce `window.resize` + `visualViewport`. Remount
 *   cooldown so chrome flicker cannot tear the canvas out again.
 * - Windows: never remount a live canvas whose CSS box is larger than the host
 *   (`presentScale` meaningfully < 1). Shrink or refit the frozen buffer on
 *   idle (including maximize / aspect flip), or keep the snapshot until then.
 *
 * Windows desktop matches Mac sharpness now (same ~2.16MP / DPR≤2 path).
 * The old 1.2MP / DPR≤1.25 survival cap was aimed at a multi-GB spiral that
 * later diagnosis pinned on silent HTMLAudio keep-alive, not the
 * framebuffer. Freeze + snapshot-on-resize stay. iPhone still live-resizes.
 *
 * WebGL only. No Canvas2D fallback. A missing WebGL context is a title error.
 */

/** ~QHD. Safety cap for explicit / mobile resizes (forceStageSize, iPhone). */
export const MAX_BACKING_PIXELS = 2560 * 1440;

/** CSS area above this is a desktop-sized surface (mobile defer path). */
export const DEFER_GPU_CSS_PIXELS = 1_200_000;

/**
 * Windows logical max: same 1600×900 as Mac so a 200% 1440p-class CSS
 * window (~1280×720) and a ~1500px-wide jam fit without a tiny upscale.
 * Backing pixels are separately ceilinged — this is not 1600×900×2².
 */
export const WINDOWS_GPU_MAX_W = 1600;
export const WINDOWS_GPU_MAX_H = 900;

/** Mac / Linux / other desktop: same logical cap as Windows. */
export const DESKTOP_GPU_MAX_W = 1600;
export const DESKTOP_GPU_MAX_H = 900;

/**
 * Windows frozen-buffer backing budget — same formula as Mac/other desktop so
 * a 1280×720 / 1600×900 window at 1.5–2× DPR stays crisp instead of letterbox-
 * stretched from a soft 1.2MP bitmap.
 */
export const WINDOWS_MAX_BACKING_PIXELS = Math.round(
  WINDOWS_GPU_MAX_W * WINDOWS_GPU_MAX_H * 1.5 * 1.5,
);

/** Panic-era tiny ceiling kept for tests / comments (HTMLAudio was the real leak). */
export const WINDOWS_LEGACY_SURVIVAL_BACKING_PIXELS = 1_200_000;

/** Older 3MP Windows ceiling — retained for regression comments / history. */
export const WINDOWS_LEGACY_MAX_BACKING_PIXELS = 3_000_000;

/**
 * Mac / other desktop frozen-buffer backing budget: logical max × min(DPR, 2)²
 * but capped below the mobile/explicit MAX so drag storms stay cheap.
 */
export const DESKTOP_MAX_BACKING_PIXELS = Math.round(
  DESKTOP_GPU_MAX_W * DESKTOP_GPU_MAX_H * 1.5 * 1.5,
);

/** Windows WebGL DPR cap — match Mac so 175–200% displays stay sharp. */
export const WINDOWS_FROZEN_DPR_CAP = 2;

/**
 * Floor when the logical box itself exceeds the backing budget. Prefer ≥1 so
 * we do not soft-upscale a sub-1× buffer into a large CSS pane.
 */
export const WINDOWS_FROZEN_DPR_MIN = 1;

/** Mac / other desktop WebGL: allow up to 2× when the backing budget fits. */
export const DESKTOP_FROZEN_DPR_CAP = 2;

/**
 * Quiet time before a one-shot desktop GPU commit when the window flips
 * portrait ↔ landscape (rare snap / tablet rotate). Drag-resize must not
 * arm this on every tick — only orientationchange / a fully idle aspect flip.
 */
export const DESKTOP_GPU_ORIENT_IDLE_MS = 500;

/**
 * Mac / other desktop: after the last window-resize tick, wait this long
 * before remounting the live canvas and showing the present surface.
 */
export const DESKTOP_RESIZE_IDLE_MS = 220;

/**
 * Windows: longer idle before remounting the live canvas and committing the
 * letterbox transform. During the drag only a static snapshot is visible.
 */
export const WINDOWS_RESIZE_IDLE_MS = 600;

/** Kid-friendly one-liner when WebGL cannot start. No Canvas fallback. */
export const WEBGL_UNAVAILABLE_MESSAGE =
  "This game needs WebGL. Try a newer browser!";

export function isDesktopGpuFamily(family?: string): boolean {
  return family === "windows" || family === "mac" || family === "other";
}

/** Freeze the backbuffer after boot — no observer-driven realloc. */
export function shouldFreezeGpuBuffer(family?: string): boolean {
  return isDesktopGpuFamily(family);
}

type CanvasProbe = { getContext: (id: string, attrs?: unknown) => unknown };

/** Cheap off-DOM canvas context check. Releases the context when possible. */
export function probeWebGlContext(factory?: () => CanvasProbe | null): boolean {
  try {
    const canvas = factory
      ? factory()
      : typeof document !== "undefined"
        ? document.createElement("canvas")
        : null;
    if (!canvas) return false;
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    if (gl && typeof (gl as WebGLRenderingContext).getExtension === "function") {
      const lose = (gl as WebGLRenderingContext).getExtension("WEBGL_lose_context");
      lose?.loseContext();
    }
    return Boolean(gl);
  } catch {
    return false;
  }
}

export function presentIdleMs(family?: string): number {
  return family === "windows" ? WINDOWS_RESIZE_IDLE_MS : DESKTOP_RESIZE_IDLE_MS;
}

/**
 * Quiet window after remounting the live canvas. visualViewport often fires
 * once more as the transform commits; that echo must not tear the canvas out.
 */
export const DESKTOP_PRESENT_REMOUNT_COOLDOWN_MS = 280;

/**
 * Host-size delta (CSS px) that counts as a real desktop drag / maximize.
 * Sub-pixel visualViewport flicker stays under this.
 */
export const DESKTOP_PRESENT_MATERIAL_PX = 4;

/**
 * During the remount cooldown, only a jump this large may re-enter snapshot.
 * A maximize / edge-drag exceeds it immediately; chrome flicker does not.
 */
export const DESKTOP_PRESENT_REMOUNT_PX = 32;

export function presentRemountCooldownMs(_family?: string): number {
  return DESKTOP_PRESENT_REMOUNT_COOLDOWN_MS;
}

/** True when the desktop host box changed enough to start / extend a storm. */
export function isMaterialPresentHostChange(
  prevW: number,
  prevH: number,
  nextW: number,
  nextH: number,
  thresholdPx = DESKTOP_PRESENT_MATERIAL_PX,
): boolean {
  return (
    Math.abs(nextW - prevW) > thresholdPx || Math.abs(nextH - prevH) > thresholdPx
  );
}

/**
 * Tear the live Pixi canvas out of the DOM during a desktop resize storm.
 * All desktop families (Windows / Mac / other). iPhone never.
 */
export function shouldSnapshotPresentDuringResize(family?: string): boolean {
  return isDesktopGpuFamily(family);
}

/**
 * presentScale below this means the live canvas CSS box is larger than the
 * host — the Windows compositor death path (3MP into a 436×560 pane).
 */
export const PRESENT_LIVE_MIN_SCALE = 0.92;

export function presentScaleIsUndersized(
  scale: number,
  threshold = PRESENT_LIVE_MIN_SCALE,
): boolean {
  return scale < threshold;
}

/**
 * Windows only: after resize idle, shrink the frozen buffer (or keep the
 * snapshot) so a live canvas is never composited larger than the host.
 * Mac / other keep the sharper boot buffer and may letterbox down.
 */
export function shouldFitFrozenPresentToHost(family?: string): boolean {
  return family === "windows";
}

/**
 * Clamp a CSS size into the desktop GPU budget, preserving aspect.
 * 1920×1080 Windows → 1600×900; a small window stays as-is.
 */
export function pickFixedGpuSize(
  cssW: number,
  cssH: number,
  family?: string,
): { w: number; h: number } {
  const maxW = family === "windows" ? WINDOWS_GPU_MAX_W : DESKTOP_GPU_MAX_W;
  const maxH = family === "windows" ? WINDOWS_GPU_MAX_H : DESKTOP_GPU_MAX_H;
  const w = Math.max(1, Math.round(cssW));
  const h = Math.max(1, Math.round(cssH));
  const scale = Math.min(1, maxW / w, maxH / h);
  return {
    w: Math.max(320, Math.round(w * scale)),
    h: Math.max(320, Math.round(h * scale)),
  };
}

/**
 * Uniform letterbox scale so a fixed GPU buffer fits inside the host without
 * changing the canvas element's CSS width/height (Chrome presentation path).
 */
export function presentScaleFor(hostW: number, hostH: number, gpuW: number, gpuH: number): number {
  const hw = Math.max(1, hostW);
  const hh = Math.max(1, hostH);
  const gw = Math.max(1, gpuW);
  const gh = Math.max(1, gpuH);
  return Math.min(hw / gw, hh / gh);
}

/** Same portrait test as `computeLayout` (pads / tray). */
export function isPortraitSize(w: number, h: number): boolean {
  return h >= w * 0.95;
}

/**
 * Mobile / explicit resize path: DPR up to 2, capped by MAX_BACKING_PIXELS.
 */
export function cappedResolution(
  cssW: number,
  cssH: number,
  dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
): number {
  const want = Math.min(Math.max(dpr, 0.5), 2);
  const area = Math.max(1, cssW) * Math.max(1, cssH);
  if (area * want * want <= MAX_BACKING_PIXELS) return want;
  return Math.max(0.5, Math.sqrt(MAX_BACKING_PIXELS / area));
}

/**
 * Frozen desktop Pixi resolution. DPR-aware, capped by family backing budget.
 * Windows may use up to WINDOWS_FROZEN_DPR_CAP, and may drop as low as
 * WINDOWS_FROZEN_DPR_MIN when the logical box itself exceeds the ceiling.
 */
export function frozenDesktopResolution(
  gpuW: number,
  gpuH: number,
  family?: string,
  dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
): number {
  const dprCap = family === "windows" ? WINDOWS_FROZEN_DPR_CAP : DESKTOP_FROZEN_DPR_CAP;
  const minRes = family === "windows" ? WINDOWS_FROZEN_DPR_MIN : 1;
  const maxBacking = family === "windows" ? WINDOWS_MAX_BACKING_PIXELS : DESKTOP_MAX_BACKING_PIXELS;
  const want = Math.min(Math.max(dpr, minRes), dprCap);
  const area = Math.max(1, gpuW) * Math.max(1, gpuH);
  if (area * want * want <= maxBacking) return want;
  return Math.max(minRes, Math.sqrt(maxBacking / area));
}

/** Logical CSS size + capped resolution for a frozen desktop present. */
export function pickFrozenDesktopPresent(
  cssW: number,
  cssH: number,
  family?: string,
  dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
): { w: number; h: number; resolution: number } {
  const { w, h } = pickFixedGpuSize(cssW, cssH, family);
  return { w, h, resolution: frozenDesktopResolution(w, h, family, dpr) };
}

/** Backing pixels for a frozen buffer (logical × resolution²). */
export function frozenBackingPixels(gpuW: number, gpuH: number, resolution: number): number {
  const res = Math.max(0, resolution);
  return Math.max(1, gpuW) * Math.max(1, gpuH) * res * res;
}

/**
 * Grow-only idle settle: true when the settled host wants a larger frozen
 * buffer (or a higher DPR within the ceiling) without shrinking either edge.
 * Tall/narrow letterbox (516×1100 over a 900×600 GPU) must not realloc.
 */
export function shouldGrowFrozenDesktopBuffer(
  curW: number,
  curH: number,
  curRes: number,
  wantW: number,
  wantH: number,
  wantRes: number,
): boolean {
  if (wantW < curW - 4 || wantH < curH - 4) return false;
  const curBack = frozenBackingPixels(curW, curH, curRes);
  const wantBack = frozenBackingPixels(wantW, wantH, wantRes);
  return (
    wantW > curW + 4 ||
    wantH > curH + 4 ||
    wantRes > curRes + 0.04 ||
    wantBack > curBack * 1.02
  );
}


/**
 * Idle settle after desktop resize: true when the frozen buffer should be
 * rebuilt to match the host (grow, shrink-within-fit, or aspect flip).
 * Letterboxing a tall boot buffer into a wide maximize left bright #stage-fill
 * strips around a black phase-hop rectangle — thrash mitigations no longer
 * need to forbid this realloc once the window is idle.
 */
export function shouldRefitFrozenDesktopBuffer(
  curW: number,
  curH: number,
  curRes: number,
  wantW: number,
  wantH: number,
  wantRes: number,
): boolean {
  if (shouldGrowFrozenDesktopBuffer(curW, curH, curRes, wantW, wantH, wantRes)) {
    return true;
  }
  const aspectCur = curW / Math.max(1, curH);
  const aspectWant = wantW / Math.max(1, wantH);
  if (Math.abs(aspectCur - aspectWant) > 0.04) return true;
  if (Math.abs(curW - wantW) > 8 || Math.abs(curH - wantH) > 8) return true;
  if (Math.abs(curRes - wantRes) > 0.04) return true;
  return false;
}

/** Hard backing-pixel ceiling for a frozen desktop boot. */
export function frozenBackingBudget(family?: string): number {
  return family === "windows" ? WINDOWS_MAX_BACKING_PIXELS : DESKTOP_MAX_BACKING_PIXELS;
}

export function shouldAntialias(
  cssW: number,
  cssH: number,
  family?: string,
): boolean {
  if (isDesktopGpuFamily(family)) return false;
  return cssW * cssH < DEFER_GPU_CSS_PIXELS;
}

/** Sudden maximize / 4K jump on **mobile** — don't realloc on the critical frame. */
export function shouldDeferGpuResize(cssW: number, cssH: number): boolean {
  return cssW * cssH > DEFER_GPU_CSS_PIXELS;
}
