import { expect, test } from "@playwright/test";
import { shouldKickFullscreen } from "../src/input/fullscreen";
import { shouldPinVisualViewport, tightDesktopCssEdge } from "../src/input/viewport";
import {
  cappedResolution,
  DESKTOP_FROZEN_DPR_CAP,
  DESKTOP_GPU_MAX_H,
  DESKTOP_GPU_MAX_W,
  DESKTOP_MAX_BACKING_PIXELS,
  DESKTOP_PRESENT_MATERIAL_PX,
  DESKTOP_PRESENT_REMOUNT_COOLDOWN_MS,
  DESKTOP_PRESENT_REMOUNT_PX,
  DESKTOP_RESIZE_IDLE_MS,
  frozenBackingBudget,
  frozenBackingPixels,
  frozenDesktopResolution,
  isDesktopGpuFamily,
  isMaterialPresentHostChange,
  MAX_BACKING_PIXELS,
  pickFixedGpuSize,
  pickFrozenDesktopPresent,
  PRESENT_LIVE_MIN_SCALE,
  presentIdleMs,
  presentRemountCooldownMs,
  presentScaleFor,
  presentScaleIsUndersized,
  shouldFitFrozenPresentToHost,
  shouldGrowFrozenDesktopBuffer,
  shouldRefitFrozenDesktopBuffer,
  shouldAntialias,
  shouldDeferGpuResize,
  shouldFreezeGpuBuffer,
  shouldSnapshotPresentDuringResize,
  WINDOWS_FROZEN_DPR_CAP,
  WINDOWS_FROZEN_DPR_MIN,
  WINDOWS_GPU_MAX_H,
  WINDOWS_GPU_MAX_W,
  WINDOWS_LEGACY_MAX_BACKING_PIXELS,
  WINDOWS_LEGACY_SURVIVAL_BACKING_PIXELS,
  WINDOWS_MAX_BACKING_PIXELS,
  WINDOWS_RESIZE_IDLE_MS,
} from "../src/view/gpuBudget";
import {
  coverScale,
  cssObjectPosition,
  hostCoverInGpuSpace,
  PHASE1_TREE_PIVOT,
  pivotForPhaseSet,
} from "../src/view/photoCover";
import { windowsPhotoUploadSize } from "../src/view/textures";
import { photoOrientForBox, titleArtUrl } from "../src/view/windowAspect";
import { jamArtUrls } from "../src/view/assetWarmup";

const WINDOWS_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const MAC_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const LINUX_CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const CROS_CHROME_UA =
  "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const IPHONE_SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const ANDROID_CHROME_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";

type LayoutProbe = {
  relayoutCount: number;
  gpuResizeCount: number;
  lastRelayoutMs: number;
  maxRelayoutMs: number;
  inRelayout: boolean;
  screenW: number;
  screenH: number;
  resolution: number;
  antialias: boolean;
  backingPixels: number;
  gpuFrozen: boolean;
  canvasCssW: number;
  canvasCssH: number;
  hostCssW?: number;
  hostCssH?: number;
  presentScale: number;
  tickerPausedForResize: boolean;
  presentHiddenForResize: boolean;
  presentSnapshotForResize: boolean;
  canvasInDom: boolean;
  presentFreeze: boolean;
  devicePixelRatio: number;
  rendererName: string;
  presentMode: "webgl";
  webglContext: boolean;
  snapshotUrlCount?: number;
  filterResizeCount?: number;
  dustUpdates?: number;
};

type PresentDom = {
  canvasInDom: boolean;
  canvasVisible: boolean;
  snapshotInDom: boolean;
  snapshotVisible: boolean;
  snapshotHasSrc: boolean;
};

async function presentDom(page: import("@playwright/test").Page): Promise<PresentDom> {
  return inspectPresent(page);
}

/**
 * Snapshot + canvas DOM in one turn. `pokeResize` re-fires resize first so a
 * slow Playwright `setViewportSize` (which can outlast the 600ms idle) cannot
 * remount the live canvas between the size change and the assertion.
 */
async function inspectPresent(
  page: import("@playwright/test").Page,
  opts?: { pokeResize?: boolean },
): Promise<PresentDom & { probe: LayoutProbe | null }> {
  return page.evaluate((poke) => {
    if (poke) {
      // Production ignores same-size resize / visualViewport echoes so remount
      // cannot sawtooth. Tests still need to arm snapshot in this turn.
      window.__sprunkiJamTest?.forcePresentSnapshot?.();
      window.dispatchEvent(new Event("resize"));
      window.visualViewport?.dispatchEvent(new Event("resize"));
    }
    const probe = window.__sprunkiJamTest?.layoutProbe?.() ?? null;
    const canvases = [...document.querySelectorAll("#stage-root canvas")];
    const snap = document.querySelector("#stage-snapshot, [data-stage-snapshot]");
    const vis = (el: Element | null): boolean => {
      if (!el || !el.isConnected) return false;
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    return {
      probe,
      canvasInDom: canvases.some((c) => c.isConnected),
      canvasVisible: canvases.some((c) => vis(c)),
      snapshotInDom: Boolean(snap?.isConnected),
      snapshotVisible: vis(snap),
      snapshotHasSrc: snap instanceof HTMLImageElement && snap.src.length > 0,
    };
  }, Boolean(opts?.pokeResize));
}

async function layoutProbe(page: import("@playwright/test").Page): Promise<LayoutProbe> {
  const probe = await page.evaluate(() => window.__sprunkiJamTest?.layoutProbe?.() ?? null);
  expect(probe, "layoutProbe hook must exist").toBeTruthy();
  return probe!;
}

async function hostFill(page: import("@playwright/test").Page): Promise<{
  hostW: number;
  hostH: number;
  innerW: number;
  innerH: number;
  vvW: string;
  vvH: string;
}> {
  return page.evaluate(() => {
    const host = document.getElementById("stage-root");
    const r = host?.getBoundingClientRect();
    return {
      hostW: r?.width ?? 0,
      hostH: r?.height ?? 0,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      vvW: document.documentElement.style.getPropertyValue("--vv-width").trim(),
      vvH: document.documentElement.style.getPropertyValue("--vv-height").trim(),
    };
  });
}

function expectHostFillsWindow(
  fill: { hostW: number; hostH: number; innerW: number; innerH: number; vvW: string; vvH: string },
  label: string,
): void {
  expect(Math.abs(fill.hostW - fill.innerW), `${label}: #stage-root width vs window`).toBeLessThanOrEqual(
    2,
  );
  expect(Math.abs(fill.hostH - fill.innerH), `${label}: #stage-root height vs window`).toBeLessThanOrEqual(
    2,
  );
  expect(fill.vvW, `${label}: desktop --vv-width must be the window box, not a vv pixel box`).toBe(
    "100vw",
  );
  expect(fill.vvH, `${label}: desktop --vv-height must be the window box`).toBe("100dvh");
}

function heapUsed(): number | null {
  const perf = performance as Performance & { usedJSHeapSize?: number; memory?: { usedJSHeapSize: number } };
  return perf.memory?.usedJSHeapSize ?? null;
}

/** Map a pad's GPU-space center through the CSS-stretched canvas to page coords. */
async function clickSlotCss(page: import("@playwright/test").Page, slot: string): Promise<void> {
  const mapped = await page.evaluate((id) => {
    const jam = window.__sprunkiJamTest;
    const c = jam?.slotCenter?.(id);
    const probe = jam?.layoutProbe?.();
    const canvas = document.querySelector("#stage-root canvas");
    if (!c || !probe || !canvas || probe.screenW < 1 || probe.screenH < 1) return null;
    const r = canvas.getBoundingClientRect();
    return {
      x: r.left + (c.x / probe.screenW) * r.width,
      y: r.top + (c.y / probe.screenH) * r.height,
    };
  }, slot);
  expect(mapped, `could not map slot ${slot} through CSS canvas`).toBeTruthy();
  await page.mouse.click(mapped!.x, mapped!.y);
}

function dragResizeSteps(): { width: number; height: number }[] {
  const steps: { width: number; height: number }[] = [];
  const pushLerp = (aW: number, aH: number, bW: number, bH: number, n: number): void => {
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      steps.push({
        width: Math.round(aW + (bW - aW) * t),
        height: Math.round(aH + (bH - aH) * t),
      });
    }
  };
  // Simulate dragging a window edge: many intermediate sizes, then back.
  pushLerp(800, 600, 1920, 1080, 24);
  pushLerp(1920, 1080, 1280, 720, 12);
  pushLerp(1280, 720, 900, 600, 12);
  pushLerp(900, 600, 1600, 900, 10);
  return steps;
}

test("shouldKickFullscreen is phones/tablets only — never desktops or laptops", () => {
  expect(shouldKickFullscreen({ ua: WINDOWS_CHROME_UA, uaDataMobile: false })).toBe(false);
  expect(
    shouldKickFullscreen({
      ua: WINDOWS_CHROME_UA,
      uaDataMobile: false,
      pointerFine: true,
      hoverHover: true,
      maxTouchPoints: 10,
    }),
  ).toBe(false);
  expect(shouldKickFullscreen({ ua: MAC_CHROME_UA, uaDataMobile: false })).toBe(false);
  expect(
    shouldKickFullscreen({
      ua: MAC_CHROME_UA,
      pointerFine: true,
      hoverHover: true,
    }),
  ).toBe(false);
  expect(shouldKickFullscreen({ ua: LINUX_CHROME_UA, uaDataMobile: false })).toBe(false);
  expect(shouldKickFullscreen({ ua: CROS_CHROME_UA, uaDataMobile: false })).toBe(false);

  expect(
    shouldKickFullscreen({
      ua: IPHONE_SAFARI_UA,
      uaDataMobile: true,
      pointerCoarse: true,
      hoverNone: true,
      shortSide: 390,
      maxTouchPoints: 5,
    }),
  ).toBe(true);
  expect(
    shouldKickFullscreen({
      ua: IPAD_DESKTOP_UA,
      platform: "MacIntel",
      maxTouchPoints: 5,
      uaDataMobile: false,
    }),
  ).toBe(true);
  expect(shouldKickFullscreen({ ua: ANDROID_CHROME_UA, uaDataMobile: true })).toBe(true);
  expect(shouldKickFullscreen({ uaDataMobile: true })).toBe(true);
});

