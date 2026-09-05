import { expect, test } from "@playwright/test";
import {
  adoptSnapshotUrl,
  captureCanvasDataUrl,
  isObjectSnapshotUrl,
  revokeSnapshotUrl,
  SNAPSHOT_JPEG_QUALITY,
} from "../src/view/presentGuard";
import { WINDOWS_LEGACY_MAX_BACKING_PIXELS, WINDOWS_MAX_BACKING_PIXELS } from "../src/view/gpuBudget";

test("snapshot URLs are replaced, never accumulated", () => {
  const first = URL.createObjectURL(new Blob(["a"], { type: "image/jpeg" }));
  const second = URL.createObjectURL(new Blob(["b"], { type: "image/jpeg" }));
  expect(isObjectSnapshotUrl(first)).toBe(true);
  expect(isObjectSnapshotUrl("data:image/jpeg;base64,xx")).toBe(false);
  const held = adoptSnapshotUrl(first, second);
  expect(held).toBe(second);
  revokeSnapshotUrl(second);
  expect(adoptSnapshotUrl(null, null)).toBeNull();
  expect(SNAPSHOT_JPEG_QUALITY).toBeCloseTo(0.72, 5);
});

test("jam present path keeps detach-first snapshot rails and idle JPEG cache", async () => {
  const jamSrc = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/game/jam.ts", import.meta.url), "utf8"),
  );
  const guardSrc = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/view/presentGuard.ts", import.meta.url), "utf8"),
  );
  expect(jamSrc).toContain("adoptSnapshotUrl");
  expect(jamSrc).toContain("captureCanvasBlobUrl");
  expect(jamSrc).toContain("textureGCActive: true");
  expect(jamSrc).toContain("renderableGCActive: true");
  expect(jamSrc).toContain("preference: \"webgl\"");
  expect(jamSrc).toContain("powerPreference: \"low-power\"");
  expect(jamSrc).toContain("fitFrozenGpuToHostIfUndersized");
  expect(jamSrc).not.toContain("pinWebGpu");
  expect(jamSrc).not.toContain("WebGPU");
  expect(jamSrc).not.toContain("installStickySwapchainPin");
  expect(jamSrc).toContain("if (!this.presentSnapshotUrl) this.scheduleSnapshotCacheRefresh()");
  expect(guardSrc).toContain("revokeObjectURL");
  expect(guardSrc).toContain("toDataURL");
  expect(guardSrc).not.toContain("GPUCanvasContext");
  expect(guardSrc).not.toContain("RENDER_ATTACHMENT");
  const enterSnap = jamSrc.match(
    /private enterPresentSnapshot\(\)[\s\S]*?private detachLiveCanvas/,
  )?.[0];
  expect(enterSnap, "enterPresentSnapshot must exist").toBeTruthy();
  expect(enterSnap).toContain("detachLiveCanvas");
  expect(enterSnap).not.toContain("app.render()");
});

