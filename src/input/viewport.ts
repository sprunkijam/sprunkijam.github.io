import { detectPlatform } from "../ui/platformGuide";

/**
 * iOS / Android chrome shrinks the visual viewport. Desktop Windows does not,
 * and writing exact pixel sizes into #stage-root on every vv resize used to
 * feed ResizeObserver → relayout → renderer.resize (the maximize freeze loop).
 * Desktop now freezes the GPU buffer after boot; this pin stays off so we
 * never even *offer* a pixel-size feedback loop. visualViewport listeners
 * stay mobile-only — Windows Chrome at high DPI can emit vv resize/scroll
 * while idle and that used to rAF-pin a core.
 */
export function shouldPinVisualViewport(
  ua = typeof navigator !== "undefined" ? navigator.userAgent : "",
): boolean {
  const family = detectPlatform(ua).family;
  return family === "ios" || family === "android";
}

function applyDesktopStageCss(el: HTMLElement): void {
  // Write once. Re-setting width/height:100% on every window resize dirty-checks
  // layout and used to feed the present loop even when values were unchanged.
  // Keep inset:0 — clearing left/top/right/bottom after inset used to undo the
  // pin so the stage could sit at its static position instead of the full window.
  if (el.dataset.stagePin === "desktop") return;
  el.dataset.stagePin = "desktop";
  el.style.position = "fixed";
  el.style.top = "0";
  el.style.right = "0";
  el.style.bottom = "0";
  el.style.left = "0";
  el.style.inset = "0";
  el.style.width = "100%";
  el.style.height = "100dvh";
}

function applyVisualViewportPin(el: HTMLElement, vv: VisualViewport): void {
  if (el.dataset.stagePin === "desktop") delete el.dataset.stagePin;
  // Integer CSS pixels — subpixel vv.width on Windows DPR used to fight ResizeObserver.
  const w = Math.max(1, Math.round(vv.width));
  const h = Math.max(1, Math.round(vv.height));
  const left = Math.round(vv.offsetLeft);
  const top = Math.round(vv.offsetTop);
  const widthPx = `${w}px`;
  const heightPx = `${h}px`;
  if (
    el.style.position === "fixed" &&
    el.style.width === widthPx &&
    el.style.height === heightPx &&
    el.style.left === `${left}px` &&
    el.style.top === `${top}px`
  ) {
    return;
  }
  el.style.position = "fixed";
  el.style.width = widthPx;
  el.style.height = heightPx;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.right = "auto";
  el.style.bottom = "auto";
}

/** Glue an overlay (stage, title gate) to the visible iOS Edge / Safari viewport. */
export function pinToVisualViewport(el: HTMLElement): void {
  const vv = window.visualViewport;
  if (vv && shouldPinVisualViewport()) {
    applyVisualViewportPin(el, vv);
  } else {
    applyDesktopStageCss(el);
  }
}

function setCssVar(name: string, value: string): void {
  const root = document.documentElement.style;
  if (root.getPropertyValue(name) === value) return;
  root.setProperty(name, value);
}

function syncViewportVars(): void {
  if (shouldPinVisualViewport()) {
    const vv = window.visualViewport;
    const w = Math.round(vv?.width ?? window.innerWidth);
    const h = Math.round(vv?.height ?? window.innerHeight);
    setCssVar("--vv-width", `${w}px`);
    setCssVar("--vv-height", `${h}px`);
    return;
  }
  // Desktop: fill the window box. visualViewport can be smaller than innerWidth
  // during a drag / with browser chrome, and #stage-root reads these vars.
  setCssVar("--vv-width", "100vw");
  setCssVar("--vv-height", "100dvh");
}