test("desktop Windows must not pin visualViewport pixels; iPhone still does", () => {
  expect(shouldPinVisualViewport(WINDOWS_CHROME_UA)).toBe(false);
  expect(shouldPinVisualViewport(IPHONE_SAFARI_UA)).toBe(true);
});

test("title warmup lists Phase 1 first, then every other jam JPEG", () => {
  const { first, rest } = jamArtUrls();
  expect(first).toEqual([
    "/art/bg-phase1-landscape.jpeg",
    "/art/bg-phase1-portrait.jpeg",
  ]);
  expect(rest).toContain("/art/bg-phase2-landscape.jpeg");
  expect(rest).toContain("/art/oren-portrait-horror.jpeg");
  expect(rest).toContain("/art/green-portrait-phase10.jpeg");
  expect(rest).toContain("/art/intro-ring-landscape-title.jpeg");
  expect(rest).not.toContain("/art/intro-ring-landscape.jpeg");
  expect(rest).not.toContain("/art/bg-phase1-landscape.jpeg");
});

test("window-box photo pick, exact cover, tree pivot, Windows upload cap", () => {
  expect(photoOrientForBox(900, 600)).toBe("landscape");
  expect(photoOrientForBox(600, 900)).toBe("portrait");
  expect(photoOrientForBox(800, 800)).toBe("landscape");
  expect(titleArtUrl("ring", "landscape")).toBe("/art/intro-ring-landscape-title.jpeg");
  expect(titleArtUrl("ring", "portrait")).toBe("/art/intro-ring-portrait-title.jpeg");
  expect(titleArtUrl("dark", "landscape")).toBe("/art/intro-black-vineria-landscape-title.jpeg");

  // Exact cover — never an extra zoom factor.
  expect(coverScale(1600, 900, 6000, 4000)).toBeCloseTo(1600 / 6000, 8);
  expect(coverScale(390, 844, 2600, 5400)).toBeCloseTo(844 / 5400, 8);
  const mismatch = coverScale(390, 844, 6000, 4000);
  expect(mismatch).toBeCloseTo(844 / 4000, 8);
  expect(mismatch).toBeGreaterThan(coverScale(390, 844, 2600, 5400));

  expect(pivotForPhaseSet(1, "landscape")).toEqual(PHASE1_TREE_PIVOT.landscape);
  expect(PHASE1_TREE_PIVOT.landscape.x).toBeGreaterThan(0.65);
  expect(pivotForPhaseSet(2, "landscape")).toEqual({ x: 0.5, y: 0.5 });
  expect(cssObjectPosition(PHASE1_TREE_PIVOT.landscape)).toBe("72% 40%");

  // Frozen landscape GPU + tall host: cover the host, not the GPU, so bars fill.
  const hostCover = hostCoverInGpuSpace(1600, 900, 600, 900, 2600, 5400, PHASE1_TREE_PIVOT.portrait);
  expect(hostCover.scale).toBeCloseTo(coverScale(1600, 2400, 2600, 5400), 8);

  // Windows photo upload tracks the restored desktop backing budget (~2.16MP).
  const full = windowsPhotoUploadSize(1920, 1080);
  expect(full.scaled).toBe(false);
  const fits = windowsPhotoUploadSize(960, 540);
  expect(fits.scaled).toBe(false);
  const huge = windowsPhotoUploadSize(6000, 4000);
  expect(huge.scaled).toBe(true);
  expect(huge.w * huge.h).toBeLessThanOrEqual(WINDOWS_MAX_BACKING_PIXELS + 1);
  expect(huge.w).toBeGreaterThan(1000);
  expect(huge.h).toBeGreaterThan(700);
});