test("idle jam does not recapture or realloc the frozen WebGL buffer", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.locator("#jam-btn").tap();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });

  const boot = await page.evaluate(() => window.__sprunkiJamTest?.layoutProbe?.() ?? null);
  expect(boot, "layoutProbe hook must exist").toBeTruthy();
  expect(boot!.gpuFrozen).toBe(true);
  expect(boot!.presentMode).toBe("webgl");
  expect(boot!.webglContext).toBe(true);
  expect(boot!.backingPixels).toBeLessThanOrEqual(WINDOWS_MAX_BACKING_PIXELS + 8_000);
  const bootSnap = boot!.snapshotUrlCount;
  const bootGpu = boot!.gpuResizeCount;
  const bootFilter = boot!.filterResizeCount;
  const bootRes = boot!.resolution;
  const bootBack = boot!.backingPixels;

  await page.waitForTimeout(2800);

  const idle = await page.evaluate(() => window.__sprunkiJamTest?.layoutProbe?.() ?? null);
  expect(idle).toBeTruthy();
  expect(idle!.gpuResizeCount, "idle must not renderer.resize").toBe(bootGpu);
  expect(
    idle!.snapshotUrlCount - bootSnap,
    "idle must not keep creating snapshot JPEGs",
  ).toBeLessThanOrEqual(1);
  expect(idle!.snapshotUrlCount).toBeLessThanOrEqual(2);
  expect(idle!.filterResizeCount, "idle must not refit overlay filter RTs").toBe(bootFilter);
  expect(idle!.resolution, "idle must keep #43 sharpness").toBe(bootRes);
  expect(idle!.backingPixels).toBe(bootBack);
  expect(idle!.canvasCssW).toBe(idle!.screenW);
  expect(idle!.canvasCssH).toBe(idle!.screenH);
  expect(idle!.presentSnapshotForResize).toBe(false);
  expect(idle!.canvasInDom).toBe(true);

  await page.setViewportSize({ width: 1600, height: 900 });
  await page.evaluate(() => window.__sprunkiJamTest?.forcePresentSnapshot?.());
  const mid = await page.evaluate(() => window.__sprunkiJamTest?.layoutProbe?.() ?? null);
  expect(mid!.presentSnapshotForResize).toBe(true);
  expect(mid!.canvasInDom).toBe(false);
  expect(mid!.gpuResizeCount).toBe(bootGpu);

  await page.waitForTimeout(800);
  const after = await page.evaluate(() => window.__sprunkiJamTest?.layoutProbe?.() ?? null);
  expect(after!.presentSnapshotForResize).toBe(false);
  expect(after!.canvasInDom).toBe(true);
  expect(after!.gpuResizeCount).toBe(bootGpu);
  expect(after!.snapshotUrlCount).toBeLessThanOrEqual(idle!.snapshotUrlCount + 1);
  expect(after!.resolution).toBe(bootRes);
  expect(after!.backingPixels).toBe(bootBack);
});

test("Windows high-DPR idle stays under the desktop Windows budget", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  try {
    await page.goto("/", { waitUntil: "networkidle" });
    await page.locator("#jam-btn").tap();
    await expect(page.locator("body")).toHaveAttribute("data-ready", "1", { timeout: 30_000 });
    const boot = await page.evaluate(() => window.__sprunkiJamTest?.layoutProbe?.() ?? null);
    expect(boot).toBeTruthy();
    expect(boot!.gpuFrozen).toBe(true);
    expect(boot!.presentMode).toBe("webgl");
    expect(boot!.resolution).toBeLessThanOrEqual(2);
    expect(boot!.backingPixels).toBeGreaterThan(400_000);
    expect(boot!.backingPixels).toBeLessThanOrEqual(WINDOWS_MAX_BACKING_PIXELS + 8_000);
    expect(boot!.backingPixels).toBeLessThan(WINDOWS_LEGACY_MAX_BACKING_PIXELS);
    await page.waitForTimeout(2000);
    const idle = await page.evaluate(() => window.__sprunkiJamTest?.layoutProbe?.() ?? null);
    expect(idle!.gpuResizeCount).toBe(boot!.gpuResizeCount);
    expect(idle!.snapshotUrlCount - boot!.snapshotUrlCount).toBeLessThanOrEqual(1);
    expect(idle!.resolution).toBe(boot!.resolution);
    expect(idle!.backingPixels).toBe(boot!.backingPixels);
  } finally {
    await context.close();
  }
});

test("captureCanvasDataUrl is JPEG-only and does not throw on a 2D canvas", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const url = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 16;
    c.height = 16;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#f80";
    ctx.fillRect(0, 0, 16, 16);
    return c.toDataURL("image/jpeg", 0.72);
  });
  expect(url).toMatch(/^data:image\/jpeg/);
  expect(captureCanvasDataUrl).toEqual(expect.any(Function));
});