/** Keep an overlay glued to the visible viewport (Dynamic Island + browser chrome). */
export function bindToVisualViewport(el: HTMLElement, onChange?: () => void): () => void {
  const apply = (): void => {
    pinToVisualViewport(el);
    syncViewportVars();
    onChange?.();
  };

  apply();
  const schedule = (): void => {
    window.requestAnimationFrame(apply);
  };

  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
  window.addEventListener("pageshow", schedule);
  // Desktop must not rAF-pin on visualViewport. Windows Chrome at high DPI
  // can emit vv resize/scroll while idle; the present path already coalesces
  // window + vv resize. iPhone / Android still glue to the visible chrome.
  const pinVv = shouldPinVisualViewport();
  if (pinVv) {
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
  }

  return () => {
    window.removeEventListener("resize", schedule);
    window.removeEventListener("orientationchange", schedule);
    window.removeEventListener("pageshow", schedule);
    if (pinVv) {
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    }
  };
}

/** Keep the stage glued to the visible iOS Edge / Safari viewport (Dynamic Island + chrome). */
export function bindMobileViewport(host: HTMLElement, onChange?: () => void): () => void {
  return bindToVisualViewport(host, onChange);
}

/**
 * Prefer the smaller of host vs window so `100vw` / flex cannot report a
 * monitor-ish CSS box while the real window is a snapped or DevTools pane
 * (the 1259×900 GPU into a 436×560 letterbox).
 */
export function tightDesktopCssEdge(hostPx: number, innerPx: number): number {
  const host = Math.max(0, Math.round(hostPx));
  const inner = Math.max(0, Math.round(innerPx));
  if (host > 1 && inner > 1) return Math.min(host, inner);
  return host > 1 ? host : inner;
}

/**
 * Tight CSS box for desktop GPU boot / letterbox. Mobile still uses
 * `visibleSize` (visualViewport pin).
 */
export function desktopHostCssBox(host: HTMLElement): { w: number; h: number } {
  const innerW = typeof window !== "undefined" ? window.innerWidth || 0 : 0;
  const innerH = typeof window !== "undefined" ? window.innerHeight || 0 : 0;
  return {
    w: Math.max(1, tightDesktopCssEdge(host.clientWidth || 0, innerW)),
    h: Math.max(1, tightDesktopCssEdge(host.clientHeight || 0, innerH)),
  };
}

export function visibleSize(host: HTMLElement): { w: number; h: number } {
  const vv = window.visualViewport;
  const useVv = Boolean(vv && shouldPinVisualViewport());
  if (useVv) {
    return {
      w: Math.max(320, Math.round(vv!.width)),
      h: Math.max(320, Math.round(vv!.height)),
    };
  }
  const box = desktopHostCssBox(host);
  return {
    w: Math.max(320, box.w),
    h: Math.max(320, box.h),
  };
}

/**
 * Give #stage-root a real pixel size before Pixi Application.init.
 * A 0×0 host on iOS Edge / Safari can stall WebGL or produce a blank canvas.
 */
export async function ensureStageSize(host: HTMLElement): Promise<{ w: number; h: number }> {
  const apply = (): { w: number; h: number } => {
    pinToVisualViewport(host);
    const { w, h } = visibleSize(host);
    const cssW = Math.max(1, w);
    const cssH = Math.max(1, h);
    if (shouldPinVisualViewport()) {
      host.style.width = `${cssW}px`;
      host.style.height = `${cssH}px`;
    }
    return { w: cssW, h: cssH };
  };

  let size = apply();
  for (let i = 0; i < 4 && (host.clientWidth < 2 || host.clientHeight < 2); i += 1) {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
    size = apply();
  }
  if (size.w < 2 || size.h < 2) {
    size = { w: Math.max(size.w, 320), h: Math.max(size.h, 568) };
    if (shouldPinVisualViewport()) {
      host.style.width = `${size.w}px`;
      host.style.height = `${size.h}px`;
    }
  }
  // Desktop: return the tight host/window box so Pixi boots at the real pane,
  // not a 100vw monitor-ish guess that later letterboxes at presentScale 0.35.
  if (!shouldPinVisualViewport()) {
    const tight = desktopHostCssBox(host);
    if (tight.w > 1 && tight.h > 1) return tight;
  }
  return size;
}