test("GPU budget freezes desktop buffers; mobile still resizes", () => {
  expect(shouldFreezeGpuBuffer("windows")).toBe(true);
  expect(shouldFreezeGpuBuffer("mac")).toBe(true);
  expect(shouldFreezeGpuBuffer("other")).toBe(true);
  expect(shouldFreezeGpuBuffer("ios")).toBe(false);
  expect(shouldFreezeGpuBuffer("android")).toBe(false);
  expect(isDesktopGpuFamily("windows")).toBe(true);

  expect(WINDOWS_GPU_MAX_W).toBe(1600);
  expect(WINDOWS_GPU_MAX_H).toBe(900);
  // 900×600 fits the 1600×900 logical max.
  expect(pickFixedGpuSize(900, 600, "windows")).toEqual({ w: 900, h: 600 });
  expect(pickFixedGpuSize(800, 500, "windows")).toEqual({ w: 800, h: 500 });
  expect(pickFixedGpuSize(1920, 1080, "windows")).toEqual({
    w: WINDOWS_GPU_MAX_W,
    h: WINDOWS_GPU_MAX_H,
  });
  expect(pickFixedGpuSize(3840, 2160, "windows")).toEqual({
    w: WINDOWS_GPU_MAX_W,
    h: WINDOWS_GPU_MAX_H,
  });
  // 200% 1440p-class CSS window fits without a tiny clamp.
  expect(pickFixedGpuSize(1280, 720, "windows")).toEqual({ w: 1280, h: 720 });
  expect(pickFixedGpuSize(1500, 844, "windows")).toEqual({ w: 1500, h: 844 });
  expect(pickFixedGpuSize(1920, 1080, "mac")).toEqual({
    w: DESKTOP_GPU_MAX_W,
    h: DESKTOP_GPU_MAX_H,
  });
  expect(presentScaleFor(1920, 1080, 900, 600)).toBeCloseTo(1.8, 5);
  expect(presentScaleFor(900, 600, 900, 600)).toBeCloseTo(1, 5);
  expect(DESKTOP_RESIZE_IDLE_MS).toBeGreaterThanOrEqual(150);
  expect(DESKTOP_RESIZE_IDLE_MS).toBeLessThanOrEqual(300);
  expect(WINDOWS_RESIZE_IDLE_MS).toBeGreaterThanOrEqual(400);
  expect(WINDOWS_RESIZE_IDLE_MS).toBeLessThanOrEqual(800);
  expect(presentIdleMs("windows")).toBe(WINDOWS_RESIZE_IDLE_MS);
  expect(presentIdleMs("mac")).toBe(DESKTOP_RESIZE_IDLE_MS);
  expect(DESKTOP_PRESENT_MATERIAL_PX).toBeGreaterThanOrEqual(2);
  expect(DESKTOP_PRESENT_MATERIAL_PX).toBeLessThanOrEqual(8);
  expect(DESKTOP_PRESENT_REMOUNT_PX).toBeGreaterThan(DESKTOP_PRESENT_MATERIAL_PX);
  expect(DESKTOP_PRESENT_REMOUNT_PX).toBeLessThanOrEqual(64);
  expect(DESKTOP_PRESENT_REMOUNT_COOLDOWN_MS).toBeGreaterThanOrEqual(150);
  expect(DESKTOP_PRESENT_REMOUNT_COOLDOWN_MS).toBeLessThanOrEqual(400);
  expect(presentRemountCooldownMs("windows")).toBe(DESKTOP_PRESENT_REMOUNT_COOLDOWN_MS);
  expect(isMaterialPresentHostChange(900, 600, 900, 600)).toBe(false);
  expect(isMaterialPresentHostChange(900, 600, 902, 601)).toBe(false);
  expect(isMaterialPresentHostChange(900, 600, 1920, 1080)).toBe(true);
  expect(isMaterialPresentHostChange(1920, 1080, 1924, 1082, DESKTOP_PRESENT_REMOUNT_PX)).toBe(
    false,
  );
  expect(isMaterialPresentHostChange(1920, 1080, 1600, 900, DESKTOP_PRESENT_REMOUNT_PX)).toBe(true);

  expect(shouldSnapshotPresentDuringResize("windows")).toBe(true);
  expect(shouldSnapshotPresentDuringResize("mac")).toBe(true);
  expect(shouldSnapshotPresentDuringResize("other")).toBe(true);
  expect(shouldSnapshotPresentDuringResize("ios")).toBe(false);
  expect(shouldSnapshotPresentDuringResize("android")).toBe(false);

  expect(shouldDeferGpuResize(900, 600)).toBe(false);
  expect(shouldDeferGpuResize(1920, 1080)).toBe(true);
  expect(shouldAntialias(900, 600, "windows")).toBe(false);
  expect(shouldAntialias(1280, 800, "mac")).toBe(false);
  expect(shouldAntialias(390, 844, "ios")).toBe(true);

  const res1080pHiDpi = cappedResolution(1920, 1080, 2);
  expect(1920 * 1080 * res1080pHiDpi * res1080pHiDpi).toBeLessThanOrEqual(MAX_BACKING_PIXELS + 1);
  const res4k = cappedResolution(3840, 2160, 1);
  expect(3840 * 2160 * res4k * res4k).toBeLessThanOrEqual(MAX_BACKING_PIXELS + 1);

  // Windows GPU: match Mac sharpness (DPR ≤ 2, ~2.16MP). Panic-era 1.2MP/1.25× kept as history.
  expect(WINDOWS_FROZEN_DPR_CAP).toBe(2);
  expect(WINDOWS_FROZEN_DPR_MIN).toBe(1);
  expect(DESKTOP_FROZEN_DPR_CAP).toBe(2);
  expect(WINDOWS_MAX_BACKING_PIXELS).toBe(DESKTOP_MAX_BACKING_PIXELS);
  expect(WINDOWS_LEGACY_SURVIVAL_BACKING_PIXELS).toBe(1_200_000);
  expect(WINDOWS_MAX_BACKING_PIXELS).toBeGreaterThan(WINDOWS_LEGACY_SURVIVAL_BACKING_PIXELS);
  expect(WINDOWS_MAX_BACKING_PIXELS).toBeLessThanOrEqual(WINDOWS_LEGACY_MAX_BACKING_PIXELS + 250_000);
  expect(WINDOWS_LEGACY_MAX_BACKING_PIXELS).toBe(3_000_000);
  expect(DESKTOP_MAX_BACKING_PIXELS).toBeLessThanOrEqual(MAX_BACKING_PIXELS);
  expect(frozenBackingBudget("windows")).toBe(WINDOWS_MAX_BACKING_PIXELS);
  expect(frozenDesktopResolution(960, 540, "windows", 1)).toBe(1);
  expect(frozenDesktopResolution(960, 540, "windows", 1.75)).toBeCloseTo(1.75, 5);
  expect(frozenDesktopResolution(960, 540, "windows", 2)).toBe(2);
  expect(frozenDesktopResolution(960, 540, "windows", 1.25)).toBeCloseTo(1.25, 5);
  const winHiDpi = pickFrozenDesktopPresent(960, 540, "windows", 1.75);
  expect(winHiDpi.w).toBe(960);
  expect(winHiDpi.h).toBe(540);
  expect(winHiDpi.resolution).toBeCloseTo(1.75, 5);
  const winBacking = frozenBackingPixels(winHiDpi.w, winHiDpi.h, winHiDpi.resolution);
  expect(winBacking).toBeLessThanOrEqual(WINDOWS_MAX_BACKING_PIXELS + 1);
  expect(winBacking).toBeGreaterThan(500_000);
  const win1440 = pickFrozenDesktopPresent(1280, 720, "windows", 2);
  expect(win1440.w).toBe(1280);
  expect(win1440.h).toBe(720);
  expect(win1440.resolution).toBeLessThanOrEqual(WINDOWS_FROZEN_DPR_CAP);
  expect(frozenBackingPixels(win1440.w, win1440.h, win1440.resolution)).toBeLessThanOrEqual(
    WINDOWS_MAX_BACKING_PIXELS + 1,
  );
  const winHiRes = pickFrozenDesktopPresent(1500, 844, "windows", 2);
  expect(winHiRes.w).toBe(1500);
  expect(winHiRes.h).toBe(844);
  expect(frozenBackingPixels(winHiRes.w, winHiRes.h, winHiRes.resolution)).toBeLessThanOrEqual(
    WINDOWS_MAX_BACKING_PIXELS + 1,
  );

  // Confirmed hang: 1259×900@1.63 (3MP) letterboxed into 436×560 at ~0.35.
  const smallHost = pickFrozenDesktopPresent(436, 560, "windows", 1.75);
  expect(smallHost.w).toBe(436);
  expect(smallHost.h).toBe(560);
  expect(presentScaleFor(436, 560, smallHost.w, smallHost.h)).toBeCloseTo(1, 5);
  expect(frozenBackingPixels(smallHost.w, smallHost.h, smallHost.resolution)).toBeLessThan(
    800_000,
  );
  expect(frozenBackingPixels(smallHost.w, smallHost.h, smallHost.resolution)).toBeLessThan(
    WINDOWS_LEGACY_MAX_BACKING_PIXELS * 0.4,
  );
  expect(tightDesktopCssEdge(1259, 436)).toBe(436);
  expect(tightDesktopCssEdge(900, 560)).toBe(560);
  expect(tightDesktopCssEdge(0, 436)).toBe(436);
  expect(PRESENT_LIVE_MIN_SCALE).toBeCloseTo(0.92, 5);
  expect(presentScaleIsUndersized(0.346)).toBe(true);
  expect(presentScaleIsUndersized(1)).toBe(false);
  expect(presentScaleIsUndersized(0.92)).toBe(false);
  expect(presentScaleIsUndersized(0.91)).toBe(true);
  expect(shouldFitFrozenPresentToHost("windows")).toBe(true);
  expect(shouldFitFrozenPresentToHost("mac")).toBe(false);
  expect(shouldFitFrozenPresentToHost("ios")).toBe(false);
  expect(shouldGrowFrozenDesktopBuffer(900, 600, 1, 1600, 900, 1)).toBe(true);
  expect(shouldGrowFrozenDesktopBuffer(900, 600, 1, 900, 600, 1.75)).toBe(true);
  expect(shouldGrowFrozenDesktopBuffer(900, 600, 1, 900, 600, 1)).toBe(false);
  expect(shouldGrowFrozenDesktopBuffer(900, 600, 1, 422, 900, 1)).toBe(false);
  expect(shouldGrowFrozenDesktopBuffer(1600, 900, 1, 800, 600, 1)).toBe(false);
  // Aspect flip / maximize must refit (grow-only alone left letterbox bars).
  expect(shouldRefitFrozenDesktopBuffer(900, 1100, 1, 1600, 900, 1)).toBe(true);
  expect(shouldRefitFrozenDesktopBuffer(800, 600, 1, 1600, 900, 1)).toBe(true);
  expect(shouldRefitFrozenDesktopBuffer(1600, 900, 1, 1600, 900, 1)).toBe(false);

  expect(frozenDesktopResolution(1600, 900, "mac", 2)).toBeLessThanOrEqual(DESKTOP_FROZEN_DPR_CAP);
  const macRes = frozenDesktopResolution(1600, 900, "mac", 2);
  expect(1600 * 900 * macRes * macRes).toBeLessThanOrEqual(DESKTOP_MAX_BACKING_PIXELS + 1);
});

test("Windows title help does not say the jam will force fullscreen", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.detectedPlatform?.() ?? null))
    .toBe("windows");
  await expect(page.locator("#gate-help-summary")).toHaveText(/Sound & install help/i);
  await page.locator("#gate-help-summary").tap();
  await expect(page.locator("#play-guide-lead")).toHaveText(/Optional: install as an app/i);
  await expect(page.locator("#play-guide-lead")).not.toHaveText(/Best played in full screen/i);
  await expect(page.locator("#play-guide-primary")).toContainText(/will not jump to fullscreen/i);
  await expect(page.locator("#play-guide-primary")).toContainText(/Install this site as an app/i);
  await expect(page.locator("#jam-btn")).toHaveText("TAP TO JAM");
});

test("Windows TAP TO JAM does not call requestFullscreen", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __fsCalls: number }).__fsCalls = 0;
    HTMLElement.prototype.requestFullscreen = function () {
      (window as unknown as { __fsCalls: number }).__fsCalls += 1;
      return Promise.resolve();
    };
    const proto = HTMLElement.prototype as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void>;
    };
    proto.webkitRequestFullscreen = function () {
      (window as unknown as { __fsCalls: number }).__fsCalls += 1;
      return Promise.resolve();
    };
  });

  await page.goto("/", { waitUntil: "networkidle" });
  expect(await page.evaluate(() => window.__sprunkiJamTest?.shouldKickFullscreen?.())).toBe(false);
  expect(
    await page.evaluate(() =>
      window.__sprunkiJamTest?.shouldKickFullscreen?.({ uaDataMobile: true, ua: "iPhone" }),
    ),
  ).toBe(true);
  expect(await page.evaluate(() => window.__sprunkiJamTest?.kickFullscreen?.())).toBe(false);

  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  const calls = await page.evaluate(() => (window as unknown as { __fsCalls: number }).__fsCalls);
  expect(calls, "Windows TAP TO JAM must not request fullscreen").toBe(0);
});

test("Mac desktop TAP TO JAM does not call requestFullscreen", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: true,
    userAgent: MAC_CHROME_UA,
  });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      (window as unknown as { __fsCalls: number }).__fsCalls = 0;
      HTMLElement.prototype.requestFullscreen = function () {
        (window as unknown as { __fsCalls: number }).__fsCalls += 1;
        return Promise.resolve();
      };
    });
    await page.goto("/", { waitUntil: "networkidle" });
    expect(await page.evaluate(() => window.__sprunkiJamTest?.shouldKickFullscreen?.())).toBe(false);
    await page.locator("#jam-btn").tap();
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
    const calls = await page.evaluate(() => (window as unknown as { __fsCalls: number }).__fsCalls);
    expect(calls, "Mac TAP TO JAM must not request fullscreen").toBe(0);
    const macProbe = await page.evaluate(() => window.__sprunkiJamTest?.layoutProbe?.() ?? null);
    expect(macProbe?.gpuFrozen, "Mac desktop must freeze the GPU buffer").toBe(true);
    expect(macProbe?.resolution, "Mac at DPR 1 uses resolution 1").toBe(1);
    expect(macProbe?.antialias, "Mac desktop skips MSAA").toBe(false);
    expect(macProbe?.backingPixels).toBeLessThanOrEqual(DESKTOP_MAX_BACKING_PIXELS + 8_000);
    expect(macProbe?.presentMode, "Mac default is WebGL").toBe("webgl");
    expect(macProbe?.webglContext).toBe(true);
  } finally {
    await context.close();
  }
});

/**
 * Maximize-like jump: 900×600 → 1920×1080.
 * Desktop GPU buffer stays at boot size; canvas CSS stays at that size;
 * `#stage-present` letterboxes via transform. PR #30 still flexed canvas CSS
 * to 100% — that is the Windows presentation death path.
 */
test("large viewport jump letterboxes without reallocating the GPU buffer", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  const before = await layoutProbe(page);
  expect(before.antialias, "Windows must not boot with MSAA").toBe(false);
  expect(before.gpuFrozen, "Windows must freeze the GPU buffer after boot").toBe(true);
  expect(before.presentFreeze, "desktop must enable present-freeze letterbox").toBe(true);
  expect(before.presentMode).toBe("webgl");
  expect(before.devicePixelRatio).toBeCloseTo(1, 2);
  expect(before.inRelayout).toBe(false);
  expect(before.screenW).toBeGreaterThan(300);
  expect(before.screenH).toBeGreaterThan(300);
  expect(before.backingPixels).toBeLessThanOrEqual(WINDOWS_MAX_BACKING_PIXELS + 8_000);
  expect(before.canvasCssW).toBe(before.screenW);
  expect(before.canvasCssH).toBe(before.screenH);
  expect(await page.locator("#stage-present").count()).toBe(1);
  expectHostFillsWindow(await hostFill(page), "boot 900×600");

  const t0 = Date.now();
  await page.setViewportSize({ width: 1920, height: 1080 });

  const wantScale = presentScaleFor(1920, 1080, before.screenW, before.screenH);
  // Present scale commits after resize idle (not mid-drag) — wait for settle.
  await expect
    .poll(
      async () => {
        const p = await page.evaluate(() => window.__sprunkiJamTest?.layoutProbe?.() ?? null);
        const box = await page.locator("#stage-root canvas").boundingBox();
        return Boolean(
          p &&
            box &&
            !p.tickerPausedForResize &&
            !p.presentHiddenForResize &&
            !p.presentSnapshotForResize &&
            p.canvasInDom &&
            Math.abs(p.screenW - before.screenW) < 1 &&
            Math.abs(p.screenH - before.screenH) < 1 &&
            Math.abs(p.canvasCssW - before.screenW) < 2 &&
            Math.abs(p.canvasCssH - before.screenH) < 2 &&
            p.presentScale > 1.2 &&
            box.width > before.screenW * 1.2 &&
            box.height > before.screenH * 1.2,
        );
      },
      {
        timeout: 8_000,
        message: "after idle, present scale must grow; canvas CSS must stay at boot GPU size",
      },
    )
    .toBe(true);

  const elapsed = Date.now() - t0;
  expect(elapsed, `viewport jump hung the main thread (${elapsed}ms)`).toBeLessThan(8_000);

  const after = await layoutProbe(page);
  expect(after.inRelayout, "relayout must not be stuck re-entrant").toBe(false);
  expect(after.gpuFrozen).toBe(true);
  expect(after.presentFreeze).toBe(true);
  expect(after.presentHiddenForResize).toBe(false);
  expect(
    after.gpuResizeCount - before.gpuResizeCount,
    `maximize must not realloc the GPU backbuffer (before ${before.gpuResizeCount}, after ${after.gpuResizeCount})`,
  ).toBe(0);
  expect(
    after.relayoutCount - before.relayoutCount,
    `frozen desktop must not relayout on window resize (delta ${after.relayoutCount - before.relayoutCount})`,
  ).toBeLessThanOrEqual(1);
  expect(after.screenW).toBe(before.screenW);
  expect(after.screenH).toBe(before.screenH);
  expect(after.resolution).toBe(before.resolution);
  expect(after.backingPixels).toBe(before.backingPixels);
  expect(after.maxRelayoutMs, "a single relayout must not freeze the tab").toBeLessThan(2_000);
  // Layout CSS size stays at GPU buffer — transform letterbox does the rest.
  expect(after.canvasCssW).toBe(before.screenW);
  expect(after.canvasCssH).toBe(before.screenH);
  expect(after.presentScale).toBeCloseTo(wantScale, 2);
  expectHostFillsWindow(await hostFill(page), "after jump 1920×1080");

  const gpuAfterSettle = after.gpuResizeCount;
  const relayoutAfterSettle = after.relayoutCount;
  await page.evaluate(() => {
    for (let i = 0; i < 40; i++) {
      window.dispatchEvent(new Event("resize"));
      window.visualViewport?.dispatchEvent(new Event("resize"));
    }
  });
  await page.waitForTimeout(WINDOWS_RESIZE_IDLE_MS + 150);
  const afterStorm = await layoutProbe(page);
  expect(
    afterStorm.gpuResizeCount - gpuAfterSettle,
    "same-size resize events must not realloc the GPU backbuffer",
  ).toBe(0);
  expect(
    afterStorm.relayoutCount - relayoutAfterSettle,
    `same-size resize storm must not loop relayout (delta ${afterStorm.relayoutCount - relayoutAfterSettle})`,
  ).toBeLessThanOrEqual(2);
  expect(afterStorm.canvasCssW).toBe(after.screenW);
  expect(afterStorm.canvasCssH).toBe(after.screenH);
  expect(afterStorm.presentSnapshotForResize, "same-size echoes must not re-enter snapshot").toBe(
    false,
  );
  expect(afterStorm.canvasInDom, "live canvas must stay remounted after same-size echoes").toBe(
    true,
  );
  expectHostFillsWindow(await hostFill(page), "after same-size resize storm");

  // Immediate inspect (no poke): visualViewport noise must not detach again.
  const echoDom = await inspectPresent(page);
  expect(echoDom.probe?.presentSnapshotForResize).toBe(false);
  expect(echoDom.canvasInDom).toBe(true);
  expect(echoDom.snapshotInDom).toBe(false);

  await page.evaluate(() => window.__sprunkiJamTest?.placeStem?.("oren", "mid"));
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("mid") ?? null))
    .toEqual(["oren"]);

  const audioState = await page.evaluate(() => window.__sprunkiJamTest?.audioState() ?? null);
  expect(audioState).toBe("running");
  await expect(page.locator("#reset-btn")).toBeVisible();

  // Explicit test helper may still resize GPU (iPhone rotate path); pixel cap holds.
  await page.evaluate(() => window.__sprunkiJamTest?.forceStageSize?.(3840, 2160));
  const huge = await layoutProbe(page);
  expect(huge.screenW).toBe(3840);
  expect(huge.screenH).toBe(2160);
  expect(huge.backingPixels).toBeLessThanOrEqual(MAX_BACKING_PIXELS + 8_000);
  expect(huge.inRelayout).toBe(false);
});

/**
 * Brutal drag-resize: dozens of intermediate viewports for several seconds.
 * Windows: gpuResizeCount stays at boot, live canvas is torn out of the DOM,
 * a static snapshot is the only present surface, ticker pauses, letterbox
 * commits after a long idle. renderer.resize must not run.
 */
test("drag-resize storm does not realloc GPU or thrash canvas CSS", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  const before = await layoutProbe(page);
  expect(before.gpuFrozen).toBe(true);
  expect(before.presentFreeze).toBe(true);
  expect(before.presentMode).toBe("webgl");
  expect(before.canvasCssW).toBe(before.screenW);
  expect(before.canvasCssH).toBe(before.screenH);
  const bootMode = before.presentMode;

  const heapBefore = await page.evaluate(heapUsed);
  const bootGpu = before.gpuResizeCount;
  const bootRelayout = before.relayoutCount;
  const bootCssW = before.canvasCssW;
  const bootCssH = before.canvasCssH;
  expectHostFillsWindow(await hostFill(page), "storm boot");
  const steps = dragResizeSteps();
  expect(steps.length, "storm must include many intermediate sizes").toBeGreaterThan(40);

  // Atomic mid-storm check: resize in the same turn as the DOM inspect so the
  // 600ms idle cannot remount the canvas before we look.
  const midStorm = await inspectPresent(page, { pokeResize: true });
  expect(midStorm.probe, "page must stay responsive at snapshot enter").toBeTruthy();
  expect(midStorm.probe!.presentSnapshotForResize, "Windows resize must enter snapshot mode").toBe(
    true,
  );
  expect(midStorm.probe!.canvasInDom, "live canvas must leave the DOM mid-storm").toBe(false);
  expect(midStorm.canvasInDom, "live Pixi canvas must not be in the document mid-storm").toBe(false);
  expect(midStorm.canvasVisible, "live canvas must not be compositing mid-storm").toBe(false);
  expect(midStorm.snapshotInDom, "static snapshot must be in the DOM mid-storm").toBe(true);
  expect(midStorm.snapshotVisible, "static snapshot must be the visible present surface").toBe(true);
  expect(midStorm.snapshotHasSrc, "snapshot <img> must hold the last frame").toBe(true);
  expect(midStorm.probe!.gpuResizeCount).toBe(bootGpu);
  expect(midStorm.probe!.tickerPausedForResize).toBe(true);

  const stepMs: number[] = [];
  let sawTickerPaused = Boolean(midStorm.probe!.tickerPausedForResize);
  let sawPresentHidden = Boolean(midStorm.probe!.presentHiddenForResize);
  let sawSnapshot = true;
  let sawCanvasGone = true;
  const t0 = Date.now();
  for (const size of steps) {
    const s0 = Date.now();
    // Keep snapshot mode armed so Playwright's slow setViewportSize does not
    // remount a live canvas mid-step (that is the compositor death path).
    await page.evaluate(() => {
      window.dispatchEvent(new Event("resize"));
      window.visualViewport?.dispatchEvent(new Event("resize"));
    });
    await page.setViewportSize(size);
    const probe = await page.evaluate(() => window.__sprunkiJamTest?.layoutProbe?.() ?? null);
    expect(probe, "page must stay responsive mid-storm").toBeTruthy();
    expect(probe!.inRelayout).toBe(false);
    expect(probe!.presentMode).toBe(bootMode);
    expect(
      probe!.gpuResizeCount,
      `GPU realloc mid-storm at ${size.width}×${size.height} (boot ${bootGpu}, now ${probe!.gpuResizeCount})`,
    ).toBe(bootGpu);
    expect(
      probe!.canvasCssW,
      `locked CSS width must stay at boot GPU size mid-storm (boot ${bootCssW}, now ${probe!.canvasCssW} at ${size.width}×${size.height})`,
    ).toBe(bootCssW);
    expect(
      probe!.canvasCssH,
      `locked CSS height must stay at boot GPU size mid-storm (boot ${bootCssH}, now ${probe!.canvasCssH})`,
    ).toBe(bootCssH);
    if (probe!.presentSnapshotForResize) {
      expect(probe!.canvasInDom, "snapshot mode must keep the live canvas detached").toBe(false);
      sawSnapshot = true;
      sawCanvasGone = true;
    }
    if (probe!.tickerPausedForResize) sawTickerPaused = true;
    if (probe!.presentHiddenForResize) sawPresentHidden = true;
    stepMs.push(Date.now() - s0);
  }
  const elapsed = Date.now() - t0;
  expect(elapsed, `drag-resize storm hung (${elapsed}ms for ${steps.length} steps)`).toBeLessThan(60_000);

  const maxStep = Math.max(...stepMs);
  expect(maxStep, `a single viewport step hung the tab (${maxStep}ms)`).toBeLessThan(2_500);
  const meanStep = stepMs.reduce((a, b) => a + b, 0) / stepMs.length;
  expect(meanStep, `mean step work unbounded (${meanStep.toFixed(0)}ms)`).toBeLessThan(1_200);
  expect(sawTickerPaused, "ticker must pause during an active desktop resize storm").toBe(true);
  expect(sawPresentHidden, "Windows snapshot path must not use the Mac hide-present flag").toBe(
    false,
  );
  expect(sawSnapshot, "Windows resize storm must show a static snapshot").toBe(true);
  expect(sawCanvasGone, "Windows resize storm must detach the live canvas").toBe(true);

  // After idle, ticker resumes, live canvas remounts, snapshot drops, letterbox commits.
  await page.waitForTimeout(WINDOWS_RESIZE_IDLE_MS + 150);
  const afterIdle = await layoutProbe(page);
  const afterIdleDom = await presentDom(page);
  expect(afterIdle.tickerPausedForResize, "ticker must resume after resize idle").toBe(false);
  expect(afterIdle.presentHiddenForResize, "present must be visible after remount").toBe(false);
  expect(afterIdle.presentSnapshotForResize, "snapshot mode must end after idle").toBe(false);
  expect(afterIdle.canvasInDom, "live canvas must return after idle").toBe(true);
  expect(afterIdleDom.canvasInDom).toBe(true);
  expect(afterIdleDom.canvasVisible).toBe(true);
  expect(afterIdleDom.snapshotInDom, "snapshot must be dropped after idle").toBe(false);
  expect(afterIdle.canvasCssW).toBe(bootCssW);
  expect(afterIdle.canvasCssH).toBe(bootCssH);
  expect(afterIdle.presentMode).toBe(bootMode);
  expectHostFillsWindow(await hostFill(page), "storm after idle");
  const lastStep = steps[steps.length - 1]!;
  const wantScale = presentScaleFor(lastStep.width, lastStep.height, before.screenW, before.screenH);
  expect(afterIdle.presentScale).toBeCloseTo(wantScale, 2);
  expect(
    Math.abs(afterIdle.presentScale - before.presentScale),
    "present scale must update after idle once the storm settles",
  ).toBeGreaterThan(0.05);

  const after = afterIdle;
  expect(after.gpuResizeCount - bootGpu, "whole storm must not realloc the backbuffer").toBe(0);
  expect(
    after.relayoutCount - bootRelayout,
    `relayout must stay idle during present scale (delta ${after.relayoutCount - bootRelayout})`,
  ).toBeLessThanOrEqual(2);
  expect(after.screenW).toBe(before.screenW);
  expect(after.screenH).toBe(before.screenH);
  expect(after.resolution).toBe(before.resolution);
  expect(after.backingPixels).toBe(before.backingPixels);
  expect(after.inRelayout).toBe(false);

  const canvasBox = await page.locator("#stage-root canvas").boundingBox();
  expect(canvasBox, "letterboxed canvas still paints inside the stage").toBeTruthy();
  expect(canvasBox!.width).toBeGreaterThan(700);
  expect(canvasBox!.height).toBeGreaterThan(500);
  // Layout client size stayed fixed; bounding box may be scaled by transform.
  const client = await page.evaluate(() => {
    const c = document.querySelector("#stage-root canvas") as HTMLCanvasElement | null;
    return c ? { w: c.clientWidth, h: c.clientHeight } : null;
  });
  expect(client?.w).toBe(bootCssW);
  expect(client?.h).toBe(bootCssH);

  const heapAfter = await page.evaluate(heapUsed);
  if (heapBefore != null && heapAfter != null && heapBefore > 0) {
    expect(
      heapAfter,
      `JS heap must not climb unboundedly (before ${heapBefore}, after ${heapAfter})`,
    ).toBeLessThan(heapBefore * 2.5 + 40_000_000);
  }

  // Hits still map through transform scale: Secret pad + jam still work.
  await page.locator("#secret-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-secret", "run");
  await page.evaluate(() => {
    window.__sprunkiJamTest?.secretSpawn?.("mid", 12_000);
  });
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.secretState?.()?.targets ?? []))
    .toEqual(["mid"]);
  await clickSlotCss(page, "mid");
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.secretState?.()?.score ?? 0))
    .toBeGreaterThanOrEqual(1);

  await page.locator("#secret-exit-btn").tap();
  await expect(page.locator("body")).not.toHaveAttribute("data-secret");

  await page.evaluate(async () => {
    await window.__sprunkiJamTest?.gotoPhase?.(2);
  });
  await expect(page.locator("body")).toHaveAttribute("data-phase", "2", { timeout: 15_000 });
  const cov = await page.evaluate(() => window.__sprunkiJamTest?.bgCoverage?.() ?? null);
  expect(cov?.covers, "photo still cover-fits the frozen GPU stage after the storm").toBe(true);
  expect(cov?.phaseNumeral).toBe(false);
  expect(cov?.benchOverlay).toBe(false);

  await expect(page.locator("#reset-btn")).toBeVisible();
  const audioState = await page.evaluate(() => window.__sprunkiJamTest?.audioState() ?? null);
  expect(audioState).toBe("running");

  // eslint-disable-next-line no-console
  console.log(
    "drag-resize storm",
    JSON.stringify({
      steps: steps.length,
      elapsed,
      maxStep,
      meanStep: Math.round(meanStep),
      heapBefore,
      heapAfter,
      sawTickerPaused,
      sawPresentHidden,
      sawSnapshot,
      sawCanvasGone,
      presentMode: after.presentMode,
      boot: {
        screenW: before.screenW,
        screenH: before.screenH,
        canvasCssW: bootCssW,
        canvasCssH: bootCssH,
        gpu: bootGpu,
        presentScale: before.presentScale,
        resolution: before.resolution,
      },
      after: {
        screenW: after.screenW,
        screenH: after.screenH,
        canvasCssW: after.canvasCssW,
        canvasCssH: after.canvasCssH,
        gpu: after.gpuResizeCount,
        presentScale: after.presentScale,
        resolution: after.resolution,
      },
    }),
  );
});

/**
 * Confirmed smoking gun (in-jam freeze, not title):
 *   screenW/H 540×720, gpuResizeCount 0, gpuFrozen true,
 *   but canvasCssW/H 516×1100 (CSS flex, different aspect).
 * After TAP TO JAM the WebGL canvas is the hot compositor surface — CSS must
 * stay locked to the GPU size while the window grows tall/narrow.
 */
test("in-jam tall resize must not CSS-stretch canvas away from GPU", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  const boot = await layoutProbe(page);
  expect(boot.gpuFrozen).toBe(true);
  expect(boot.presentFreeze).toBe(true);
  expect(boot.presentMode).toBe("webgl");
  expect(boot.gpuResizeCount).toBe(0);
  expect(boot.canvasCssW).toBe(boot.screenW);
  expect(boot.canvasCssH).toBe(boot.screenH);

  // Mid-storm: GPU stays at boot; live canvas must leave the compositor.
  await page.setViewportSize({ width: 516, height: 1100 });
  const mid = await inspectPresent(page, { pokeResize: true });
  expect(mid.probe!.presentSnapshotForResize, "tall resize must detach the live canvas").toBe(true);
  expect(mid.probe!.canvasInDom).toBe(false);
  expect(mid.probe!.gpuResizeCount).toBe(boot.gpuResizeCount);
  expect(mid.probe!.screenW).toBe(boot.screenW);
  expect(mid.probe!.screenH).toBe(boot.screenH);
  expect(mid.probe!.canvasCssW).toBe(boot.screenW);
  expect(mid.probe!.canvasCssH).toBe(boot.screenH);

  // After idle Windows may shrink the frozen buffer so presentScale is not 0.35.
  await page.waitForTimeout(WINDOWS_RESIZE_IDLE_MS + 150);
  const want = pickFrozenDesktopPresent(516, 1100, "windows", 1);
  const tall = await layoutProbe(page);
  expect(tall.presentSnapshotForResize, "idle must remount once the GPU fits the host").toBe(false);
  expect(tall.canvasInDom).toBe(true);
  expect(tall.screenW).toBe(want.w);
  expect(tall.screenH).toBe(want.h);
  expect(tall.canvasCssW, "canvasCssW must equal GPU screenW (flex used to report 516 vs 540)").toBe(
    tall.screenW,
  );
  expect(tall.canvasCssH, "canvasCssH must equal GPU screenH (flex used to report 1100 vs 720)").toBe(
    tall.screenH,
  );
  expect(tall.canvasCssW).not.toBe(516);
  expect(tall.canvasCssH).not.toBe(1100);
  expect(tall.presentScale).toBeGreaterThanOrEqual(PRESENT_LIVE_MIN_SCALE);
  expect(tall.backingPixels).toBeLessThan(WINDOWS_LEGACY_MAX_BACKING_PIXELS);

  // Letterbox transform shrinks uniformly; bounding box ≠ CSS layout size.
  const box = await page.locator("#stage-root canvas").boundingBox();
  expect(box).toBeTruthy();
  expect(box!.width).toBeLessThanOrEqual(516 + 2);
  expect(box!.height).toBeLessThanOrEqual(1100 + 2);
  // Layout client size stays at GPU — transform does the visual shrink.
  const client = await page.evaluate(() => {
    const c = document.querySelector("#stage-root canvas") as HTMLCanvasElement | null;
    const root = document.documentElement;
    return {
      w: c?.clientWidth ?? 0,
      h: c?.clientHeight ?? 0,
      varW: root.style.getPropertyValue("--gpu-css-w").trim(),
      varH: root.style.getPropertyValue("--gpu-css-h").trim(),
      computedW: c ? getComputedStyle(c).width : "",
      computedH: c ? getComputedStyle(c).height : "",
    };
  });
  expect(client.w).toBe(tall.screenW);
  expect(client.h).toBe(tall.screenH);
  expect(client.varW).toBe(`${tall.screenW}px`);
  expect(client.varH).toBe(`${tall.screenH}px`);
  expect(client.computedW).toBe(`${tall.screenW}px`);
  expect(client.computedH).toBe(`${tall.screenH}px`);

  await page.evaluate(() => window.__sprunkiJamTest?.placeStem?.("oren", "mid"));
  await expect
    .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("mid") ?? null))
    .toEqual(["oren"]);
});

/**
 * After remount, visualViewport + window.resize echoes at the same host size
 * must not tear the live canvas out again (the sawtooth CPU / soft-frame cycle).
 */
test("visualViewport flicker after remount does not re-snapshot", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  const boot = await layoutProbe(page);
  expect(boot.gpuFrozen).toBe(true);
  expect(boot.canvasCssW).toBe(boot.screenW);
  expect(boot.canvasCssH).toBe(boot.screenH);

  const cssBoot = await page.evaluate(() => {
    const c = document.querySelector("#stage-root canvas") as HTMLCanvasElement | null;
    const root = document.documentElement;
    return {
      varW: root.style.getPropertyValue("--gpu-css-w").trim() ||
        getComputedStyle(root).getPropertyValue("--gpu-css-w").trim(),
      varH: root.style.getPropertyValue("--gpu-css-h").trim() ||
        getComputedStyle(root).getPropertyValue("--gpu-css-h").trim(),
      computedW: c ? getComputedStyle(c).width : "",
      computedH: c ? getComputedStyle(c).height : "",
      inlineW: c?.style.width ?? "",
      inlineH: c?.style.height ?? "",
    };
  });
  expect(cssBoot.computedW, "frozen canvas must not be width:100% of the flex host").not.toBe("100%");
  expect(cssBoot.computedH).not.toBe("100%");
  expect(cssBoot.computedW).toBe(`${boot.screenW}px`);
  expect(cssBoot.computedH).toBe(`${boot.screenH}px`);
  expect(cssBoot.inlineW).toBe(`${boot.screenW}px`);
  expect(cssBoot.inlineH).toBe(`${boot.screenH}px`);
  expect(cssBoot.varW).toBe(`${boot.screenW}px`);
  expect(cssBoot.varH).toBe(`${boot.screenH}px`);

  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect
    .poll(
      async () => {
        const p = await page.evaluate(() => window.__sprunkiJamTest?.layoutProbe?.() ?? null);
        return Boolean(
          p &&
            !p.tickerPausedForResize &&
            !p.presentSnapshotForResize &&
            p.canvasInDom &&
            p.presentScale > 1.15,
        );
      },
      { timeout: 8_000, message: "maximize must remount the live canvas after idle" },
    )
    .toBe(true);

  const settled = await layoutProbe(page);
  expect(settled.canvasInDom).toBe(true);
  expect(settled.presentSnapshotForResize).toBe(false);
  expect(settled.canvasCssW).toBe(boot.screenW);
  expect(settled.canvasCssH).toBe(boot.screenH);
  expect(settled.screenW).toBe(boot.screenW);
  expect(settled.screenH).toBe(boot.screenH);

  await page.evaluate(() => {
    for (let i = 0; i < 16; i++) {
      window.visualViewport?.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
    }
  });

  const immediate = await inspectPresent(page);
  expect(immediate.probe?.presentSnapshotForResize, "vv echo must not re-enter snapshot").toBe(
    false,
  );
  expect(immediate.canvasInDom, "live canvas must stay in the DOM after vv echo").toBe(true);
  expect(immediate.snapshotInDom).toBe(false);
  expect(immediate.probe?.canvasCssW).toBe(settled.canvasCssW);
  expect(immediate.probe?.canvasCssH).toBe(settled.canvasCssH);
  expect(immediate.probe?.gpuResizeCount).toBe(settled.gpuResizeCount);

  await page.waitForTimeout(WINDOWS_RESIZE_IDLE_MS + 150);
  const after = await layoutProbe(page);
  expect(after.presentSnapshotForResize).toBe(false);
  expect(after.canvasInDom).toBe(true);
  expect(after.canvasCssW).toBe(settled.canvasCssW);
  expect(after.canvasCssH).toBe(settled.canvasCssH);
  expect(after.gpuResizeCount).toBe(settled.gpuResizeCount);
  expect(after.presentScale).toBeCloseTo(settled.presentScale, 2);
});

/**
 * Windows 175% display scale (DPR ≈ 1.75): desktop budget + snapshot teardown.
 * Boot backing tracks CSS × capped DPR inside the ~2.16MP ceiling. Mid-storm
 * gpuResizeCount stays at boot; idle settle may refit after maximize / aspect flip.
 */
test("Windows high-DPR (1.75) resize storm stays frozen with a snapshot", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({
    viewport: { width: 900, height: 600 },
    deviceScaleFactor: 1.75,
    isMobile: false,
    hasTouch: true,
    userAgent: WINDOWS_CHROME_UA,
  });
  const page = await context.newPage();
  try {
    await page.goto("/", { waitUntil: "networkidle" });
    await expect
      .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.detectedPlatform?.() ?? null))
      .toBe("windows");
    expect(await page.evaluate(() => window.devicePixelRatio)).toBeCloseTo(1.75, 2);

    await page.locator("#jam-btn").tap();
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

    const boot = await layoutProbe(page);
    expect(boot.gpuFrozen).toBe(true);
    expect(boot.presentFreeze).toBe(true);
    expect(boot.presentMode).toBe("webgl");
    expect(boot.devicePixelRatio).toBeCloseTo(1.75, 2);
    expect(boot.antialias).toBe(false);
    expect(boot.canvasCssW).toBe(boot.screenW);
    expect(boot.canvasCssH).toBe(boot.screenH);
    expect(boot.resolution, "175% GPU must stay at the Windows DPR cap, not 1.75×").toBeCloseTo(
      WINDOWS_FROZEN_DPR_CAP,
      2,
    );
    expect(boot.backingPixels).toBeGreaterThan(400_000);
    expect(boot.backingPixels).toBeLessThanOrEqual(WINDOWS_MAX_BACKING_PIXELS + 8_000);
    expect(boot.backingPixels).toBeLessThan(WINDOWS_LEGACY_MAX_BACKING_PIXELS);

    const buffer = await page.evaluate(() => {
      const c = document.querySelector("#stage-root canvas") as HTMLCanvasElement | null;
      if (!c) return null;
      return {
        cssW: c.clientWidth,
        cssH: c.clientHeight,
        bufW: c.width,
        bufH: c.height,
        varW: document.documentElement.style.getPropertyValue("--gpu-css-w").trim(),
        varH: document.documentElement.style.getPropertyValue("--gpu-css-h").trim(),
      };
    });
    expect(buffer).toBeTruthy();
    expect(buffer!.cssW).toBe(boot.screenW);
    expect(buffer!.cssH).toBe(boot.screenH);
    expect(buffer!.varW).toBe(`${boot.screenW}px`);
    expect(buffer!.varH).toBe(`${boot.screenH}px`);
    expect(buffer!.bufW).toBeCloseTo(boot.screenW * boot.resolution, 0);
    expect(buffer!.bufH).toBeCloseTo(boot.screenH * boot.resolution, 0);

    const bootGpu = boot.gpuResizeCount;
    const bootCssW = boot.canvasCssW;
    const bootCssH = boot.canvasCssH;
    const bootMode = boot.presentMode;
    const steps = dragResizeSteps();
    const midStorm = await inspectPresent(page, { pokeResize: true });
    expect(midStorm.probe!.presentSnapshotForResize, "175% storm must enter snapshot mode").toBe(
      true,
    );
    expect(midStorm.probe!.canvasInDom, "175% storm must detach the live canvas").toBe(false);
    expect(midStorm.canvasInDom).toBe(false);
    expect(midStorm.canvasVisible).toBe(false);
    expect(midStorm.snapshotInDom).toBe(true);
    expect(midStorm.snapshotVisible).toBe(true);
    expect(midStorm.probe!.gpuResizeCount).toBe(bootGpu);
    let sawHidden = Boolean(midStorm.probe!.presentHiddenForResize);
    let sawPaused = Boolean(midStorm.probe!.tickerPausedForResize);
    let sawSnapshot = true;
    let sawCanvasGone = true;
    for (const size of steps) {
      await page.evaluate(() => {
        window.dispatchEvent(new Event("resize"));
        window.visualViewport?.dispatchEvent(new Event("resize"));
      });
      await page.setViewportSize(size);
      const probe = await page.evaluate(() => window.__sprunkiJamTest?.layoutProbe?.() ?? null);
      expect(probe).toBeTruthy();
      expect(probe!.presentMode).toBe(bootMode);
      expect(probe!.gpuResizeCount).toBe(bootGpu);
      expect(probe!.canvasCssW).toBe(bootCssW);
      expect(probe!.canvasCssH).toBe(bootCssH);
      expect(probe!.backingPixels).toBe(boot.backingPixels);
      if (probe!.presentSnapshotForResize) {
        expect(probe!.canvasInDom).toBe(false);
        sawSnapshot = true;
        sawCanvasGone = true;
      }
      if (probe!.presentHiddenForResize) sawHidden = true;
      if (probe!.tickerPausedForResize) sawPaused = true;
    }
    expect(sawPaused, "high-DPR storm must pause the ticker").toBe(true);
    expect(sawHidden, "Windows snapshot path must not use the Mac hide-present flag").toBe(false);
    expect(sawSnapshot).toBe(true);
    expect(sawCanvasGone).toBe(true);

    await page.waitForTimeout(WINDOWS_RESIZE_IDLE_MS + 150);
    const after = await layoutProbe(page);
    const afterDom = await presentDom(page);
    expect(after.gpuResizeCount).toBe(bootGpu);
    expect(after.tickerPausedForResize).toBe(false);
    expect(after.presentHiddenForResize).toBe(false);
    expect(after.presentSnapshotForResize).toBe(false);
    expect(after.canvasInDom).toBe(true);
    expect(afterDom.canvasInDom).toBe(true);
    expect(afterDom.snapshotInDom).toBe(false);
    expect(after.presentMode).toBe(bootMode);
    expect(after.canvasCssW).toBe(bootCssW);
    expect(after.canvasCssH).toBe(bootCssH);
    expect(after.backingPixels).toBe(boot.backingPixels);
    expect(after.screenW).toBe(boot.screenW);
    expect(after.screenH).toBe(boot.screenH);

    await page.evaluate(() => window.__sprunkiJamTest?.placeStem?.("oren", "mid"));
    await expect
      .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.slotStems?.("mid") ?? null))
      .toEqual(["oren"]);

    // eslint-disable-next-line no-console
    console.log(
      "windows-high-dpr-1.75-snapshot",
      JSON.stringify({
        screenW: boot.screenW,
        screenH: boot.screenH,
        resolution: boot.resolution,
        backingPixels: boot.backingPixels,
        canvasCssW: boot.canvasCssW,
        canvasCssH: boot.canvasCssH,
        bufW: buffer!.bufW,
        bufH: buffer!.bufH,
        gpuResizeCount: after.gpuResizeCount,
        presentScale: after.presentScale,
        presentMode: after.presentMode,
      }),
    );
  } finally {
    await context.close();
  }
});

/**
 * 200% DPI: a 1440p-class CSS window must boot inside the ~2.16MP Windows
 * desktop ceiling — not the old 3MP hang, and not a 200px postage stamp.
 */
test("Windows 200% DPI boots under the desktop Windows budget", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: true,
    userAgent: WINDOWS_CHROME_UA,
  });
  const page = await context.newPage();
  try {
    await page.goto("/", { waitUntil: "networkidle" });
    await expect
      .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.detectedPlatform?.() ?? null))
      .toBe("windows");
    expect(await page.evaluate(() => window.devicePixelRatio)).toBeCloseTo(2, 2);

    await page.locator("#jam-btn").tap();
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

    const boot = await layoutProbe(page);
    const want = pickFrozenDesktopPresent(1280, 720, "windows", 2);
    expect(boot.gpuFrozen).toBe(true);
    expect(boot.presentFreeze).toBe(true);
    expect(boot.screenW).toBe(want.w);
    expect(boot.screenH).toBe(want.h);
    expect(boot.canvasCssW).toBe(want.w);
    expect(boot.canvasCssH).toBe(want.h);
    expect(boot.resolution).toBeCloseTo(want.resolution, 2);
    expect(boot.backingPixels).toBeLessThanOrEqual(WINDOWS_MAX_BACKING_PIXELS + 8_000);
    expect(boot.resolution).toBeLessThanOrEqual(WINDOWS_FROZEN_DPR_CAP + 0.02);
    expect(boot.backingPixels).toBeLessThan(WINDOWS_LEGACY_MAX_BACKING_PIXELS);
    expect(boot.backingPixels).toBeGreaterThan(400_000);

    const buffer = await page.evaluate(() => {
      const c = document.querySelector("#stage-root canvas") as HTMLCanvasElement | null;
      return c ? { cssW: c.clientWidth, cssH: c.clientHeight, bufW: c.width, bufH: c.height } : null;
    });
    expect(buffer).toBeTruthy();
    expect(buffer!.cssW).toBe(want.w);
    expect(buffer!.cssH).toBe(want.h);
    expect(buffer!.bufW).toBeCloseTo(want.w * want.resolution, 0);
    expect(buffer!.bufH).toBeCloseTo(want.h * want.resolution, 0);
    expect(buffer!.bufW, "must not be a ~200px-class bitmap stretched huge").toBeGreaterThan(900);

    await page.setViewportSize({ width: 1600, height: 900 });
    const mid = await inspectPresent(page, { pokeResize: true });
    expect(mid.probe!.presentSnapshotForResize).toBe(true);
    expect(mid.canvasInDom).toBe(false);
    expect(mid.probe!.gpuResizeCount).toBe(boot.gpuResizeCount);
    expect(mid.probe!.canvasCssW).toBe(want.w);
    expect(mid.probe!.canvasCssH).toBe(want.h);

    await page.waitForTimeout(WINDOWS_RESIZE_IDLE_MS + 150);
    const after = await layoutProbe(page);
    expect(after.presentSnapshotForResize).toBe(false);
    expect(after.canvasInDom).toBe(true);
    expect(after.canvasCssW).toBe(want.w);
    expect(after.canvasCssH).toBe(want.h);
    expect(after.gpuResizeCount).toBe(boot.gpuResizeCount);
    expect(after.backingPixels).toBe(boot.backingPixels);
  } finally {
    await context.close();
  }
});

/**
 * Confirmed hang: GPU 1259×900, backing 3MP, inner window 436×560,
 * presentScale ≈ 0.35, live canvas still in the compositor. A Windows-sized
 * small host must boot in that pane's ballpark, far under the old 3MP ceiling.
 */
test("small Windows host boots far below the old 3MP letterbox ceiling", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 436, height: 560 },
    deviceScaleFactor: 1.75,
    isMobile: false,
    hasTouch: true,
    userAgent: WINDOWS_CHROME_UA,
  });
  const page = await context.newPage();
  try {
    await page.goto("/", { waitUntil: "networkidle" });
    await expect
      .poll(async () => page.evaluate(() => window.__sprunkiJamTest?.detectedPlatform?.() ?? null))
      .toBe("windows");
    expect(await page.evaluate(() => window.devicePixelRatio)).toBeCloseTo(1.75, 2);

    await page.locator("#jam-btn").tap();
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

    const want = pickFrozenDesktopPresent(436, 560, "windows", 1.75);
    const boot = await layoutProbe(page);
    expect(boot.gpuFrozen).toBe(true);
    expect(boot.presentFreeze).toBe(true);
    expect(boot.screenW).toBe(want.w);
    expect(boot.screenH).toBe(want.h);
    expect(boot.canvasCssW).toBe(want.w);
    expect(boot.canvasCssH).toBe(want.h);
    expect(boot.resolution).toBeCloseTo(want.resolution, 2);
    expect(boot.backingPixels).toBeLessThanOrEqual(WINDOWS_MAX_BACKING_PIXELS + 8_000);
    expect(boot.backingPixels, "must not boot at the old 3MP Iris Xe ceiling").toBeLessThan(
      WINDOWS_LEGACY_MAX_BACKING_PIXELS * 0.4,
    );
    expect(boot.presentScale, "GPU CSS box must match the small host, not letterbox at 0.35").toBeGreaterThan(
      0.9,
    );
    expect(boot.hostCssW).toBeGreaterThan(300);
    expect(boot.hostCssH).toBeGreaterThan(300);
    expect(Math.abs((boot.hostCssW ?? 0) - 436)).toBeLessThanOrEqual(4);
    expect(Math.abs((boot.hostCssH ?? 0) - 560)).toBeLessThanOrEqual(4);

    const mid = await inspectPresent(page, { pokeResize: true });
    expect(mid.probe!.presentSnapshotForResize, "resize must still detach the live canvas").toBe(
      true,
    );
    expect(mid.canvasInDom, "live canvas must leave the compositor mid-resize").toBe(false);
    expect(mid.snapshotInDom).toBe(true);
    expect(mid.probe!.gpuResizeCount).toBe(boot.gpuResizeCount);
  } finally {
    await context.close();
  }
});

test("Reset navigates immediately without a whoosh delay timer", async ({ page }) => {
  // Source guard: the old survival bug was `setTimeout(..., 380)` then reload.
  const jamSrc = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/game/jam.ts", import.meta.url), "utf8"),
  );
  expect(jamSrc).toContain("navigateHomeNow");
  expect(jamSrc).toContain("WebGLRenderer");
  expect(jamSrc).not.toContain("WebGPURenderer");
  expect(jamSrc).not.toContain("CanvasRenderer");
  expect(jamSrc).toContain("shouldSnapshotPresentDuringResize");
  expect(jamSrc).toContain("enterPresentSnapshot");
  expect(jamSrc).toContain("detachLiveCanvas");
  expect(jamSrc).toContain("presentSnapshotUrl");
  expect(jamSrc).not.toContain("pinWebGpuSwapchain");
  expect(jamSrc).toContain("adoptSnapshotUrl");
  expect(jamSrc).toContain("isMaterialPresentHostChange");
  expect(jamSrc).toContain("remountQuietUntil");
  expect(jamSrc).toContain("pickFrozenDesktopPresent");
  expect(jamSrc).toContain("desktopHostCssBox");
  expect(jamSrc).toContain("fitFrozenGpuToHostIfUndersized");
  expect(jamSrc).toContain("finishDesktopPresentResize");
  expect(jamSrc).toContain("presentScaleIsUndersized");
  expect(jamSrc).toContain('powerPreference: "low-power"');
  expect(jamSrc).toContain("stage-snapshot");
  const viewportSrc = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/input/viewport.ts", import.meta.url), "utf8"),
  );
  expect(viewportSrc).toContain("const pinVv = shouldPinVisualViewport()");
  expect(viewportSrc).toContain("tightDesktopCssEdge");
  expect(viewportSrc).toContain("desktopHostCssBox");
  expect(viewportSrc).toMatch(/if \(pinVv\) \{\s*window\.visualViewport\?\.addEventListener\("resize"/);
  expect(jamSrc).toContain("preference: \"webgl\"");
  expect(jamSrc).not.toMatch(/decoding\s*=\s*["']sync["']/);
  const enterSnap = jamSrc.match(
    /private enterPresentSnapshot\(\)[\s\S]*?private detachLiveCanvas/,
  )?.[0];
  expect(enterSnap, "enterPresentSnapshot must exist").toBeTruthy();
  expect(enterSnap).toContain("detachLiveCanvas");
  expect(enterSnap).not.toContain("app.render()");
  expect(enterSnap).not.toContain("toDataURL");
  const cssSrc = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/style.css", import.meta.url), "utf8"),
  );
  expect(cssSrc).toMatch(/--gpu-css-w:\s*960px/);
  expect(cssSrc).toMatch(/--gpu-css-h:\s*540px/);
  expect(cssSrc).toMatch(/#stage-present\s*\{[^}]*width:\s*var\(--gpu-css-w\)/s);
  expect(jamSrc).toContain("pauseFx");
  expect(jamSrc).toContain("setFxBudget");
  const fxSrc = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/view/phaseTransition.ts", import.meta.url), "utf8"),
  );
  const rippleSrc = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/view/phaseRipple.ts", import.meta.url), "utf8"),
  );
  expect(fxSrc).toContain("PhaseRippleFilter");
  expect(fxSrc).toContain("drawGlow");
  expect(fxSrc).toContain("makeSoftGlowSprite");
  expect(fxSrc).not.toMatch(/for \(let i = rings; i >= 1; i--\)/);
  expect(fxSrc).not.toMatch(/vignette\.rect\(0, 0, w, h\)/);
  expect(rippleSrc).toContain("GlProgram");
  expect(rippleSrc).not.toContain("GpuProgram");
  expect(rippleSrc).not.toContain("gpuProgram");
  expect(rippleSrc).toContain("glProgram");
  expect(rippleSrc).toContain("finalColor");
  expect(rippleSrc).toMatch(/texture\(/);
  expect(jamSrc).not.toMatch(/makeSoftShadowSprite\(0, 0, 8, 3\)/);
  expect(jamSrc).toMatch(/preference:\s*"webgl"/);
  const falloffSrc = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/view/softFalloff.ts", import.meta.url), "utf8"),
  );
  expect(falloffSrc).toContain('rgba(255,255,255,1)');
  expect(falloffSrc).toContain("softEyeTexture");
  expect(falloffSrc).not.toMatch(/\[0, "rgba\(0,0,0,1\)"\]/);
  const dustSrc = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/view/ambientDust.ts", import.meta.url), "utf8"),
  );
  expect(dustSrc).toContain("this.layer?.update()");
  expect(dustSrc).toContain("addParticle");
  expect(fxSrc).toContain("makeSoftEyeSprite");
  expect(fxSrc).toContain("softEyeTexture");
  expect(fxSrc).not.toMatch(/this\.fx\.circle\(w \* 0\.38, h \* 0\.42, 14\)/);
  const charSrc = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/view/characters.ts", import.meta.url), "utf8"),
  );
  expect(charSrc).toContain("STEM_COLOR");
  expect(charSrc).toContain("pool.tint = tint");
  expect(jamSrc).not.toMatch(/setTimeout\([\s\S]{0,200}location\.reload[\s\S]{0,80},\s*380\s*\)/);
  expect(jamSrc).not.toMatch(/setTimeout\(\s*\(\)\s*=>\s*\{[\s\S]*?reload\(\)[\s\S]*?\},\s*380\s*\)/);

  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  // Capture-phase / immediate href — must leave the jam without waiting on whoosh.
  const committed = page.waitForEvent("framenavigated", { timeout: 8_000 });
  await page.locator("#reset-btn").click();
  await committed;
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator("#jam-btn")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("body")).not.toHaveAttribute("data-ready", "1");
});

test("Reset mid-snapshot navigates immediately without remounting the canvas", async ({
  page,
}) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  await page.setViewportSize({ width: 1600, height: 900 });
  const mid = await inspectPresent(page, { pokeResize: true });
  expect(mid.probe?.presentSnapshotForResize, "resize must enter snapshot mode before Reset").toBe(
    true,
  );
  expect(mid.snapshotInDom).toBe(true);
  expect(mid.canvasInDom).toBe(false);

  const committed = page.waitForEvent("framenavigated", { timeout: 8_000 });
  await page.locator("#reset-btn").click();
  await committed;
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator("#jam-btn")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("body")).not.toHaveAttribute("data-ready", "1");
});

test("desktop title + stage follow the window box across a tall↔wide resize", async ({ page }) => {
  const requested: string[] = [];
  page.on("request", (req) => {
    const u = req.url();
    if (u.includes("/art/intro-") || u.includes("/art/bg-phase")) requested.push(u);
  });

  await page.setViewportSize({ width: 1100, height: 620 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const wide = await page.evaluate(() => window.__sprunkiJamTest?.titleArt?.() ?? null);
  expect(wide?.orient).toBe("landscape");
  expect(wide?.ringFit).toBe("cover");
  expect(requested.some((u) => u.includes("intro-ring-landscape-title.jpeg"))).toBe(true);

  await page.setViewportSize({ width: 520, height: 900 });
  await page.waitForTimeout(80);
  const tall = await page.evaluate(() => window.__sprunkiJamTest?.titleArt?.() ?? null);
  expect(tall?.orient).toBe("portrait");
  expect(tall?.innerH ?? 0).toBeGreaterThan(tall?.innerW ?? 0);
  expect(requested.some((u) => u.includes("intro-ring-portrait-title.jpeg"))).toBe(true);

  const ringBox = await page.locator("#hero-ring").boundingBox();
  const gateBox = await page.locator("#gate").boundingBox();
  expect(ringBox && gateBox).toBeTruthy();
  expect(ringBox!.width).toBeGreaterThanOrEqual(gateBox!.width - 2);
  expect(ringBox!.height).toBeGreaterThanOrEqual(gateBox!.height - 2);

  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
  const p1 = await page.evaluate(() => window.__sprunkiJamTest?.bgCoverage?.() ?? null);
  expect(p1?.covers).toBe(true);
  expect(p1?.orient).toBe("portrait");
  expect(p1?.src).toContain("bg-phase1-portrait.jpeg");
  expect(p1?.pivotX ?? 0).toBeGreaterThanOrEqual(0.65);
  await expect(page.locator("#stage-fill")).toBeVisible();
  const fillFit = await page.locator("#stage-fill").evaluate((el) => getComputedStyle(el).objectFit);
  expect(fillFit).toBe("cover");

  await page.evaluate(async () => {
    await window.__sprunkiJamTest?.gotoPhase?.(2);
  });
  await expect(page.locator("body")).toHaveAttribute("data-phase", "2", { timeout: 15_000 });
  const p2 = await page.evaluate(() => window.__sprunkiJamTest?.bgCoverage?.() ?? null);
  expect(p2?.covers).toBe(true);
  expect(p2?.set).toBe(2);
  expect(p2?.orient).toBe("portrait");
});
